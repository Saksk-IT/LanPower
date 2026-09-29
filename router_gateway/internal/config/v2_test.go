package config

import (
	"strings"
	"testing"
)

func v2Example() Config {
	return Config{ProtocolVersion: "2", Name: "Home", CloudURL: "https://power.example.com", Devices: []Target{
		{DeviceID: "00000000-0000-0000-0000-000000000002", MAC: "02:00:00:00:00:01", Broadcast: "192.168.1.255"},
		{DeviceID: "00000000-0000-0000-0000-000000000003", MAC: "02:00:00:00:00:02", Broadcast: "255.255.255.255",
			PCIP: "192.168.1.7", Port: 48211, LANToken: strings.Repeat("a", 64), BackupRelay: true},
	}}
}

func TestMultipleTargetsAndLocalRelayValidation(t *testing.T) {
	if err := v2Example().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Config){
		"legacy secret":            func(c *Config) { c.GatewaySecret = strings.Repeat("b", 64) },
		"unknown protocol":         func(c *Config) { c.ProtocolVersion = "3" },
		"duplicate target":         func(c *Config) { c.Devices[1].DeviceID = c.Devices[0].DeviceID },
		"missing local credential": func(c *Config) { c.Devices[1].LANToken = "" },
		"public LAN endpoint":      func(c *Config) { c.Devices[1].PCIP = "8.8.8.8" },
		"missing LAN port":         func(c *Config) { c.Devices[1].Port = 0 },
		"invalid MAC":              func(c *Config) { c.Devices[0].MAC = "invalid" },
		"public broadcast":         func(c *Config) { c.Devices[0].Broadcast = "8.8.8.255" },
		"non-HTTPS cloud":          func(c *Config) { c.CloudURL = "http://power.example.com" },
		"credential in URL":        func(c *Config) { c.CloudURL = "https://user:secret@power.example.com" },
		"path in URL":              func(c *Config) { c.CloudURL += "/path" },
		"too many targets":         func(c *Config) { c.Devices = make([]Target, 33) },
	} {
		t.Run(name, func(t *testing.T) {
			c := v2Example()
			change(&c)
			if c.Validate() == nil {
				t.Fatal("unsafe config accepted")
			}
		})
	}
	c := v2Example()
	c.Devices = nil
	if err := c.Validate(); err != nil {
		t.Fatal("empty gateway cannot enroll", err)
	}
}
