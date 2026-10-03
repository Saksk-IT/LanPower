"""An explicit LAN origin keeps password login, pairing and browser WSS usable."""

from dataclasses import replace

from fastapi.testclient import TestClient
import pytest
import qrcode
from starlette.websockets import WebSocketDisconnect

from cloud_app.app.main import create_app
from cloud_app.app.platform import ADMIN_ID
from cloud_app.app.settings import Settings
from cloud_app.password import hash_password

LOCAL = "https://localhost:8443"
LAN = "https://192.168.50.25:8443"
PASSWORD = "local-test-password"


@pytest.fixture
def settings(tmp_path):
    return Settings(legacy=None, database_url="sqlite:///" + (tmp_path / "platform.db").as_posix(),
                    admin_password_hash=hash_password(PASSWORD), public_url=LOCAL,
                    additional_origins=(LAN,))


def login(client, origin):
    assert client.get("/login").status_code == 200
    return client.post("/login", headers={"Origin": origin},
                       data={"username": "admin", "password": PASSWORD, "auth": client.cookies["lp_auth"]},
                       follow_redirects=False)


@pytest.mark.parametrize("origin", [LOCAL, LAN])
def test_explicit_origins_login_pairing_and_remote_socket(settings, origin, monkeypatch):
    pairings = []
    make_qr = qrcode.make

    def record_pairing(value, **kwargs):
        pairings.append(value)
        return make_qr(value, **kwargs)

    monkeypatch.setattr(qrcode, "make", record_pairing)
    app = create_app(settings)
    try:
        with TestClient(app, base_url=origin) as client:
            response = login(client, origin)
            assert response.status_code == 303
            assert "Secure" in response.headers["set-cookie"]
            assert "HttpOnly" in response.headers["set-cookie"]
            assert f'value="{origin}"' in client.get("/settings").text
            paired = client.post("/clients/enroll", data={"csrf": client.cookies["lp_csrf"], "name": "LAN test"})
            assert paired.status_code == 200
            assert "<svg" in paired.text
            assert pairings[0].startswith(origin + "/#lanpower-client=")
            code = app.state.platform.windows.create_enrollment(ADMIN_ID)
            credentials = client.post("/api/v2/windows/enroll", json={"code": code, "name": "LAN test",
                "version": "1.15.1", "protocol_version": "2"}).json()
            path = origin.replace("https://", "wss://", 1) + "/api/v2/remote/client/" + credentials["device_id"]
            with client.websocket_connect(path, subprotocols=["lanpower.codex.v1"],
                                          headers={"Origin": origin}) as socket:
                assert socket.receive_json() == {"type": "state", "state": "cloud_offline"}
            with pytest.raises(WebSocketDisconnect) as rejected:
                with client.websocket_connect(path, subprotocols=["lanpower.codex.v1"],
                                              headers={"Origin": "https://evil.example"}):
                    pass
            assert rejected.value.code == 4403
    finally:
        app.state.engine.dispose()


@pytest.mark.parametrize("origin", ["https://evil.example", "http://192.168.50.25:8443", "https://192.168.50.26:8443"])
def test_foreign_login_origin_is_rejected(settings, origin):
    app = create_app(settings)
    try:
        with TestClient(app, base_url=LAN) as client:
            assert login(client, origin).status_code == 403
    finally:
        app.state.engine.dispose()


def test_unconfigured_lan_origin_is_rejected(settings):
    app = create_app(replace(settings, additional_origins=()))
    try:
        with TestClient(app, base_url=LAN) as client:
            assert login(client, LAN).status_code == 403
    finally:
        app.state.engine.dispose()


def test_unrecognized_host_cannot_change_displayed_cloud_url(settings):
    app = create_app(settings)
    try:
        with TestClient(app, base_url=LOCAL) as client:
            assert login(client, LOCAL).status_code == 303
            response = client.get("/settings", headers={"Host": "untrusted.example"})
            assert f'value="{LOCAL}"' in response.text
            # Caddy can forward HTTP internally while the browser uses HTTPS.
            response = client.get("/settings", headers={"Host": "192.168.50.25:8443"})
            assert f'value="{LAN}"' in response.text
    finally:
        app.state.engine.dispose()


@pytest.mark.parametrize("origin", ["http://example.test", "https://*.example.test", "https://user@example.test",
                                   "https://example.test/path", "https://example.test?query=1",
                                   "https://example.test#fragment", "https://example.test:wrong", "https://bad host.test"])
def test_invalid_additional_origins_are_rejected(settings, origin):
    with pytest.raises(ValueError):
        replace(settings, additional_origins=(origin,)).validate()


def test_environment_allowlist_preserves_primary_passkey_origin(monkeypatch):
    monkeypatch.setenv("LANPOWER_PUBLIC_URL", LOCAL)
    monkeypatch.setenv("LANPOWER_ADDITIONAL_ORIGINS", " " + LAN + "/, https://another.example/ ")
    monkeypatch.setenv("LANPOWER_LEGACY_CONFIG", "")
    monkeypatch.delenv("LANPOWER_ADMIN_PASSWORD_HASH", raising=False)
    settings = Settings.from_environment()
    assert settings.public_url == LOCAL
    assert settings.browser_origins == {LOCAL, LAN, "https://another.example"}
