package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
)

const testDevice = "00000000-0000-0000-0000-000000000123"

func granted() tokenResponse {
	return tokenResponse{DeviceID: testDevice, AccessToken: strings.Repeat("a", 43),
		RefreshToken: strings.Repeat("b", 43), AccessExpiresAt: time.Now().Unix() + 900}
}

func renewedFor(credentials Credentials) tokenResponse {
	response := granted()
	response.DeviceID = credentials.DeviceID
	response.RefreshToken = credentials.RefreshToken
	return response
}

func tlsClient(t *testing.T, handler http.HandlerFunc) *V2Client {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	c := NewV2(config.Config{ProtocolVersion: "2", Name: "Test Gateway", CloudURL: server.URL}, filepath.Join(t.TempDir(), "credentials.json"))
	c.http.Transport = server.Client().Transport
	return c
}

func sendJSON(w http.ResponseWriter, value any) { _ = json.NewEncoder(w).Encode(value) }

func enrollmentStart(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, map[string]any{"device_code": strings.Repeat("c", 43), "user_code": "ABCD-2345",
		"verification_uri": "https://" + r.Host + "/enroll", "expires_in": 10, "interval": 1})
}

func TestEnrollmentAndCredentialFile(t *testing.T) {
	var exchanges atomic.Int32
	c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v2/enroll/start":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["device_type"] != "gateway" || body["protocol_version"] != "2" {
				t.Error("wrong enrollment identity")
			}
			enrollmentStart(w, r)
		case "/api/v2/enroll/token":
			if exchanges.Add(1) == 1 {
				w.WriteHeader(400)
				sendJSON(w, map[string]string{"error": "authorization_pending"})
				return
			}
			sendJSON(w, granted())
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	shown := false
	if err := c.Enroll(context.Background(), func(code, uri string) {
		shown = code == "ABCD-2345" && uri == c.config.CloudURL+"/enroll"
	}); err != nil {
		t.Fatal(err)
	}
	if !shown || exchanges.Load() != 2 {
		t.Fatal("enrollment display or polling failed")
	}
	saved, err := LoadCredentials(c.path, c.config.CloudURL)
	if err != nil || saved.DeviceID != testDevice {
		t.Fatalf("saved credentials: %v", err)
	}
	if _, err := LoadCredentials(c.path, "https://other.example"); err == nil {
		t.Fatal("credential origin changed")
	}
	info, _ := os.Stat(c.path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("credentials not protected")
	}
	if err := os.Chmod(c.path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCredentials(c.path, c.config.CloudURL); err == nil {
		t.Fatal("public credentials accepted")
	}
}

func TestEnrollmentDeniedAndLocalFieldsRejected(t *testing.T) {
	for _, response := range []string{"denied", "refresh_pending", "cloud_url"} {
		t.Run(response, func(t *testing.T) {
			var count atomic.Int32
			c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v2/enroll/start" {
					enrollmentStart(w, r)
					return
				}
				count.Add(1)
				if response == "denied" {
					w.WriteHeader(400)
					sendJSON(w, map[string]string{"error": "access_denied"})
					return
				}
				data, _ := json.Marshal(granted())
				var value map[string]any
				_ = json.Unmarshal(data, &value)
				value[response] = "untrusted-local-state"
				sendJSON(w, value)
			})
			if err := c.Enroll(context.Background(), func(string, string) {}); err == nil {
				t.Fatal("unsafe enrollment accepted")
			}
			if count.Load() != 1 {
				t.Fatal("denied enrollment retried")
			}
			if _, err := os.Stat(c.path); !os.IsNotExist(err) {
				t.Fatal("unsafe credentials saved")
			}
		})
	}
}

func TestEnrollmentStorageFailureRetriesOnlyLocalWrite(t *testing.T) {
	var count atomic.Int32
	c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/enroll/start" {
			enrollmentStart(w, r)
			return
		}
		count.Add(1)
		sendJSON(w, granted())
	})
	if err := os.Mkdir(c.path, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	if err := c.Enroll(ctx, func(string, string) {}); err == nil {
		t.Fatal("unwritable credentials accepted")
	}
	if count.Load() != 1 {
		t.Fatal("one-time token redeemed again after disk failure")
	}
}

