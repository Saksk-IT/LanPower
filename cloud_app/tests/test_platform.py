from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import sqlite3
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

from cloud_remote.server import Config, Relay
from cloud_app.app.auth import hash_password
from cloud_app.cli import migrate_v1
from cloud_app.app.main import create_app
from cloud_app.app.settings import Settings


def make_client(directory: Path, no_gateway: bool = False) -> tuple[TestClient, object]:
    settings = Settings(
        legacy=None if no_gateway else Config("home-router", "a" * 64, "b" * 64, directory / "relay.db"),
        database_url="sqlite:///" + (directory / "platform.db").as_posix(),
        admin_password_hash=hash_password("correct horse battery staple"),
        public_url="https://power.example.com",
    )
    app = create_app(settings)
    return TestClient(app, base_url="https://power.example.com"), app


def login(client: TestClient) -> str:
    response = client.post("/login", data={"username": "admin", "password": "correct horse battery staple"}, follow_redirects=False)
    assert response.status_code == 303
    assert "Secure" in response.headers["set-cookie"]
    assert "HttpOnly" in response.headers["set-cookie"]
    return client.cookies["lp_csrf"]


def test_migration_login_and_csrf() -> None:
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        client, app = make_client(directory)
        try:
            with closing(sqlite3.connect(directory / "platform.db")) as connection:
                assert connection.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0002_windows_direct"
                assert connection.execute("SELECT count(*) FROM devices").fetchone()[0] == 2
                assert connection.execute("SELECT count(*) FROM device_links").fetchone()[0] == 1
                assert connection.execute("SELECT count(*) FROM legacy_clients").fetchone()[0] == 1
            assert client.get("/dashboard", follow_redirects=False).status_code == 303
            assert client.post("/login", data={"username": "admin", "password": "wrong"}).status_code == 401
            csrf = login(client)
            for path in ("/dashboard", "/devices", "/gateways", "/clients", "/activity", "/settings", "/system"):
                assert client.get(path).status_code == 200, path
            assert "我的设备" in client.get("/dashboard").text
            devices = client.get("/api/v2/devices").json()
            assert {device["device_type"] for device in devices} == {"gateway", "windows"}
            target = next(device["device_id"] for device in devices if device["device_type"] == "windows")
            assert client.get(f"/api/v2/devices/{target}").json()["wake_available"] is False
            assert client.post(f"/devices/{target}/commands", data={"action": "wake"}).status_code == 403
            assert client.post(f"/devices/{target}/rename", data={"csrf": csrf, "name": "Workstation"}, follow_redirects=False).status_code == 303
            assert "Workstation" in client.get("/devices").text
            assert client.post("/logout", data={"csrf": csrf}, follow_redirects=False).status_code == 303
            assert client.get("/dashboard", follow_redirects=False).status_code == 303
        finally:
            client.close()
            app.state.engine.dispose()


def test_legacy_gateway_round_trip_and_web_control() -> None:
    with tempfile.TemporaryDirectory() as temp:
        client, app = make_client(Path(temp))
        try:
            assert client.get("/api/v1/client/status?gateway_id=home-router").status_code == 401
            gateway_headers = {"Authorization": "Bearer " + "a" * 64}
            client_headers = {"Authorization": "Bearer " + "b" * 64}
            assert client.post("/api/v1/gateway/heartbeat", headers=gateway_headers,
                               json={"gateway_id": "home-router", "pc_state": "online", "version": "1.1.2", "uptime": 10}).status_code == 200
            assert client.get("/api/v1/client/status?gateway_id=home-router", headers=client_headers).json()["pc"] == "online"
            csrf = login(client)
            target = next(device["device_id"] for device in client.get("/api/v2/devices").json() if device["device_type"] == "windows")
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(client.post, f"/devices/{target}/commands", data={"csrf": csrf, "action": "shutdown"})
                command = client.get("/api/v1/gateway/commands?gateway_id=home-router", headers=gateway_headers).json()["command"]
                assert command["action"] == "shutdown"
                assert client.post("/api/v1/gateway/results", headers=gateway_headers,
                                   json={"command_id": command["command_id"], "ok": True, "state": "transitioning"}).status_code == 200
                response = future.result(timeout=5)
            assert response.status_code == 200
            assert "网关连接" in response.text
            assert "关机" in response.text
            assert "关机" in client.get("/activity").text
            assert client.post("/api/v1/client/commands", headers=client_headers,
                               json={"gateway_id": "home-router", "action": "shutdown"}).status_code == 429
        finally:
            client.close()
            app.state.engine.dispose()


def test_migrate_v1_preserves_source_database() -> None:
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        legacy = Config("home-router", "a" * 64, "b" * 64, directory / "relay.db")
        Relay(legacy)
        original = hashlib.sha256(legacy.database.read_bytes()).digest()
        settings = Settings(legacy, "sqlite:///" + (directory / "platform.db").as_posix(),
                            hash_password("correct horse battery staple"), "https://power.example.com")
        gateway_id, windows_id = migrate_v1(settings)
        assert gateway_id != windows_id
        assert migrate_v1(settings) == (gateway_id, windows_id)
        assert hashlib.sha256(legacy.database.read_bytes()).digest() == original
        with closing(sqlite3.connect(directory / "platform.db")) as connection:
            assert connection.execute("SELECT count(*) FROM devices").fetchone()[0] == 2
