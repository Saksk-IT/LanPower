package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/protocol"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/wakesetup"
)

type Credentials struct {
	CloudURL        string `json:"cloud_url,omitempty"`
	DeviceID        string `json:"device_id"`
	AccessToken     string `json:"access_token"`
	RefreshToken    string `json:"refresh_token"`
	AccessExpiresAt int64  `json:"access_expires_at"`
	RefreshPending  bool   `json:"refresh_pending,omitempty"`
}

// Server responses must not set local persistence state or change the origin.
type tokenResponse struct {
	DeviceID        string `json:"device_id"`
	AccessToken     string `json:"access_token"`
	RefreshToken    string `json:"refresh_token"`
	AccessExpiresAt int64  `json:"access_expires_at"`
}

func (r tokenResponse) credentials(origin string) Credentials {
	return Credentials{CloudURL: origin, DeviceID: r.DeviceID, AccessToken: r.AccessToken,
		RefreshToken: r.RefreshToken, AccessExpiresAt: r.AccessExpiresAt}
}

var opaqueToken = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
var uuidID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var shortCode = regexp.MustCompile(`^[A-Z2-9]{4}-[A-Z2-9]{4}$`)

func (c Credentials) valid() bool {
	return uuidID.MatchString(c.DeviceID) && opaqueToken.MatchString(c.AccessToken) && opaqueToken.MatchString(c.RefreshToken) && c.AccessExpiresAt > 0
}

