package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func example() Config {
	return Config{
		GatewayID: "home-router", GatewaySecret: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		LANToken: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		CloudURL: "https://power.example.com", PCIP: "192.168.1.100", Port: 48211,
		MAC: "02-11-22-33-44-55", Broadcast: "192.168.1.255",
	}
}

func TestValidateCredentialsAndDestination(t *testing.T) {
	c := example()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.LANToken = c.GatewaySecret
	if err := c.Validate(); err == nil {
		t.Fatal("identical LAN and cloud credentials accepted")
	}
	c = example()
	c.CloudURL = "http://power.example.com"
	if err := c.Validate(); err == nil {
		t.Fatal("plaintext cloud endpoint accepted")
	}
	c = example()
	c.PCIP = "8.8.8.8"
	if err := c.Validate(); err == nil {
		t.Fatal("public Windows target accepted")
	}
}

func TestLoadRequiresPrivateConfig(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file mode checks require Linux")
	}
	path := filepath.Join(t.TempDir(), "gateway.json")
	data, _ := json.Marshal(example())
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("world-readable config accepted")
	}
}
