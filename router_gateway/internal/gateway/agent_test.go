package gateway

import (
	"context"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/cloud"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/protocol"
)

const gatewayID = "00000000-0000-0000-0000-000000000001"
const pcA = "00000000-0000-0000-0000-000000000002"
const pcB = "00000000-0000-0000-0000-000000000003"

type fakeRemote struct {
	targets []cloud.TargetStatus
	queue   []protocol.Command
	results []protocol.Result
	cancel  context.CancelFunc
}

func (f *fakeRemote) DeviceID() string { return gatewayID }
func (f *fakeRemote) Heartbeat(_ context.Context, targets []cloud.TargetStatus, _ int64) error {
	f.targets = targets
	return nil
}
func (f *fakeRemote) Poll(ctx context.Context) (*protocol.Command, error) {
	if len(f.queue) == 0 {
		f.cancel()
		return nil, ctx.Err()
	}
	command := f.queue[0]
	f.queue = f.queue[1:]
	return &command, nil
}
func (f *fakeRemote) Result(_ context.Context, result protocol.Result) error {
	f.results = append(f.results, result)
	return nil
}

func command(target, action string) protocol.Command {
	now := time.Now().Unix()
	return protocol.Command{CommandID: "00000000-0000-0000-0000-000000000004", GatewayID: gatewayID, TargetDeviceID: target,
		Action: action, Nonce: strings.Repeat("a", 32), IssuedAt: now, ExpiresAt: now + 45}
}

func newAgent(t *testing.T) (*Agent, *fakeRemote) {
	t.Helper()
	store, err := protocol.OpenCommandStore(filepath.Join(t.TempDir(), "receipts.json"))
	if err != nil {
		t.Fatal(err)
	}
	remote := &fakeRemote{}
	agent := New(config.Config{Devices: []config.Target{
		{DeviceID: pcA, MAC: "02:00:00:00:00:01", Broadcast: "192.168.1.255"},
		{DeviceID: pcB, MAC: "02:00:00:00:00:02", Broadcast: "192.168.1.255", PCIP: "192.168.1.7", Port: 48211,
			BackupRelay: true, LANToken: strings.Repeat("b", 64)},
	}}, remote, store)
	agent.Status = func(target config.Target) string {
		if target.BackupRelay {
			return "online"
		}
		return "unknown"
	}
	return agent, remote
}

func TestTargetRoutingAndReplayNeverExecuteTwice(t *testing.T) {
	for _, action := range []string{"wake", "status", "sleep", "hibernate", "restart", "shutdown"} {
		t.Run(action, func(t *testing.T) {
			agent, _ := newAgent(t)
			var executions atomic.Int32
			agent.Execute = func(c protocol.Command, target config.Target) protocol.Result {
				executions.Add(1)
				if target.DeviceID != pcB || target.MAC != "02:00:00:00:00:02" {
					t.Error("wrong Windows selected")
				}
				return protocol.Result{CommandID: c.CommandID, OK: true, State: "transitioning"}
			}
			c := command(pcB, action)
			first := agent.Handle(c)
			second := agent.Handle(c)
			if !first.OK || second != first || executions.Load() != 1 {
				t.Fatal("duplicate execution or missing receipt")
			}
		})
	}
}

func TestInvalidOrUnauthorizedCommandNeverReachesLAN(t *testing.T) {
	for name, change := range map[string]func(*protocol.Command){
		"unknown target":    func(c *protocol.Command) { c.TargetDeviceID = "00000000-0000-0000-0000-000000000099" },
		"different gateway": func(c *protocol.Command) { c.GatewayID = pcA },
		"relay disabled":    func(c *protocol.Command) { c.TargetDeviceID = pcA },
		"shell action":      func(c *protocol.Command) { c.Action = "shell" },
		"bad ID":            func(c *protocol.Command) { c.CommandID = "invalid" },
		"bad nonce":         func(c *protocol.Command) { c.Nonce = "bad" },
		"expired":           func(c *protocol.Command) { c.IssuedAt -= 90; c.ExpiresAt -= 90 },
		"future":            func(c *protocol.Command) { c.IssuedAt += 90; c.ExpiresAt += 90 },
	} {
		t.Run(name, func(t *testing.T) {
			agent, _ := newAgent(t)
			agent.Execute = func(protocol.Command, config.Target) protocol.Result {
				t.Fatal("unsafe command executed")
				return protocol.Result{}
			}
			c := command(pcB, "shutdown")
			change(&c)
			if agent.Handle(c).OK {
				t.Fatal("unsafe command accepted")
			}
		})
	}
}

func TestRunUploadsSeparateTargetsAndDeliversCachedResult(t *testing.T) {
	agent, remote := newAgent(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	remote.cancel = cancel
	c := command(pcA, "wake")
	remote.queue = []protocol.Command{c, c}
	calls := 0
	agent.Execute = func(c protocol.Command, target config.Target) protocol.Result {
		calls++
		return protocol.Result{CommandID: c.CommandID, OK: true, State: "waking"}
	}
	if err := agent.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || len(remote.results) != 2 || remote.results[0] != remote.results[1] {
		t.Fatal("result replay failed")
	}
	if len(remote.targets) != 2 || remote.targets[0].DeviceID != pcA || remote.targets[0].RelayEnabled || remote.targets[1].LANState != "online" {
		t.Fatal("target state mixed")
	}
}
