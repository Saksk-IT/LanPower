package windows

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Saksk-IT/LanPower/router_gateway/internal/config"
)

type Client struct {
	Config config.Config
	HTTP   *http.Client
}

func New(c config.Config) *Client {
	return &Client{Config: c, HTTP: &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *Client) request(method, path string, body []byte) (*http.Response, error) {
	address := fmt.Sprintf("http://%s:%d%s", c.Config.PCIP, c.Config.Port, path)
	req, err := http.NewRequest(method, address, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Config.LANToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.HTTP.Do(req)
}

func (c *Client) Status() (string, error) {
	response, err := c.request(http.MethodGet, "/api/status", nil)
	if err != nil {
		return "offline", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "offline", fmt.Errorf("Windows status returned HTTP %d", response.StatusCode)
	}
	var payload struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&payload); err != nil || payload.State != "online" {
		return "offline", errors.New("invalid Windows status response")
	}
	return "online", nil
}

func (c *Client) Power(action string) error {
	data, _ := json.Marshal(map[string]string{"action": action})
	response, err := c.request(http.MethodPost, "/api/power", data)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("Windows power API returned HTTP %d", response.StatusCode)
	}
	return nil
}
