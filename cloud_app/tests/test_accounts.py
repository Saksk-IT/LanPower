from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import secrets
import time

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from cloud_app.app.auth import create_session, digest
from cloud_app.app.main import create_app
from cloud_app.app.models import AccountConnection, ClientSession, Device, DeviceSession, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.app.settings import Settings
from cloud_app.password import hash_password

PASSWORD = "test account password 123!"


@pytest.fixture
def cloud(tmp_path):
    settings = Settings(None, "sqlite:///" + (tmp_path / "platform.db").as_posix(), hash_password(PASSWORD),
                        "https://accounts.example.test", allow_registration=True)
    app = create_app(settings)
    with TestClient(app, base_url=settings.public_url) as client:
        yield client, app


def register(client, username="alice"):
    response = client.post("/api/v2/account/register", json={"username": username, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def native(client, kind="windows", username="alice", **overrides):
    body = {"username": username, "password": PASSWORD, "client_type": kind, "connection_key": secrets.token_urlsafe(32),
            "name": "Test " + kind, "version": "1.23.0", "protocol_version": "2", **overrides}
    return client.post("/api/v2/account/login", json=body), body


def web_login(client, username="alice", password=PASSWORD):
    client.get("/login")
    response = client.post("/login", data={"username": username, "password": password, "auth": client.cookies["lp_auth"]}, follow_redirects=False)
    assert response.status_code == 303, response.text
    return client.cookies["lp_csrf"]


def test_three_endpoints_share_account_without_pairing_and_control_only_own_pc(cloud):
    client, app = cloud
    account = register(client)
    register(client, "bob")
    pc, _ = native(client)
    phone, _ = native(client, "mobile")
    other, _ = native(client, username="bob")
    assert pc.status_code == phone.status_code == other.status_code == 200
    computer, mobile = pc.json(), phone.json()
    assert computer["account"] == mobile["account"] == account
    headers = {"Authorization": "Bearer " + mobile["access_token"]}
    assert [row["device_id"] for row in client.get("/api/v2/devices", headers=headers).json()] == [computer["device_id"]]
    assert client.get("/api/v2/devices/" + other.json()["device_id"], headers=headers).status_code == 404
    assert client.get("/api/v2/windows/commands", headers=headers).status_code == 401
    assert client.get("/api/v2/devices", headers={"Authorization": "Bearer " + computer["access_token"]}).status_code == 401
    assert app.state.platform.mobile.permits(mobile["client_id"], "codex")
    app.state.platform.windows.heartbeat(computer["device_id"], {"device_id": computer["device_id"], "state": "online",
        "version": "1.23.0", "uptime": 1, "lan_ip": "192.168.1.8", "wol_capable": False})
    command = client.post(f'/api/v2/devices/{computer["device_id"]}/commands', headers=headers, json={"action": "status"}).json()
    assert command["route"] == "windows_direct"
    delivered = app.state.platform.windows.poll(computer["device_id"], timeout=0)
    app.state.platform.windows.result(computer["device_id"], {"command_id": delivered["command_id"], "ok": True, "state": "online", "error": ""})
    assert client.get("/api/v2/commands/" + command["command_id"], headers=headers).json()["state"] == "completed"
    web_login(client)
    assert [row["device_id"] for row in client.get("/api/v2/devices").json()] == [computer["device_id"]]


@pytest.mark.parametrize("kind,id_key", [("windows", "device_id"), ("mobile", "client_id")])
def test_retry_login_has_stable_identity_and_stores_only_hashes(cloud, kind, id_key):
    client, app = cloud
    register(client)
    first, body = native(client, kind)
    again = client.post("/api/v2/account/login", json=body)
    assert first.status_code == again.status_code == 200
    assert first.json()[id_key] == again.json()[id_key]
    assert first.json()["refresh_token"] != again.json()["refresh_token"]
    with app.state.platform.sessions() as db:
        mapping = db.get(AccountConnection, digest(body["connection_key"]))
        assert mapping.owner_id == first.json()["account"]["id"]
        assert PASSWORD not in db.get(User, mapping.owner_id).password_hash
        assert db.get(User, mapping.owner_id).password_hash.startswith("scrypt$")
        assert db.scalar(select(Device.id).where(Device.owner_id == mapping.owner_id)) is not None if kind == "windows" else True


def test_concurrent_retries_do_not_duplicate_windows(cloud):
    client, app = cloud
    account = register(client)
    first, body = native(client)
    owner = app.state.accounts.authenticate("alice", PASSWORD)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: app.state.accounts.connect(owner, body), range(2)))
    assert {row["device_id"] for row in results} == {first.json()["device_id"]}
    assert len(app.state.platform.devices(account["id"])) == 1


