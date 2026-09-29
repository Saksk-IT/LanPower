package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
	"github.com/Saksk-IT/LanPower/router_gateway/internal/protocol"
)

type Client struct {
	config config.Config
	http   *http.Client
}

func New(c config.Config) *Client {
	return &Client{config: c, http: &http.Client{Timeout: 35 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *Client) request(ctx context.Context, method, path string, payload any, output any) error {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.config.CloudURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.config.GatewaySecret)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("cloud returned HTTP %d", response.StatusCode)
	}
	if output != nil {
		decoder := json.NewDecoder(io.LimitReader(response.Body, 65536))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(output); err != nil {
			return errors.New("invalid cloud response")
		}
	}
	return nil
}

func (c *Client) Heartbeat(ctx context.Context, state string, uptime int64) error {
	return c.request(ctx, http.MethodPost, "/api/v1/gateway/heartbeat", map[string]any{
		"gateway_id": c.config.GatewayID, "pc_state": state, "version": "1.1.1", "uptime": uptime,
	}, nil)
}

func (c *Client) Poll(ctx context.Context) (*protocol.Command, error) {
	var response struct {
		Command *protocol.Command `json:"command"`
	}
	path := "/api/v1/gateway/commands?gateway_id=" + url.QueryEscape(c.config.GatewayID)
	if err := c.request(ctx, http.MethodGet, path, nil, &response); err != nil {
		return nil, err
	}
	return response.Command, nil
}

func (c *Client) Result(ctx context.Context, result protocol.Result) error {
	return c.request(ctx, http.MethodPost, "/api/v1/gateway/results", result, nil)
}
