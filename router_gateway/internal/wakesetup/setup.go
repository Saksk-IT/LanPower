// Package wakesetup obtains WOL information directly from a linked PC on the
// same LAN. Cloud carries only a short-lived, read-only profile credential.
package wakesetup

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
)

type Ticket struct {
	LANIP     string `json:"lan_ip"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
}

type Target struct {
	DeviceID string  `json:"device_id"`
	Profile  *Ticket `json:"profile"`
}

type Result struct {
	DeviceID string `json:"device_id"`
	State    string `json:"state"`
}

type savedTargets struct {
	CloudURL  string          `json:"cloud_url"`
	GatewayID string          `json:"gateway_id"`
	Devices   []config.Target `json:"devices"`
}

type Manager struct {
	config    config.Config
	path      string
	gatewayID string
	mu        sync.RWMutex
	devices   []config.Target
	dirty     bool
	Fetch     func(context.Context, Target) (config.Target, error)
	Save      func([]config.Target) error
}

var errUnreachable = errors.New("PC is not reachable on the same LAN")
var errProfile = errors.New("invalid local wake profile")
var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var ticketToken = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func New(cfg config.Config, gatewayID, path string) (*Manager, error) {
	m := &Manager{config: cfg, gatewayID: gatewayID, path: path, Fetch: Fetch}
	m.Save = m.save
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return m, nil
	}
	if err != nil || info.Size() > 32768 || info.Mode().Perm()&0077 != 0 {
		return m, errors.New("automatic wake configuration is unreadable or unprotected")
	}
	data, err := os.Open(path)
	if err != nil {
		return m, errors.New("cannot read automatic wake configuration")
	}
	defer data.Close()
	var saved savedTargets
	decoder := json.NewDecoder(io.LimitReader(data, 32769))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&saved) != nil || decoder.Decode(new(any)) != io.EOF {
		return m, errors.New("automatic wake configuration is corrupt")
	}
	// A new enrollment must never inherit another account's local targets.
	if saved.CloudURL != cfg.CloudURL || saved.GatewayID != gatewayID {
		return m, nil
	}
	check := cfg
	check.Devices = saved.Devices
	if check.Validate() != nil {
		return m, errors.New("invalid automatic wake configuration")
	}
	for _, target := range saved.Devices {
		if target.LANToken != "" || target.BackupRelay {
			return m, errors.New("automatic setup cannot enable power relay")
		}
	}
	m.devices = saved.Devices
	return m, nil
}

func (m *Manager) Targets() []config.Target {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := append([]config.Target{}, m.config.Devices...)
	seen := map[string]bool{}
	for _, target := range result {
		seen[target.DeviceID] = true
	}
	for _, target := range m.devices {
		if !seen[target.DeviceID] && len(result) < 32 {
			result = append(result, target)
		}
	}
	return result
}

// Sync preserves offline PCs and manual entries, removes unlinked automatic
// entries, and exposes new information only after an atomic, durable save.
func (m *Manager) Sync(ctx context.Context, requested []Target) []Result {
	if len(requested) > 32 {
		return nil
	}
	m.mu.RLock()
	previous := append([]config.Target{}, m.devices...)
	m.mu.RUnlock()
	manual, old, next := map[string]bool{}, map[string]config.Target{}, map[string]config.Target{}
	for _, target := range m.config.Devices {
		manual[target.DeviceID] = true
	}
	for _, target := range previous {
		old[target.DeviceID] = target
	}
	results := make([]Result, len(requested))
	seen := map[string]bool{}
	// Validate the complete association list before using it to prune targets.
	for _, target := range requested {
		if !uuid.MatchString(target.DeviceID) || seen[target.DeviceID] {
			return nil
		}
		seen[target.DeviceID] = true
	}
	type fetched struct {
		profile config.Target
		err     error
	}
	profiles := make([]fetched, len(requested))
	var workers sync.WaitGroup
	limit := make(chan struct{}, 8)
	for index, target := range requested {
		if manual[target.DeviceID] || target.Profile == nil {
			continue
		}
		workers.Add(1)
		go func(index int, target Target) {
			defer workers.Done()
			select {
			case limit <- struct{}{}:
			case <-ctx.Done():
				profiles[index].err = ctx.Err()
				return
			}
			defer func() { <-limit }()
			profiles[index].profile, profiles[index].err = m.Fetch(ctx, target)
		}(index, target)
	}
	workers.Wait()
	for index, target := range requested {
		results[index] = Result{DeviceID: target.DeviceID, State: "ready"}
		if manual[target.DeviceID] {
			continue
		}
		if len(manual)+len(next) >= 32 {
			results[index].State = "capacity"
			continue
		}
		if saved, ok := old[target.DeviceID]; ok {
			next[target.DeviceID] = saved
		}
		if target.Profile == nil {
			if _, ok := next[target.DeviceID]; !ok {
				results[index].State = "unreachable"
			}
			continue
		}
		profile, err := profiles[index].profile, profiles[index].err
		if err != nil {
			results[index].State = "unreachable"
			if errors.Is(err, errProfile) {
				results[index].State = "invalid_profile"
			}
			continue
		}
		next[target.DeviceID] = profile
	}
	devices := make([]config.Target, 0, len(next))
	for _, target := range next {
		devices = append(devices, target)
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].DeviceID < devices[j].DeviceID })
	if m.dirty || !reflect.DeepEqual(previous, devices) {
		if err := m.Save(devices); err != nil {
			m.dirty = true
			for i := range results {
				if !manual[results[i].DeviceID] {
					results[i].State = "save_failed"
				}
			}
			// Even if persistence fails, an explicitly unlinked automatic target
			// must stop being accepted in this process.
			retained := []config.Target{}
			for _, target := range previous {
				if seen[target.DeviceID] {
					retained = append(retained, target)
				}
			}
			m.mu.Lock()
			m.devices = retained
			m.mu.Unlock()
			return results
		}
		m.mu.Lock()
		m.devices = devices
		m.mu.Unlock()
		m.dirty = false
	}
	return results
}

func (m *Manager) save(devices []config.Target) error {
	data, err := json.Marshal(savedTargets{CloudURL: m.config.CloudURL, GatewayID: m.gatewayID, Devices: devices})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(m.path), ".wake-targets-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err = tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), m.path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(m.path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func localSubnet(ip net.IP) *net.IPNet {
	if ip == nil || ip.To4() == nil || !ip.IsPrivate() {
		return nil
	}
	interfaces, _ := net.Interfaces()
	for _, nic := range interfaces {
		if nic.Flags&net.FlagUp == 0 || nic.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addresses, _ := nic.Addrs()
		for _, address := range addresses {
			network, ok := address.(*net.IPNet)
			if !ok || network.IP.To4() == nil || !network.IP.IsPrivate() || network.IP.Equal(ip) {
				continue
			}
			ones, bits := network.Mask.Size()
			if bits == 32 && ones >= 8 && ones <= 30 && network.Contains(ip) {
				return network
			}
		}
	}
	return nil
}

func Fetch(ctx context.Context, target Target) (config.Target, error) {
	profile := target.Profile
	if profile == nil || !uuid.MatchString(target.DeviceID) || !ticketToken.MatchString(profile.Token) ||
		profile.ExpiresAt <= time.Now().Unix() || profile.ExpiresAt > time.Now().Unix()+180 || profile.Port < 1 || profile.Port > 65535 {
		return config.Target{}, errProfile
	}
	network := localSubnet(net.ParseIP(profile.LANIP))
	if network == nil {
		return config.Target{}, errUnreachable
	}
	deadline, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(deadline, "GET", "http://"+net.JoinHostPort(profile.LANIP, strconv.Itoa(profile.Port))+"/api/wake-profile", nil)
	if err != nil {
		return config.Target{}, errProfile
	}
	request.Header.Set("Authorization", "Bearer "+profile.Token)
	response, err := client.Do(request)
	if err != nil {
		return config.Target{}, errUnreachable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return config.Target{}, errUnreachable
	}
	var result config.Target
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF ||
		validateProfile(target, result, network) != nil {
		return config.Target{}, errProfile
	}
	return result, nil
}

func validateProfile(target Target, result config.Target, network *net.IPNet) error {
	mac, err := net.ParseMAC(result.MAC)
	if err != nil || len(mac) != 6 || mac[0]&1 != 0 || result.MAC == "00:00:00:00:00:00" {
		return errProfile
	}
	if result.DeviceID != target.DeviceID || result.PCIP != target.Profile.LANIP || result.Port != target.Profile.Port ||
		result.LANToken != "" || result.BackupRelay {
		return errProfile
	}
	address := net.ParseIP(result.Broadcast)
	if address == nil || address.To4() == nil || !network.Contains(address) {
		return errProfile
	}
	// Permit only this interface's directed broadcast, never a Cloud-selected
	// unicast destination or a broadcast on another local interface.
	ip := network.IP.To4()
	broadcast := net.IPv4(ip[0]|^network.Mask[0], ip[1]|^network.Mask[1], ip[2]|^network.Mask[2], ip[3]|^network.Mask[3])
	if !broadcast.Equal(address) {
		return errProfile
	}
	return nil
}
