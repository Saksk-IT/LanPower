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

type Config struct {
	GatewayID     string `json:"gateway_id"`
	GatewaySecret string `json:"gateway_secret"`
	CloudURL      string `json:"cloud_url"`
	PCIP          string `json:"pc_ip"`
	Port          int    `json:"port"`
	MAC           string `json:"mac"`
	Broadcast     string `json:"broadcast"`
	LANToken      string `json:"lan_token"`
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
	if _, err := net.ParseMAC(c.MAC); err != nil {
		return errors.New("invalid PC MAC")
	}
	if ip := net.ParseIP(c.Broadcast); ip == nil || ip.To4() == nil || !ip.IsPrivate() {
		return errors.New("broadcast must be a private IPv4 address")
	}
	return nil
}
