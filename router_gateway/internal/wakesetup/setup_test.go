package wakesetup

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
)

const pc = "00000000-0000-0000-0000-000000000001"
const manualPC = "00000000-0000-0000-0000-000000000002"

func fixture(t *testing.T) (*Manager, Target, config.Target) {
	t.Helper()
	cfg := config.Config{ProtocolVersion: "2", Name: "Test", CloudURL: "https://power.example.test"}
	m, err := New(cfg, "gateway", filepath.Join(t.TempDir(), "auto-targets.json"))
	if err != nil {
		t.Fatal(err)
	}
	request := Target{DeviceID: pc, Profile: &Ticket{LANIP: "192.168.1.20", Port: 48211, ExpiresAt: time.Now().Unix() + 90}}
	profile := config.Target{DeviceID: pc, MAC: "02:11:22:33:44:55", Broadcast: "192.168.1.255", PCIP: "192.168.1.20", Port: 48211}
	m.Fetch = func(context.Context, Target) (config.Target, error) { return profile, nil }
	return m, request, profile
}

func TestSetupPersistsAcrossRestartAndOfflineThenRemovesUnlinked(t *testing.T) {
	m, request, _ := fixture(t)
	result := m.Sync(context.Background(), []Target{request})
	if len(result) != 1 || result[0].State != "ready" || len(m.Targets()) != 1 {
		t.Fatal(result)
	}
	info, _ := os.Stat(m.path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("unprotected file")
	}
	restored, err := New(m.config, "gateway", m.path)
	if err != nil || len(restored.Targets()) != 1 {
		t.Fatal(err)
	}
	request.Profile = nil
	if restored.Sync(context.Background(), []Target{request})[0].State != "ready" {
		t.Fatal("offline target lost")
	}
	otherAccount, err := New(m.config, "another-enrollment", m.path)
	if err != nil || len(otherAccount.Targets()) != 0 {
		t.Fatal("reenrollment reused old targets")
	}
	restored.Sync(context.Background(), []Target{})
	if len(restored.Targets()) != 0 {
		t.Fatal("unlinked target retained")
	}
}

func TestFailureDoesNotExposeUnsavedTargetAndRetriesWithoutOverwritingManual(t *testing.T) {
	m, request, profile := fixture(t)
	manual := profile
	manual.DeviceID = manualPC
	m.config.Devices = []config.Target{manual}
	save := m.Save
	m.Save = func([]config.Target) error { return errors.New("disk full") }
	result := m.Sync(context.Background(), []Target{request})
	if result[0].State != "save_failed" || len(m.Targets()) != 1 {
		t.Fatal("reported unsaved target ready")
	}
	m.Save = save
	m.Sync(context.Background(), []Target{request})
	if len(m.Targets()) != 2 {
		t.Fatal("retry did not persist")
	}
	m.Fetch = func(context.Context, Target) (config.Target, error) { return config.Target{}, errUnreachable }
	if m.Sync(context.Background(), []Target{request})[0].State != "unreachable" || len(m.Targets()) != 2 {
		t.Fatal("lost cached profile")
	}
	m.Save = func([]config.Target) error { return errors.New("disk full") }
	m.Sync(context.Background(), []Target{})
	if len(m.Targets()) != 1 || m.Targets()[0].DeviceID != manualPC {
		t.Fatal("unlink or manual preservation failed")
	}
	m.Save = save
	m.Sync(context.Background(), []Target{})
	restored, err := New(m.config, "gateway", m.path)
	if err != nil || len(restored.Targets()) != 1 || restored.Targets()[0].DeviceID != manualPC {
		t.Fatal("failed unlink was not persisted on retry", err)
	}
}

func TestIncompleteAssociationResponseDoesNotPruneAndSameProfileDoesNotRewrite(t *testing.T) {
	m, request, _ := fixture(t)
	m.Sync(context.Background(), []Target{request})
	writes := 0
	m.Save = func([]config.Target) error { writes++; return nil }
	m.Sync(context.Background(), []Target{request})
	m.Sync(context.Background(), []Target{request, request})
	if writes != 0 || len(m.Targets()) != 1 {
		t.Fatal("invalid association pruned or rewrote configuration")
	}
}

func TestLocalProfileRejectsWrongDeviceRelayAndNonBroadcastDestination(t *testing.T) {
	_, request, profile := fixture(t)
	network := &net.IPNet{IP: net.ParseIP("192.168.1.1"), Mask: net.CIDRMask(24, 32)}
	if validateProfile(request, profile, network) != nil {
		t.Fatal("valid profile rejected")
	}
	invalid := []config.Target{profile, profile, profile, profile, profile, profile}
	invalid[0].DeviceID = manualPC
	invalid[1].LANToken = "unwanted"
	invalid[2].BackupRelay = true
	invalid[3].Broadcast = "192.168.1.10"
	invalid[4].Broadcast = "192.168.2.255"
	invalid[5].MAC = "ff:ff:ff:ff:ff:ff"
	for _, item := range invalid {
		if validateProfile(request, item, network) == nil {
			t.Fatal("unsafe profile accepted")
		}
	}
	for _, address := range []string{"127.0.0.1", "8.8.8.8", "169.254.169.254", "::1"} {
		if localSubnet(net.ParseIP(address)) != nil {
			t.Fatal("non-LAN destination accepted")
		}
	}
}
