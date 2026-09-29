package protocol

import (
	"errors"
	"regexp"
	"time"
)

var identifier = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var nonce = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

type Command struct {
	CommandID string `json:"command_id"`
	GatewayID string `json:"gateway_id"`
	Action    string `json:"action"`
	IssuedAt  int64  `json:"issued_at"`
	ExpiresAt int64  `json:"expires_at"`
	Nonce     string `json:"nonce"`
}

type Result struct {
	CommandID string `json:"command_id"`
	OK        bool   `json:"ok"`
	State     string `json:"state"`
	Error     string `json:"error,omitempty"`
}

func ValidAction(action string) bool {
	switch action {
	case "wake", "status", "sleep", "hibernate", "restart", "shutdown":
		return true
	default:
		return false
	}
}

func (c Command) Validate(expectedGateway string, now time.Time) error {
	if c.GatewayID != expectedGateway || !identifier.MatchString(c.CommandID) || !nonce.MatchString(c.Nonce) || !ValidAction(c.Action) {
		return errors.New("invalid remote command")
	}
	seconds := now.Unix()
	if c.IssuedAt > seconds+30 || c.ExpiresAt < seconds || c.ExpiresAt <= c.IssuedAt || c.ExpiresAt-c.IssuedAt > 60 {
		return errors.New("remote command expired or outside allowed time window")
	}
	return nil
}
