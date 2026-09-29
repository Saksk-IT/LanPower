package protocol

import (
	"path/filepath"
	"testing"
	"time"
)

func TestReplaySurvivesRestart(t *testing.T) {
	now := time.Now()
	command := Command{
		CommandID: "12345678-1234-4234-8234-123456789abc",
		GatewayID: "home-router", Action: "shutdown",
		IssuedAt: now.Unix(), ExpiresAt: now.Add(45 * time.Second).Unix(),
		Nonce: "0123456789abcdef0123456789abcdef",
	}
	if err := command.Validate("home-router", now); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "seen.json")
	store, err := OpenReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Reserve(command, now); err != nil {
		t.Fatal(err)
	}
	store, err = OpenReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Reserve(command, now); err == nil {
		t.Fatal("replayed command was accepted after restart")
	}
	command.CommandID = "87654321-1234-4234-8234-123456789abc"
	if err := store.Reserve(command, now); err == nil {
		t.Fatal("replayed nonce was accepted")
	}
}

func TestRejectInvalidCommands(t *testing.T) {
	now := time.Now()
	c := Command{
		CommandID: "12345678-1234-4234-8234-123456789abc", GatewayID: "home-router",
		Action: "shutdown", IssuedAt: now.Unix(), ExpiresAt: now.Add(45 * time.Second).Unix(),
		Nonce: "0123456789abcdef0123456789abcdef",
	}
	for _, mutate := range []func(*Command){
		func(c *Command) { c.GatewayID = "other" },
		func(c *Command) { c.Action = "http" },
		func(c *Command) { c.ExpiresAt = now.Add(-time.Second).Unix() },
		func(c *Command) { c.Nonce = "short" },
	} {
		bad := c
		mutate(&bad)
		if err := bad.Validate("home-router", now); err == nil {
			t.Fatalf("invalid command accepted: %+v", bad)
		}
	}
}
