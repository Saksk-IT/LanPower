from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import PowerServer, load_config, run_power_action  # noqa: E402


TOKEN = "a" * 64


class PowerServerTests(unittest.TestCase):
    def setUp(self):
        config = {
            "token": TOKEN,
            "host_ip": "127.0.0.1",
            "port": 48211,
            "allowed_networks": [__import__("ipaddress").ip_network("127.0.0.0/8")],
        }
        self.server = PowerServer(("127.0.0.1", 0), config, dry_run=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, path, *, method="GET", token=None, body=None):
        headers = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        request = Request(self.url + path, method=method, headers=headers, data=body)
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_status_requires_pairing(self):
        self.assertEqual(self.request("/api/status")[0], 401)
        self.assertEqual(self.request("/api/status", token="wrong")[0], 401)
        status, data = self.request("/api/status", token=TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(data["state"], "online")

    def test_only_authorized_known_action_is_dispatched(self):
        event = threading.Event()
        calls = []

        def fake_action(action, dry_run):
            calls.append((action, dry_run))
            event.set()

        with mock.patch("server.run_power_action", side_effect=fake_action):
            self.assertEqual(self.request("/api/power", method="POST", body={"action": "shutdown"})[0], 401)
            self.assertEqual(self.request("/api/power", method="POST", token=TOKEN, body={"action": "arbitrary"})[0], 400)
            self.assertEqual(calls, [])
            status, data = self.request("/api/power", method="POST", token=TOKEN, body={"action": "shutdown"})
            self.assertEqual(status, 202)
            self.assertEqual(data["action"], "shutdown")
            self.assertTrue(event.wait(3), "accepted action should be dispatched")
            self.assertEqual(calls, [("shutdown", True)])
            self.assertEqual(self.request("/api/power", method="POST", token=TOKEN, body={"action": "restart"})[0], 409)

    def test_static_page_and_loopback_only_setup(self):
        with urlopen(self.url + "/", timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("电脑电源", response.read().decode())
        with urlopen(self.url + "/setup", timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(TOKEN, response.read().decode())

    def test_config_rejects_invalid_token_or_host(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            config_path.write_text(json.dumps({
                "token": "short", "host_ip": "192.168.1.100",
                "allowed_networks": ["192.168.1.0/24"], "port": 48211,
            }), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(config_path)
            config_path.write_text(json.dumps({
                "token": TOKEN, "host_ip": "192.168.32.87",
                "allowed_networks": ["192.168.1.0/24"], "port": 48211,
            }), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(config_path)

    def test_dry_run_cannot_change_power_state(self):
        with mock.patch("server.subprocess.Popen") as process:
            run_power_action("shutdown", dry_run=True)
            process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