def test_web_account_forms_accept_full_length_unicode_passwords(cloud):
    client, _ = cloud
    password = "密" * 256
    client.get("/register")
    created = client.post("/register", data={"username": "unicode-user", "password": password,
        "repeat_password": password, "auth": client.cookies["lp_auth"]}, follow_redirects=False)
    assert created.status_code == 303
    changed = client.post("/settings/account/password", data={"csrf": client.cookies["lp_csrf"],
        "current_password": password, "password": "碼" * 256, "repeat_password": "碼" * 256}, follow_redirects=False)
    assert changed.status_code == 303


def test_existing_pairing_can_become_account_connection_without_changing_ids(cloud):
    client, app = cloud
    platform = app.state.platform
    old = platform.windows.enroll({"code": platform.windows.create_enrollment(ADMIN_ID), "name": "Original PC", "version": "1.22.2", "protocol_version": "2"})
    with platform.sessions.begin() as db:
        db.get(Device, old["device_id"]).meta = {"preserved": "existing setting"}
    logged, _ = native(client, username="admin", previous={"id": old["device_id"], "refresh_token": old["refresh_token"]})
    assert logged.status_code == 200, logged.text
    assert logged.json()["device_id"] == old["device_id"]
    assert platform.device(ADMIN_ID, old["device_id"]).meta == {"preserved": "existing setting"}
    assert platform.device(ADMIN_ID, old["device_id"]).name == "Original PC"
    code = platform.mobile.create_enrollment(ADMIN_ID, "Original phone")
    mobile = platform.mobile.enroll({"code": code})
    phone, _ = native(client, "mobile", username="admin", previous={"id": mobile["client_id"], "refresh_token": mobile["refresh_token"]})
    assert phone.status_code == 200
    assert phone.json()["client_id"] == mobile["client_id"]


def test_other_owner_or_forged_previous_cannot_rebind_pc(cloud):
    client, app = cloud
    register(client)
    register(client, "bob")
    pc, body = native(client)
    previous = {"id": pc.json()["device_id"], "refresh_token": pc.json()["refresh_token"]}
    stolen, _ = native(client, username="bob", previous=previous)
    assert stolen.status_code == 409
    switched = client.post("/api/v2/account/login", json={**body, "username": "bob"})
    assert switched.status_code == 409
    forged, _ = native(client, previous={**previous, "refresh_token": "x" * 43})
    assert forged.status_code == 409
    assert app.state.platform.device(pc.json()["account"]["id"], previous["id"]).revoked_at is None


def test_mobile_migration_login_can_retry_after_response_is_lost(cloud):
    client, app = cloud
    account = register(client)
    original = app.state.platform.mobile.enroll({"code": app.state.platform.mobile.create_enrollment(account["id"], "Original QR phone")})
    first, body = native(client, "mobile", previous={"id": original["client_id"], "refresh_token": original["refresh_token"]})
    assert first.status_code == 200
    retried = client.post("/api/v2/account/login", json=body)
    assert retried.status_code == 200
    assert retried.json()["client_id"] == original["client_id"]
    assert retried.json()["refresh_token"] != first.json()["refresh_token"]
    forged = client.post("/api/v2/account/login", json={**body,
        "previous": {"id": "unrelated", "refresh_token": original["refresh_token"]}})
    assert forged.status_code == 409


