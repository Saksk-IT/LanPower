package protocol

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

type receipt struct {
	Nonce     string  `json:"nonce"`
	ExpiresAt int64   `json:"expires_at"`
	Result    *Result `json:"result,omitempty"`
}

// Commands are reserved durably before execution. Retries return the receipt,
// including after restart, and never repeat a physical power action.
type CommandStore struct {
	mu      sync.Mutex
	path    string
	entries map[string]receipt
}

func OpenCommandStore(path string) (*CommandStore, error) {
	store := &CommandStore{path: path, entries: make(map[string]receipt)}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil || len(data) > 1024*1024 || json.Unmarshal(data, &store.entries) != nil || store.entries == nil || len(store.entries) > 1024 {
		return nil, errors.New("invalid command receipts; refusing commands")
	}
	for id, entry := range store.entries {
		if !identifier.MatchString(id) || !nonce.MatchString(entry.Nonce) || entry.ExpiresAt <= 0 || (entry.Result != nil && entry.Result.CommandID != id) {
			return nil, errors.New("invalid command receipts; refusing commands")
		}
	}
	return store, nil
}

func (s *CommandStore) save() error {
	data, err := json.Marshal(s.entries)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".receipts-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		dir, err := os.Open(filepath.Dir(s.path))
		if err != nil {
			return err
		}
		defer dir.Close()
		return dir.Sync()
	}
	return nil
}

func (s *CommandStore) Begin(command Command, now time.Time) (*Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, entry := range s.entries {
		if entry.ExpiresAt < now.Unix()-60 {
			delete(s.entries, id)
		}
	}
	if entry, ok := s.entries[command.CommandID]; ok {
		if entry.Nonce != command.Nonce {
			return nil, errors.New("replayed command ID")
		}
		if entry.Result != nil {
			result := *entry.Result
			return &result, nil
		}
		return &Result{CommandID: command.CommandID, OK: false, State: "failed", Error: "command was reserved; outcome unknown"}, nil
	}
	for _, entry := range s.entries {
		if entry.Nonce == command.Nonce {
			return nil, errors.New("replayed nonce")
		}
	}
	if len(s.entries) >= 1024 {
		return nil, errors.New("command receipt store full")
	}
	s.entries[command.CommandID] = receipt{Nonce: command.Nonce, ExpiresAt: command.ExpiresAt}
	return nil, s.save()
}

func (s *CommandStore) Complete(result Result) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[result.CommandID]
	if !ok {
		return errors.New("command not reserved")
	}
	entry.Result = &result
	s.entries[result.CommandID] = entry
	return s.save()
}
