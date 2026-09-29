from __future__ import annotations

import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from cloud_remote.server import Config, Server


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.gateway_secret = "a" * 64
        self.client_secret = "b" * 64
        config = Config("home-router", self.gateway_secret, self.client_secret,
                        Path(self.directory.name) / "relay.db")
        self.server = Server(("127.0.0.1", 0), config)
        self.addCleanup(self.server.server_close)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.thread.join(timeout=3)

    def call(self, path, role=None, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"}
        if role:
            headers["Authorization"] = "Bearer " + (self.gateway_secret if role == "gateway" else self.client_secret)
        request = Request(self.base + path, data=body, headers=headers)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def heartbeat(self, state="offline"):
        return self.call("/api/v1/gateway/heartbeat", "gateway", {
            "gateway_id": "home-router", "pc_state": state, "version": "1.1.1", "uptime": 3})

    def test_auth_status_and_gateway_distinction(self):
        path = "/api/v1/client/status?gateway_id=home-router"
        self.assertEqual(self.call(path)[0], 401)
        self.assertEqual(self.call(path, "gateway")[0], 401)
        self.assertEqual(self.call(path, "client")[1], {"gateway": "offline", "pc": "unknown"})
        self.assertEqual(self.heartbeat()[0], 200)
        self.assertEqual(self.call(path, "client")[1]["pc"], "offline")
        self.heartbeat("online")
        self.assertEqual(self.call(path, "client")[1]["pc"], "online")

    def test_command_round_trip_and_rate_limit(self):
        self.heartbeat("online")
        result = {}
        def send_command():
            result["value"] = self.call("/api/v1/client/commands", "client", {
                "gateway_id": "home-router", "action": "shutdown"})
        thread = threading.Thread(target=send_command)
        thread.start()
        command = None
        for _ in range(30):
            command = self.server.relay.poll(timeout=0)
            if command:
                break
            time.sleep(0.01)
        self.assertIsNotNone(command)
        self.assertEqual(command["action"], "shutdown")
        self.assertEqual(len(command["nonce"]), 32)
        payload = {"command_id": command["command_id"], "ok": True, "state": "transitioning"}
        self.assertEqual(self.call("/api/v1/gateway/results", "gateway", payload)[0], 200)
        self.assertEqual(self.call("/api/v1/gateway/results", "gateway", payload)[0], 200)
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["value"][1]["state"], "transitioning")
        self.assertEqual(self.call("/api/v1/client/commands", "client", {
            "gateway_id": "home-router", "action": "shutdown"})[0], 429)
        self.assertEqual(self.call("/api/v1/client/commands", "client", {
            "gateway_id": "home-router", "action": "restart"})[0], 429)
        self.assertEqual(self.call("/api/v1/client/commands", "client", {
            "gateway_id": "home-router", "action": "http://localhost"})[0], 400)

    def test_power_requires_online_pc_and_credentials_are_separate(self):
        self.heartbeat("offline")
        self.assertEqual(self.call("/api/v1/client/commands", "client", {
            "gateway_id": "home-router", "action": "sleep"})[0], 400)
        self.assertEqual(self.call("/api/v1/gateway/heartbeat", "client", {
            "gateway_id": "home-router", "pc_state": "online", "version": "1", "uptime": 0})[0], 401)
        self.assertNotIn("lan_token", self.server.relay.config.__dict__)


if __name__ == "__main__":
    unittest.main()