def test_password_change_revokes_account_logins_preserves_legacy_and_pc_identity(cloud):
    client, app = cloud
    account = register(client)
    pc, body = native(client)
    phone, _ = native(client, "mobile")
    qr = app.state.platform.mobile.enroll({"code": app.state.platform.mobile.create_enrollment(account["id"], "Existing QR phone")})
    csrf = web_login(client)
    new_password = PASSWORD + " changed"
    assert client.post("/settings/account/password", data={"csrf": csrf, "current_password": "wrong", "password": new_password, "repeat_password": new_password}).status_code == 400
    assert client.post("/settings/account/password", data={"current_password": PASSWORD, "password": new_password, "repeat_password": new_password}).status_code == 403
    changed = client.post("/settings/account/password", data={"csrf": csrf, "current_password": PASSWORD, "password": new_password, "repeat_password": new_password}, follow_redirects=False)
    assert changed.status_code == 303
    assert client.get("/api/v2/devices", headers={"Authorization": "Bearer " + phone.json()["access_token"]}).status_code == 401
    assert client.get("/api/v2/devices", headers={"Authorization": "Bearer " + qr["access_token"]}).status_code == 200
    renewed = client.post("/api/v2/account/login", json={**body, "password": new_password})
    assert renewed.status_code == 200 and renewed.json()["device_id"] == pc.json()["device_id"]


def test_passkey_account_sets_password_and_keeps_existing_credentials(tmp_path):
    settings = Settings(None, "sqlite:///" + (tmp_path / "platform.db").as_posix(), None, "https://accounts.example.test")
    app = create_app(settings)
    with app.state.platform.sessions() as db:
        owner = db.get(User, ADMIN_ID)
        owner.identity_initialized_at = int(time.time())
        db.commit()
        token, csrf = create_session(db, owner, "passkey")
    with TestClient(app, base_url=settings.public_url) as client:
        client.cookies.set("lp_session", token)
        client.cookies.set("lp_csrf", csrf)
        original = app.state.platform.windows.enroll({"code": app.state.platform.windows.create_enrollment(ADMIN_ID),
            "name": "Keep PC", "version": "1.22.2", "protocol_version": "2"})
        response = client.post("/settings/account/password", data={"csrf": csrf, "password": PASSWORD, "repeat_password": PASSWORD}, follow_redirects=False)
        assert response.status_code == 303
        assert app.state.accounts.authenticate("admin", PASSWORD).id == ADMIN_ID
        assert app.state.platform.tokens.authorize(original["access_token"], expected_type="windows")[1] == original["device_id"]


def test_registration_closed_and_bootstrap_remains_protected(cloud, tmp_path):
    client, app = cloud
    app.state.platform.settings = replace(app.state.platform.settings, allow_registration=False)
    assert client.post("/api/v2/account/register", json={"username": "alice", "password": PASSWORD}).status_code == 403
    settings = Settings(None, "sqlite:///" + (tmp_path / "bootstrap.db").as_posix(), None, "https://accounts.example.test", allow_registration=True)
    other_app = create_app(settings)
    with TestClient(other_app, base_url=settings.public_url) as other:
        assert other.post("/api/v2/account/register", json={"username": "someone", "password": PASSWORD}).status_code == 409


def test_native_login_rejects_origins_gateway_and_bad_payloads(cloud):
    client, _ = cloud
    register(client)
    good, body = native(client)
    assert good.status_code == 200
    assert client.post("/api/v2/account/login", json=body, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/v2/account/login", json={**body, "client_type": "gateway"}).status_code == 400
    assert client.post("/api/v2/account/login", json={**body, "client_type": []}).status_code == 400
    assert client.post("/api/v2/account/login", json={**body, "connection_key": "predictable"}).status_code == 400
    assert client.post("/api/v2/account/login", json={**body, "device_id": "forged"}).status_code == 400
    assert client.post("/api/v2/account/login", json={**body, "password": "wrong"}).status_code == 401


def test_web_registration_bound_to_browser_and_native_failures_share_limit(cloud):
    client, _ = cloud
    assert client.get("/register").status_code == 200
    body = {"username": "carol", "password": PASSWORD, "repeat_password": PASSWORD}
    assert client.post("/register", data=body).status_code == 403
    response = client.post("/register", data={**body, "auth": client.cookies["lp_auth"]}, follow_redirects=False)
    assert response.status_code == 303
    client.cookies.clear()
    for _ in range(5):
        assert native(client, username="carol", password="wrong")[0].status_code == 401
    assert native(client, username="carol")[0].status_code == 429