func TestConcurrentRequestsRenewOnceAndSaveBeforeUse(t *testing.T) {
	var rotations atomic.Int32
	var c *V2Client
	c = tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/devices/renew" {
			rotations.Add(1)
			var marker Credentials
			data, _ := os.ReadFile(c.path)
			_ = json.Unmarshal(data, &marker)
			if marker.RefreshPending || marker.RefreshToken != strings.Repeat("d", 43) {
				t.Error("retryable renewal changed persisted authorization before response")
			}
			sendJSON(w, renewedFor(Credentials{DeviceID: testDevice, RefreshToken: strings.Repeat("d", 43)}))
			return
		}
		saved, err := LoadCredentials(c.path, c.config.CloudURL)
		if err != nil || r.Header.Get("Authorization") != "Bearer "+saved.AccessToken {
			t.Error("token used before saving")
		}
		sendJSON(w, map[string]bool{"ok": true})
	})
	c.credentials = granted().credentials(c.config.CloudURL)
	c.credentials.RefreshToken = strings.Repeat("d", 43)
	c.credentials.AccessExpiresAt = 1
	if err := SaveCredentials(c.path, c.credentials); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.Heartbeat(context.Background(), []TargetStatus{}, 1); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if rotations.Load() != 1 {
		t.Fatal("concurrent refresh reuse")
	}
}

func TestRefreshResponseLossRecoversAfterRestartWithoutRotation(t *testing.T) {
	var rotations atomic.Int32
	c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/devices/renew" {
			if rotations.Add(1) == 1 {
				// Cloud accepted the renewal, but the connection closes before
				// the client receives any of its new credentials.
				connection, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				_ = connection.Close()
				return
			}
			sendJSON(w, renewedFor(Credentials{DeviceID: testDevice, RefreshToken: strings.Repeat("d", 43)}))
			return
		}
		sendJSON(w, map[string]bool{"ok": true})
	})
	c.credentials = granted().credentials(c.config.CloudURL)
	c.credentials.RefreshToken = strings.Repeat("d", 43)
	c.credentials.AccessExpiresAt = 1
	if err := SaveCredentials(c.path, c.credentials); err != nil {
		t.Fatal(err)
	}
	if err := c.Heartbeat(context.Background(), nil, 1); err == nil || strings.Contains(err.Error(), "enroll") {
		t.Fatal("unsafe refresh failure")
	}
	persisted, err := LoadCredentials(c.path, c.config.CloudURL)
	if err != nil || persisted != c.credentials || persisted.RefreshPending {
		t.Fatalf("retryable renewal changed persisted authorization: %v", err)
	}
	restarted := NewV2(c.config, c.path)
	restarted.http = c.http
	if err := restarted.Load(); err != nil {
		t.Fatalf("restart rejected recoverable credentials: %v", err)
	}
	if err := restarted.Heartbeat(context.Background(), nil, 1); err != nil {
		t.Fatal(err)
	}
	if rotations.Load() != 2 {
		t.Fatal("renewal was not retried after response loss")
	}
	persisted, err = LoadCredentials(c.path, c.config.CloudURL)
	if err != nil || persisted.RefreshPending {
		t.Fatalf("refresh marker not cleared after recovery: %v", err)
	}
}

func TestRefreshDiskFailureRecoversWithoutExchangingAgain(t *testing.T) {
	var rotations atomic.Int32
	var c *V2Client
	c = tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/devices/renew" {
			rotations.Add(1)
			if err := os.Remove(c.path); err != nil {
				t.Error(err)
			}
			if err := os.Mkdir(c.path, 0700); err != nil {
				t.Error(err)
			}
			sendJSON(w, renewedFor(Credentials{DeviceID: testDevice, RefreshToken: strings.Repeat("d", 43)}))
			return
		}
		sendJSON(w, map[string]bool{"ok": true})
	})
	c.credentials = granted().credentials(c.config.CloudURL)
	c.credentials.RefreshToken = strings.Repeat("d", 43)
	c.credentials.AccessExpiresAt = 1
	if err := SaveCredentials(c.path, c.credentials); err != nil {
		t.Fatal(err)
	}
	if err := c.Heartbeat(context.Background(), nil, 1); err == nil {
		t.Fatal("disk failure ignored")
	}
	if err := os.Remove(c.path); err != nil {
		t.Fatal(err)
	}
	if err := c.Heartbeat(context.Background(), nil, 1); err != nil {
		t.Fatal(err)
	}
	if rotations.Load() != 1 {
		t.Fatal("already-rotated token exchanged again")
	}
	if _, err := LoadCredentials(c.path, c.config.CloudURL); err != nil {
		t.Fatal(err)
	}
}

