package gateway

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/cloud"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/protocol"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/wakesetup"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/windows"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/wol"
)

type Remote interface {
	DeviceID() string
	Heartbeat(context.Context, []cloud.TargetStatus, int64) error
	Poll(context.Context) (*protocol.Command, error)
	Result(context.Context, protocol.Result) error
}

type Agent struct {
	Config  config.Config
	Remote  Remote
	Store   *protocol.CommandStore
	Execute func(protocol.Command, config.Target) protocol.Result
	Status  func(config.Target) string
	Now     func() time.Time
	Setup   *wakesetup.Manager
}

func (a *Agent) targets() []config.Target {
	if a.Setup != nil {
		return a.Setup.Targets()
	}
	return a.Config.Devices
}

func New(cfg config.Config, remote Remote, store *protocol.CommandStore) *Agent {
	return &Agent{Config: cfg, Remote: remote, Store: store, Now: time.Now, Execute: execute, Status: func(target config.Target) string {
		if target.LANToken == "" {
			return "unknown"
		}
		state, _ := windows.New(target.LocalConfig()).Status()
		return state
	}}
}

func execute(command protocol.Command, target config.Target) protocol.Result {
	result := protocol.Result{CommandID: command.CommandID, OK: true}
	pc := windows.New(target.LocalConfig())
	switch command.Action {
	case "wake":
		if wol.Send(target.MAC, target.Broadcast) != nil {
			result.OK = false
			result.Error = "WOL send failed"
		} else {
			result.State = "waking"
		}
	case "status":
		state, err := pc.Status()
		if err != nil {
			result.OK = false
			result.Error = "Windows unavailable"
		} else {
			result.State = state
		}
	case "sleep", "hibernate", "restart", "shutdown":
		if pc.Power(command.Action) != nil {
			result.OK = false
			result.Error = "Windows power request not confirmed"
		} else {
			result.State = "transitioning"
		}
	default:
		result.OK = false
		result.Error = "unknown action"
	}
	if !result.OK {
		result.State = "failed"
	}
	return result
}

func (a *Agent) Handle(command protocol.Command) protocol.Result {
	rejected := protocol.Result{CommandID: command.CommandID, OK: false, State: "failed", Error: "invalid, expired or unauthorized command"}
	allowed := make(map[string]bool)
	var target config.Target
	for _, candidate := range a.targets() {
		allowed[candidate.DeviceID] = true
		if candidate.DeviceID == command.TargetDeviceID {
			target = candidate
		}
	}
	if command.ValidateV2(a.Remote.DeviceID(), allowed, a.Now()) != nil {
		return rejected
	}
	if command.Action != "wake" && (!target.BackupRelay || target.LANToken == "") {
		return rejected
	}
	cached, err := a.Store.Begin(command, a.Now())
	if err != nil {
		rejected.Error = "command replay protection unavailable"
		return rejected
	}
	if cached != nil {
		return *cached
	}
	result := a.Execute(command, target)
	if a.Store.Complete(result) != nil {
		log.Print("command receipt persistence failed; command will not be repeated")
	}
	return result
}

func (a *Agent) heartbeat(ctx context.Context, started time.Time) error {
	devices := a.targets()
	targets := make([]cloud.TargetStatus, len(devices))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 8)
	for index, target := range devices {
		wg.Add(1)
		go func(index int, target config.Target) {
			defer wg.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			targets[index] = cloud.TargetStatus{DeviceID: target.DeviceID, LANState: a.Status(target), WOLCapable: true, RelayEnabled: target.BackupRelay}
		}(index, target)
	}
	wg.Wait()
	return a.Remote.Heartbeat(ctx, targets, int64(time.Since(started).Seconds()))
}

func (a *Agent) Run(ctx context.Context) error {
	started := time.Now()
	if err := a.heartbeat(ctx, started); err != nil {
		log.Printf("gateway heartbeat failed: %v", err)
	}
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	defer func() { cancel(); wg.Wait() }()
	if remote, ok := a.Remote.(interface {
		WakeSetup(context.Context, []wakesetup.Result) ([]wakesetup.Target, error)
	}); ok && a.Setup != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var results []wakesetup.Result
			for ctx.Err() == nil {
				deadline, stop := context.WithTimeout(ctx, 15*time.Second)
				requested, err := remote.WakeSetup(deadline, results)
				if err == nil {
					results = a.Setup.Sync(deadline, requested)
					// Report only after saving; normal heartbeats remain independent.
					_, _ = remote.WakeSetup(deadline, results)
					_ = a.heartbeat(deadline, started)
				}
				stop()
				select {
				case <-ctx.Done():
					return
				case <-time.After(25 * time.Second):
				}
			}
		}()
	}
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.heartbeat(ctx, started); err != nil {
					log.Printf("gateway heartbeat failed: %v", err)
				}
			}
		}
	}()
	backoff := time.Second
	for ctx.Err() == nil {
		command, err := a.Remote.Poll(ctx)
		if err != nil {
			log.Printf("gateway connection unavailable: %v", err)
			select {
			case <-ctx.Done():
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		if command == nil {
			continue
		}
		result := a.Handle(*command)
		for attempt := 0; attempt < 3; attempt++ {
			if a.Remote.Result(ctx, result) == nil {
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Duration(attempt+1) * time.Second):
			}
		}
	}
	return nil
}
