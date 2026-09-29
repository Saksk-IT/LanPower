from __future__ import annotations

import tempfile
import json
from pathlib import Path

from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_platform import login, make_client


def test_no_router_windows_enrollment_and_command_round_trip() -> None:
    with tempfile.TemporaryDirectory() as temp:
        client, app = make_client(Path(temp), no_gateway=True)
        try:
            csrf = login(client)
            assert client.get("/api/v2/devices").json() == []
            assert client.get("/api/v1/client/status?gateway_id=home-router").status_code == 404
            assert client.get("/devices/enroll").status_code == 200
            assert client.post("/devices/enroll", data={"csrf": ""}).status_code == 403
            code = app.state.platform.windows.create_enrollment(ADMIN_ID)
            enrollment = {"code": code, "name": "Desktop-PC", "version": "1.4.0", "protocol_version": "2"}
            credentials = client.post("/api/v2/windows/enroll", headers={"Content-Type": "application/json"},
                                      content=iter([json.dumps(enrollment).encode()])).json()
            assert credentials["device_id"]
            assert client.post("/api/v2/windows/enroll", json=enrollment).status_code == 400
            device_id = credentials["device_id"]
            headers = {"Authorization": "Bearer " + credentials["access_token"]}
            heartbeat = {"device_id": device_id, "version": "1.4.0", "state": "online",
                         "uptime": 10, "lan_ip": "192.168.1.7", "wol_capable": True}
            assert client.post("/api/v2/windows/heartbeat", headers=headers, json=heartbeat).status_code == 200
            status = client.get(f"/api/v2/devices/{device_id}").json()
            assert status["state"] == "online"
            assert status["cloud_agent"] == "online"
            assert status["wake_gateway"] is None
            assert status["wake_available"] is False
            assert status["remote_control_available"] is True
            assert "Cloud 已连接" in client.get("/dashboard").text
            assert client.post(f"/api/v2/devices/{device_id}/commands", json={"action": "sleep"}).status_code == 403
            command = client.post(f"/api/v2/devices/{device_id}/commands", headers={"x-csrf-token": csrf},
                                  json={"action": "status"}).json()
            assert command["route"] == "windows_direct"
            assert command["accepted"] is True
            delivered = client.get("/api/v2/windows/commands", headers=headers).json()["command"]
            assert delivered["command_id"] == command["command_id"]
            assert delivered["action"] == "status"
            assert delivered["target_device_id"] == device_id
            assert client.post("/api/v2/windows/results", headers=headers,
                               json={"command_id": delivered["command_id"], "ok": True,
                                     "state": "online", "error": ""}).status_code == 200
            assert client.get(f"/api/v2/commands/{command['command_id']}").json()["state"] == "completed"
            assert client.post(f"/api/v2/devices/{device_id}/commands", headers={"x-csrf-token": csrf},
                               json={"action": "wake"}).status_code == 503
            assert client.post(f"/devices/{device_id}/commands", data={"csrf": csrf, "action": "shutdown"}).status_code == 200
            power = client.get("/api/v2/windows/commands", headers=headers).json()["command"]
            assert power["action"] == "shutdown"
            assert client.post("/api/v2/windows/results", headers=headers,
                               json={"command_id": power["command_id"], "ok": True,
                                     "state": "transitioning", "error": ""}).status_code == 200
            assert client.get(f"/api/v2/commands/{power['command_id']}").json()["state"] == "transitioning"
            assert "云端直连" in client.get("/activity").text
        finally:
            client.close()
            app.state.engine.dispose()


def test_refresh_reuse_revokes_device_session() -> None:
    with tempfile.TemporaryDirectory() as temp:
        client, app = make_client(Path(temp))
        try:
            login(client)
            code = app.state.platform.windows.create_enrollment(ADMIN_ID)
            credentials = client.post("/api/v2/windows/enroll", json={"code": code, "name": "Desktop-PC",
                "version": "1.4.0", "protocol_version": "2"}).json()
            old = {"device_id": credentials["device_id"], "refresh_token": credentials["refresh_token"]}
            rotated = client.post("/api/v2/windows/token", json=old).json()
            assert rotated["refresh_token"] != old["refresh_token"]
            assert client.post("/api/v2/windows/token", json=old).status_code == 401
            assert client.post("/api/v2/windows/heartbeat", headers={"Authorization": "Bearer " + rotated["access_token"]},
                json={"device_id": credentials["device_id"], "version": "1.4.0", "state": "online",
                      "uptime": 1, "lan_ip": "192.168.1.7", "wol_capable": False}).status_code == 401
        finally:
            client.close()
            app.state.engine.dispose()
