package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/cloud"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/protocol"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/windows"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/wol"
)

type rotatingLog struct{ path string }

func (l rotatingLog) Write(data []byte) (int, error) {
	if info, err := os.Stat(l.path); err == nil && info.Size()+int64(len(data)) > 128*1024 {
		_ = os.Remove(l.path + ".1")
		if err := os.Rename(l.path, l.path+".1"); err != nil {
			return 0, err
		}
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return f.Write(data)
}

func execute(c protocol.Command, cfg config.Config, pc *windows.Client) protocol.Result {
	r := protocol.Result{CommandID: c.CommandID, OK: true}
	switch c.Action {
	case "wake":
		if err := wol.Send(cfg.MAC, cfg.Broadcast); err != nil {
			r.OK = false
			r.Error = "WOL send failed"
		} else {
			r.State = "waking"
		}
	case "status":
		state, err := pc.Status()
		r.State = state
		if err != nil {
			r.OK = false
			r.Error = "Windows is unavailable"
		}
	case "sleep", "hibernate", "restart", "shutdown":
		if err := pc.Power(c.Action); err != nil {
			r.OK = false
			r.Error = "Windows power request failed"
		} else {
			r.State = "transitioning"
		}
	default:
		r.OK = false
		r.Error = "unknown action"
	}
	return r
}

func run(ctx context.Context, cfg config.Config, replay *protocol.ReplayStore) error {
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(cfgPath), "gateway.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("gateway is already running")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	pc := windows.New(cfg)
	remote := cloud.New(cfg)
	started := time.Now()
	backoff := time.Second
	for ctx.Err() == nil {
		state, _ := pc.Status()
		if err := remote.Heartbeat(ctx, state, int64(time.Since(started).Seconds())); err != nil {
			log.Printf("heartbeat failed: %v", err)
		} else {
			backoff = time.Second
		}
		command, err := remote.Poll(ctx)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			log.Printf("poll failed: %v", err)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				break
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		if command == nil {
			continue
		}
		result := protocol.Result{CommandID: command.CommandID, OK: false}
		if err := command.Validate(cfg.GatewayID, time.Now()); err != nil {
			result.Error = "invalid or expired command"
			log.Printf("command rejected: %v", err)
		} else if err := replay.Reserve(*command, time.Now()); err != nil {
			result.Error = "duplicate command or replay store unavailable"
			log.Printf("command rejected: %v", err)
		} else {
			result = execute(*command, cfg, pc)
		}
		for attempt := 0; attempt < 3; attempt++ {
			if err := remote.Result(ctx, result); err == nil {
				break
			} else {
				log.Printf("result delivery failed: %v", err)
			}
			select {
			case <-time.After(time.Duration(attempt+1) * time.Second):
			case <-ctx.Done():
			}
		}
	}
	return nil
}

var cfgPath string

func main() {
	flag.StringVar(&cfgPath, "config", "/data/lanpower/gateway.json", "gateway config path")
	check := flag.Bool("check-config", false, "validate configuration and exit")
	flag.Parse()
	cfg, err := config.Load(cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *check {
		fmt.Println("gateway config OK")
		return
	}
	replay, err := protocol.OpenReplayStore(filepath.Join(filepath.Dir(cfgPath), "seen.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	log.SetOutput(io.Writer(rotatingLog{path: filepath.Join(filepath.Dir(cfgPath), "gateway.log")}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Print("gateway started")
	if err := run(ctx, cfg, replay); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