func TestExistingRefreshMarkerRecoversThroughRetryableEndpoint(t *testing.T) {
	var renewals atomic.Int32
	c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/devices/renew" {
			renewals.Add(1)
			sendJSON(w, granted())
			return
		}
		sendJSON(w, map[string]bool{"ok": true})
	})
	credentials := granted().credentials(c.config.CloudURL)
	credentials.RefreshPending = true
	if err := SaveCredentials(c.path, credentials); err != nil {
		t.Fatal(err)
	}
	if err := c.Load(); err != nil {
		t.Fatal(err)
	}
	if err := c.Heartbeat(context.Background(), nil, 1); err != nil {
		t.Fatal(err)
	}
	saved, err := LoadCredentials(c.path, c.config.CloudURL)
	if err != nil || saved.RefreshPending || renewals.Load() != 1 {
		t.Fatal("existing interrupted renewal was not recovered")
	}
}

func TestLegacyCloudCompatibilityAndAutomaticUpgrade(t *testing.T) {
	for _, absent := range []int{404, 405} {
		t.Run(fmt.Sprint(absent), func(t *testing.T) {
			var legacyCalls atomic.Int32
			var upgraded atomic.Bool
			var c *V2Client
			c = tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v2/devices/renew":
					if !upgraded.Load() {
						w.WriteHeader(absent)
						return
					}
					sendJSON(w, granted())
				case "/api/v2/devices/token":
					legacyCalls.Add(1)
					saved, err := LoadCredentials(c.path, c.config.CloudURL)
					if err != nil || !saved.RefreshPending {
						t.Error("legacy exchange not reserved before sending")
					}
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["refresh_token"] != strings.Repeat("d", 43) {
						t.Error("legacy exchange used the wrong authorization")
					}
					sendJSON(w, granted())
				default:
					saved, err := LoadCredentials(c.path, c.config.CloudURL)
					if err != nil || saved.RefreshPending || r.Header.Get("Authorization") != "Bearer "+saved.AccessToken {
						t.Error("access used before credentials were saved")
					}
					sendJSON(w, map[string]bool{"ok": true})
				}
			})
			c.credentials = granted().credentials(c.config.CloudURL)
			c.credentials.RefreshToken = strings.Repeat("d", 43)
			c.credentials.AccessExpiresAt = 1
			if err := SaveCredentials(c.path, c.credentials); err != nil {
				t.Fatal(err)
			}
			if err := c.Heartbeat(context.Background(), nil, 1); err != nil {
				t.Fatal(err)
			}
			if legacyCalls.Load() != 1 || c.credentials.RefreshPending || c.credentials.RefreshToken != granted().RefreshToken {
				t.Fatal("legacy compatibility did not preserve the rotated credentials")
			}
			upgraded.Store(true)
			c.credentials.AccessExpiresAt = 1
			if err := SaveCredentials(c.path, c.credentials); err != nil {
				t.Fatal(err)
			}
			if err := c.Heartbeat(context.Background(), nil, 1); err != nil {
				t.Fatal(err)
			}
			if legacyCalls.Load() != 1 || c.credentials.RefreshToken != granted().RefreshToken {
				t.Fatal("upgraded Cloud did not switch to retryable renewal")
			}
		})
	}
}

func TestRenewalFailuresNeverFallBackToRotatingTokens(t *testing.T) {
	for _, status := range []int{200, 307, 400, 401, 403, 429, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var legacyCalls atomic.Int32
			c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v2/devices/renew" {
					legacyCalls.Add(1)
				}
				w.WriteHeader(status)
				_, _ = io.WriteString(w, "invalid-response-secret-material")
			})
			c.credentials = granted().credentials(c.config.CloudURL)
			c.credentials.AccessExpiresAt = 1
			if err := SaveCredentials(c.path, c.credentials); err != nil {
				t.Fatal(err)
			}
			if err := c.Heartbeat(context.Background(), nil, 1); err == nil || strings.Contains(err.Error(), "secret-material") {
				t.Fatal("unsafe renewal failure")
			}
			saved, err := LoadCredentials(c.path, c.config.CloudURL)
			if err != nil || saved != c.credentials || legacyCalls.Load() != 0 {
				t.Fatal("renewal failure consumed or changed the authorization")
			}
		})
	}
}

