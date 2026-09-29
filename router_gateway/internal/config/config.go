package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
)

var hexSecret = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
var gatewayID = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,64}$`)
var deviceID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Config struct {
	ProtocolVersion string   `json:"protocol_version,omitempty"`
	Name            string   `json:"name,omitempty"`
	Devices         []Target `json:"devices,omitempty"`
	GatewayID       string   `json:"gateway_id"`
	GatewaySecret   string   `json:"gateway_secret"`
	CloudURL        string   `json:"cloud_url"`
	PCIP            string   `json:"pc_ip"`
	Port            int      `json:"port"`
	MAC             string   `json:"mac"`
	Broadcast       string   `json:"broadcast"`
	LANToken        string   `json:"lan_token"`
}

type Target struct {
	DeviceID    string `json:"device_id"`
	PCIP        string `json:"pc_ip,omitempty"`
	Port        int    `json:"port,omitempty"`
	MAC         string `json:"mac"`
	Broadcast   string `json:"broadcast"`
	LANToken    string `json:"lan_token,omitempty"`
	BackupRelay bool   `json:"backup_relay"`
}

func (t Target) LocalConfig() Config {
	return Config{PCIP: t.PCIP, Port: t.Port, MAC: t.MAC, Broadcast: t.Broadcast, LANToken: t.LANToken}
}

func Load(path string) (Config, error) {
	var c Config
	info, err := os.Stat(path)
	if err != nil {
		return c, err
	}
	if info.Mode().Perm()&0077 != 0 {
		return c, errors.New("gateway config must be readable only by its owner (chmod 600)")
	}
	f, err := os.Open(path)
	if err != nil {
		return c, err
	}
	defer f.Close()
	decoder := json.NewDecoder(f)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return c, fmt.Errorf("invalid gateway config: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return c, errors.New("gateway config contains trailing data")
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	if c.ProtocolVersion == "2" {
		return c.validateV2()
	}
	if c.ProtocolVersion != "" && c.ProtocolVersion != "1" {
		return errors.New("unsupported protocol version")
	}
	if !gatewayID.MatchString(c.GatewayID) || !hexSecret.MatchString(c.GatewaySecret) || !hexSecret.MatchString(c.LANToken) || strings.EqualFold(c.GatewaySecret, c.LANToken) {
		return errors.New("invalid gateway ID or credentials")
	}
	u, err := url.Parse(c.CloudURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("cloud_url must be an HTTPS origin without credentials, path or query")
	}
	if ip := net.ParseIP(c.PCIP); ip == nil || ip.To4() == nil || !ip.IsPrivate() {
		return errors.New("pc_ip must be a private IPv4 address")
	}
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("invalid Windows API port")
	}
	if mac, err := net.ParseMAC(c.MAC); err != nil || len(mac) != 6 {
		return errors.New("invalid PC MAC")
	}
	if ip := net.ParseIP(c.Broadcast); ip == nil || ip.To4() == nil || !ip.IsPrivate() {
		return errors.New("broadcast must be a private IPv4 address")
	}
	return nil
}

func (c Config) validateV2() error {
	if c.GatewayID != "" || c.GatewaySecret != "" || c.PCIP != "" || c.Port != 0 || c.MAC != "" || c.Broadcast != "" || c.LANToken != "" {
		return errors.New("v2 uses enrolled credentials and a devices list; remove legacy fields")
	}
	u, err := url.Parse(c.CloudURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("cloud_url must be an HTTPS origin")
	}
	if len(strings.TrimSpace(c.Name)) < 1 || len(c.Name) > 100 || len(c.Devices) > 32 {
		return errors.New("a gateway name and at most 32 devices are required")
	}
	seen := make(map[string]bool)
	for _, target := range c.Devices {
		if !deviceID.MatchString(target.DeviceID) || seen[target.DeviceID] {
			return errors.New("invalid or duplicate Windows device ID")
		}
		seen[target.DeviceID] = true
		if mac, err := net.ParseMAC(target.MAC); err != nil || len(mac) != 6 {
			return errors.New("invalid Windows MAC")
		}
		if ip := net.ParseIP(target.Broadcast); ip == nil || ip.To4() == nil || (!ip.IsPrivate() && target.Broadcast != "255.255.255.255") {
			return errors.New("broadcast must be a private IPv4 or limited broadcast address")
		}
		if target.LANToken != "" || target.BackupRelay {
			if !hexSecret.MatchString(target.LANToken) {
				return errors.New("backup relay requires a local Windows credential")
			}
			if ip := net.ParseIP(target.PCIP); ip == nil || ip.To4() == nil || !ip.IsPrivate() || target.Port < 1 || target.Port > 65535 {
				return errors.New("Windows API must use a private IPv4 address and valid port")
			}
		}
	}
	return nil
}