func SaveCredentials(path string, credentials Credentials) error {
	data, err := json.Marshal(credentials)
	if err != nil {
		return errors.New("cannot encode credentials")
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".credential-*")
	if err != nil {
		return errors.New("cannot create credential file")
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := tmp.Chmod(0600); err != nil {
		return errors.New("cannot protect credential file")
	}
	if _, err := tmp.Write(data); err != nil {
		return errors.New("cannot write credential file")
	}
	if err := tmp.Sync(); err != nil {
		return errors.New("cannot sync credential file")
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return errors.New("cannot replace credential file")
	}
	if runtime.GOOS != "windows" {
		dir, err := os.Open(filepath.Dir(path))
		if err != nil {
			return err
		}
		defer dir.Close()
		if err := dir.Sync(); err != nil {
			return errors.New("cannot sync credential directory")
		}
	}
	return nil
}

func LoadCredentials(path, origin string) (Credentials, error) {
	var credentials Credentials
	info, err := os.Stat(path)
	if err != nil {
		return credentials, errors.New("gateway needs enrollment")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return credentials, errors.New("credential file must have mode 600")
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 4096 || json.Unmarshal(data, &credentials) != nil || !credentials.valid() || credentials.CloudURL != origin || credentials.RefreshPending {
		return Credentials{}, errors.New("gateway needs enrollment; credentials are invalid or refresh was interrupted")
	}
	return credentials, nil
}

type V2Client struct {
	config      config.Config
	path        string
	http        *http.Client
	mu          sync.Mutex
	credentials Credentials
	pending     *Credentials
}

type cloudHTTPError struct {
	status int
	code   string
}

func (e *cloudHTTPError) Error() string { return fmt.Sprintf("Cloud returned HTTP %d", e.status) }

func NewV2(cfg config.Config, path string) *V2Client {
	return &V2Client{config: cfg, path: path, http: &http.Client{Timeout: 35 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *V2Client) Load() error {
	credentials, err := LoadCredentials(c.path, c.config.CloudURL)
	if err == nil {
		c.credentials = credentials
	}
	return err
}

func (c *V2Client) raw(ctx context.Context, method, path, access string, payload, output any) (int, error) {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return 0, errors.New("invalid request")
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.config.CloudURL+path, body)
	if err != nil {
		return 0, errors.New("invalid Cloud address")
	}
	if access != "" {
		req.Header.Set("Authorization", "Bearer "+access)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		return 0, errors.New("Cloud connection unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		var problem struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 512)).Decode(&problem)
		return response.StatusCode, &cloudHTTPError{status: response.StatusCode, code: problem.Error}
	}
	if output != nil {
		decoder := json.NewDecoder(io.LimitReader(response.Body, 65536))
		decoder.DisallowUnknownFields()
		if decoder.Decode(output) != nil || decoder.Decode(new(any)) != io.EOF {
			return response.StatusCode, errors.New("invalid Cloud response")
		}
	}
	return response.StatusCode, nil
}

func (c *V2Client) Enroll(ctx context.Context, show func(code, uri string)) error {
	var start struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	_, err := c.raw(ctx, "POST", "/api/v2/enroll/start", "", map[string]any{
		"device_type": "gateway", "name": c.config.Name, "version": "2.1.0", "protocol_version": "2"}, &start)
	if err != nil {
		return err
	}
	if !opaqueToken.MatchString(start.DeviceCode) || !shortCode.MatchString(start.UserCode) || start.VerificationURI != c.config.CloudURL+"/enroll" || start.ExpiresIn < 1 || start.ExpiresIn > 900 || start.Interval < 1 || start.Interval > 30 {
		return errors.New("invalid enrollment response")
	}
	show(start.UserCode, start.VerificationURI)
	enrollmentCtx, cancel := context.WithTimeout(ctx, time.Duration(start.ExpiresIn)*time.Second)
	defer cancel()
	for enrollmentCtx.Err() == nil {
		select {
		case <-enrollmentCtx.Done():
			return errors.New("enrollment expired or cancelled")
		case <-time.After(time.Duration(start.Interval) * time.Second):
		}
		var response tokenResponse
		status, err := c.raw(enrollmentCtx, "POST", "/api/v2/enroll/token", "", map[string]string{"device_code": start.DeviceCode}, &response)
		if err != nil {
			var problem *cloudHTTPError
			if errors.As(err, &problem) {
				if problem.code == "authorization_pending" || problem.code == "slow_down" || status == 429 {
					continue
				}
				if problem.code == "access_denied" || problem.code == "expired_token" || problem.code == "invalid_grant" {
					return errors.New("enrollment denied or expired")
				}
			}
			return err
		}
		credentials := response.credentials(c.config.CloudURL)
		if !credentials.valid() || credentials.AccessExpiresAt <= time.Now().Unix() {
			return errors.New("invalid enrollment credentials")
		}
		if err := SaveCredentials(c.path, credentials); err != nil {
			log.Print("cannot save enrollment; retrying local storage, keep this process running")
			for err != nil {
				select {
				case <-ctx.Done():
					return errors.New("enrollment credentials not saved; enroll again after fixing local storage")
				case <-time.After(time.Second):
					err = SaveCredentials(c.path, credentials)
				}
			}
		}
		c.credentials = credentials
		return nil
	}
	return errors.New("enrollment expired or denied; start enrollment again")
}

func (c *V2Client) access(ctx context.Context, rejected string) (Credentials, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pending != nil {
		if err := SaveCredentials(c.path, *c.pending); err != nil {
			return Credentials{}, err
		}
		c.credentials = *c.pending
		c.pending = nil
	}
	if c.credentials.RefreshPending {
		return Credentials{}, errors.New("refresh interrupted; enroll the gateway again")
	}
	if c.credentials.AccessExpiresAt > time.Now().Unix()+30 && c.credentials.AccessToken != rejected {
		return c.credentials, nil
	}
	marker := c.credentials
	marker.RefreshPending = true
	if err := SaveCredentials(c.path, marker); err != nil {
		return Credentials{}, err
	}
	c.credentials = marker
	var response tokenResponse
	_, err := c.raw(ctx, "POST", "/api/v2/devices/token", "", map[string]string{
		"device_id": c.credentials.DeviceID, "refresh_token": c.credentials.RefreshToken}, &response)
	if err != nil {
		return Credentials{}, errors.New("credential refresh failed; enroll the gateway again")
	}
	rotated := response.credentials(c.config.CloudURL)
	if !rotated.valid() || rotated.DeviceID != c.credentials.DeviceID || rotated.AccessExpiresAt <= time.Now().Unix() || rotated.RefreshToken == c.credentials.RefreshToken {
		return Credentials{}, errors.New("invalid refreshed credentials")
	}
	c.pending = &rotated
	if err := SaveCredentials(c.path, rotated); err != nil {
		return Credentials{}, err
	}
	c.credentials = rotated
	c.pending = nil
	return rotated, nil
}

func (c *V2Client) request(ctx context.Context, method, path string, payload, output any) error {
	credentials, err := c.access(ctx, "")
	if err != nil {
		return err
	}
	status, err := c.raw(ctx, method, path, credentials.AccessToken, payload, output)
	if status == 401 {
		credentials, err = c.access(ctx, credentials.AccessToken)
		if err != nil {
			return err
		}
		_, err = c.raw(ctx, method, path, credentials.AccessToken, payload, output)
	}
	return err
}

type TargetStatus struct {
	DeviceID     string `json:"device_id"`
	LANState     string `json:"lan_state"`
	WOLCapable   bool   `json:"wol_capable"`
	RelayEnabled bool   `json:"relay_enabled"`
}

func (c *V2Client) DeviceID() string { c.mu.Lock(); defer c.mu.Unlock(); return c.credentials.DeviceID }
func (c *V2Client) Heartbeat(ctx context.Context, targets []TargetStatus, uptime int64) error {
	return c.request(ctx, "POST", "/api/v2/gateway/heartbeat", map[string]any{
		"device_id": c.DeviceID(), "version": "2.1.0", "uptime": uptime, "targets": targets}, nil)
}
func (c *V2Client) Poll(ctx context.Context) (*protocol.Command, error) {
	var response struct {
		Command *protocol.Command `json:"command"`
	}
	err := c.request(ctx, "GET", "/api/v2/gateway/commands", nil, &response)
	return response.Command, err
}
func (c *V2Client) Result(ctx context.Context, result protocol.Result) error {
	return c.request(ctx, "POST", "/api/v2/gateway/results", map[string]any{
		"command_id": result.CommandID, "ok": result.OK, "state": result.State, "error": result.Error}, nil)
}

func (c *V2Client) WakeSetup(ctx context.Context, results []wakesetup.Result) ([]wakesetup.Target, error) {
	if results == nil {
		results = []wakesetup.Result{}
	}
	var response struct {
		Targets []wakesetup.Target `json:"targets"`
	}
	err := c.request(ctx, "POST", "/api/v2/gateway/wake-setup", map[string]any{"results": results}, &response)
	if err == nil && response.Targets == nil {
		err = errors.New("missing wake setup targets")
	}
	return response.Targets, err
}