func TestLegacyResponseLossDoesNotReplayAfterRestart(t *testing.T) {
	var legacyCalls atomic.Int32
	c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/devices/renew" {
			w.WriteHeader(405)
			return
		}
		legacyCalls.Add(1)
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = connection.Close()
	})
	c.credentials = granted().credentials(c.config.CloudURL)
	c.credentials.AccessExpiresAt = 1
	if err := SaveCredentials(c.path, c.credentials); err != nil {
		t.Fatal(err)
	}
	if err := c.Heartbeat(context.Background(), nil, 1); err == nil {
		t.Fatal("lost legacy response was accepted")
	}
	restarted := NewV2(c.config, c.path)
	restarted.http = c.http
	if err := restarted.Load(); err != nil {
		t.Fatal(err)
	}
	for _, client := range []*V2Client{c, restarted} {
		if err := client.Heartbeat(context.Background(), nil, 1); err == nil {
			t.Fatal("interrupted legacy exchange retried")
		}
	}
	if legacyCalls.Load() != 1 {
		t.Fatal("legacy token replay could revoke the gateway")
	}
}

func TestLegacyDiskFailureRetriesLocalWriteWithoutRotation(t *testing.T) {
	var legacyCalls atomic.Int32
	var c *V2Client
	c = tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/devices/renew" {
			w.WriteHeader(404)
			return
		}
		if r.URL.Path == "/api/v2/devices/token" {
			legacyCalls.Add(1)
			if err := os.Remove(c.path); err != nil {
				t.Error(err)
			}
			if err := os.Mkdir(c.path, 0700); err != nil {
				t.Error(err)
			}
			sendJSON(w, granted())
			return
		}
		sendJSON(w, map[string]bool{"ok": true})
	})
	c.credentials = granted().credentials(c.config.CloudURL)
	c.credentials.RefreshToken = strings.Repeat("d", 43)
	c.credentials.AccessExpiresAt = 1
	if err := SaveCredentials(c.path, c.credentials); err != nil {
		t.Fatal(err)
	}
	if err := c.Heartbeat(context.Background(), nil, 1); err == nil {
		t.Fatal("disk failure ignored")
	}
	if err := os.Remove(c.path); err != nil {
		t.Fatal(err)
	}
	if err := c.Heartbeat(context.Background(), nil, 1); err != nil {
		t.Fatal(err)
	}
	saved, err := LoadCredentials(c.path, c.config.CloudURL)
	if err != nil || saved.RefreshPending || saved.RefreshToken != granted().RefreshToken || legacyCalls.Load() != 1 {
		t.Fatal("legacy disk recovery replayed the rotation or lost the credentials")
	}
}

func TestCloudRedirectNeverReceivesCredentials(t *testing.T) {
	var hits atomic.Int32
	destination := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer destination.Close()
	c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) })
	c.credentials = granted().credentials(c.config.CloudURL)
	if err := c.Heartbeat(context.Background(), nil, 1); err == nil {
		t.Fatal("redirect accepted")
	}
	if hits.Load() != 0 {
		t.Fatal("credential-bearing redirect followed")
	}
}

func TestHeartbeatContainsOnlyPublicTargetFields(t *testing.T) {
	c := tlsClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]json.RawMessage
		_ = json.Unmarshal(body, &payload)
		if len(payload) != 4 {
			t.Errorf("unexpected heartbeat fields: %d", len(payload))
		}
		var targets []map[string]any
		_ = json.Unmarshal(payload["targets"], &targets)
		if len(targets) != 1 || len(targets[0]) != 4 {
			t.Error("unexpected target fields")
		}
		if strings.Contains(string(body), "lan_token") || strings.Contains(string(body), "refresh_token") {
			t.Error("secret uploaded")
		}
		fmt.Fprint(w, `{"ok":true}`)
	})
	c.credentials = granted().credentials(c.config.CloudURL)
	if err := c.Heartbeat(context.Background(), []TargetStatus{{DeviceID: testDevice, LANState: "online", WOLCapable: true}}, 1); err != nil {
		t.Fatal(err)
	}
}
