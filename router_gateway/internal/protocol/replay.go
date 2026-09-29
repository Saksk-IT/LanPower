package protocol

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type ReplayStore struct {
	mu   sync.Mutex
	path string
	seen map[string]int64
}

func OpenReplayStore(path string) (*ReplayStore, error) {
	s := &ReplayStore{path: path, seen: make(map[string]int64)}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.seen); err != nil {
		return nil, errors.New("invalid replay store; refusing commands")
	}
	return s, nil
}

func (s *ReplayStore) Reserve(c Command, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, expiry := range s.seen {
		if expiry < now.Unix()-60 {
			delete(s.seen, key)
		}
	}
	if s.seen["id:"+c.CommandID] != 0 || s.seen["nonce:"+c.Nonce] != 0 {
		return errors.New("replayed command")
	}
	if len(s.seen) > 2048 {
		return errors.New("replay store is full")
	}
	s.seen["id:"+c.CommandID] = c.ExpiresAt
	s.seen["nonce:"+c.Nonce] = c.ExpiresAt
	data, err := json.Marshal(s.seen)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".seen-*")
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
	return os.Rename(tmp.Name(), s.path)
}
