from concurrent.futures import ThreadPoolExecutor
import time
import uuid

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from cloud_app.app.auth import digest
from cloud_app.app.models import AuditLog, Device, DeviceAuthorization, DeviceSession, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_platform import login, make_client


@pytest.fixture
def cloud(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    try:
        yield client, app
    finally:
        client.close()
        app.state.engine.dispose()


def start(client, device_type="windows"):
    response = client.post("/api/v2/enroll/start", json={"device_type": device_type,
        "name": "Test PC" if device_type == "windows" else "Test Gateway", "version": "1.4.0", "protocol_version": "2"})
    assert response.status_code == 200, response.text
    return response.json()


def approve(client, enrollment, decision="approve"):
    return client.post("/enroll/decision", data={"csrf": client.cookies["lp_csrf"],
        "user_code": enrollment["user_code"], "decision": decision})


def permit_poll(app, enrollment):
    with app.state.platform.sessions.begin() as db:
        db.get(DeviceAuthorization, digest(enrollment["device_code"])).next_poll_at = 0


def test_device_starts_browser_approves_and_only_device_redeems(cloud):
    client, app = cloud
    enrollment = start(client)
    assert len(enrollment["user_code"]) == 9
    assert enrollment["verification_uri"] == "https://power.example.com/enroll"
    assert enrollment["expires_in"] == 600
    assert enrollment["interval"] == 5
    assert client.post("/api/v2/enroll/token", json={"device_code": enrollment["user_code"]}).status_code == 400
    assert client.get("/enroll", follow_redirects=False).status_code == 303
    pending = client.post("/api/v2/enroll/token", json={"device_code": enrollment["device_code"]})
    assert pending.status_code == 400 and pending.json()["error"] == "authorization_pending"
    assert client.post("/api/v2/enroll/token", json={"device_code": enrollment["device_code"]}).status_code == 429
    csrf = login(client)
    assert client.post("/enroll/decision", data={"user_code": enrollment["user_code"], "decision": "approve"}).status_code == 403
    lookup = client.post("/enroll/lookup", data={"csrf": csrf, "user_code": enrollment["user_code"]})
    assert "Test PC" in lookup.text and "允许连接" in lookup.text
    assert enrollment["device_code"] not in lookup.text
    assert approve(client, enrollment).status_code == 200
    assert approve(client, enrollment).status_code == 400
    permit_poll(app, enrollment)
    response = client.post("/api/v2/enroll/token", json={"device_code": enrollment["device_code"]})
    assert response.status_code == 200, response.text
    credentials = response.json()
    assert app.state.platform.windows.authorize(credentials["access_token"]) == (ADMIN_ID, credentials["device_id"])
    assert client.post("/api/v2/enroll/token", json={"device_code": enrollment["device_code"]}).status_code == 400
    with app.state.platform.sessions() as db:
        row = db.get(DeviceAuthorization, digest(enrollment["device_code"]))
        assert row.user_code_hash == digest(enrollment["user_code"].replace("-", ""))
        assert row.redeemed_at is not None
        session = db.scalar(select(DeviceSession).where(DeviceSession.device_id == credentials["device_id"]))
        assert session.access_hash == digest(credentials["access_token"])
        assert session.refresh_hash == digest(credentials["refresh_token"])
    response = client.post(f'/devices/{credentials["device_id"]}/revoke', data={"csrf": csrf}, follow_redirects=False)
    assert response.status_code == 303
    with pytest.raises(PermissionError):
        app.state.platform.windows.authorize(credentials["access_token"])
    assert client.post("/api/v2/devices/token", json={"device_id": credentials["device_id"], "refresh_token": credentials["refresh_token"]}).status_code == 401
    with app.state.platform.sessions() as db:
        assert {"enrollment_approved", "device_enrolled", "device_revoked"} <= set(db.scalars(select(AuditLog.event)))


@pytest.mark.parametrize("outcome", ["deny", "expired", "revoked_owner"])
def test_denial_expiry_and_owner_revocation_block_exchange(cloud, outcome):
    client, app = cloud
    enrollment = start(client)
    login(client)
    assert approve(client, enrollment, "deny" if outcome == "deny" else "approve").status_code == 200
    with app.state.platform.sessions.begin() as db:
        if outcome == "expired":
            db.get(DeviceAuthorization, digest(enrollment["device_code"])).expires_at = int(time.time()) - 1
        if outcome == "revoked_owner":
            db.get(User, ADMIN_ID).revoked_at = int(time.time())
    response = client.post("/api/v2/enroll/token", json={"device_code": enrollment["device_code"]})
    assert response.status_code == (401 if outcome == "revoked_owner" else 400)
    assert app.state.platform.devices(ADMIN_ID) == []


def test_gateway_token_cannot_call_windows_protocol(cloud):
    client, app = cloud
    enrollment = start(client, "gateway")
    login(client)
    approve(client, enrollment)
    credentials = client.post("/api/v2/enroll/token", json={"device_code": enrollment["device_code"]}).json()
    assert client.get("/api/v2/windows/commands", headers={"Authorization": "Bearer " + credentials["access_token"]}).status_code == 401
    token = {"device_id": credentials["device_id"], "refresh_token": credentials["refresh_token"]}
    assert client.post("/api/v2/windows/token", json=token).status_code == 401
    rotated = client.post("/api/v2/devices/token", json=token)
    assert rotated.status_code == 200
    assert app.state.platform.tokens.authorize(rotated.json()["access_token"], expected_type="gateway")[1] == credentials["device_id"]


def test_concurrent_exchange_issues_one_device_and_refresh_reuse_revokes(cloud):
    client, app = cloud
    enrollment = start(client)
    login(client)
    approve(client, enrollment)
    def exchange(_):
        try:
            return app.state.platform.enrollment.exchange({"device_code": enrollment["device_code"]})
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(exchange, range(2)))
    assert sum(result is not None for result in results) == 1
    credentials = next(result for result in results if result)
    payload = {"device_id": credentials["device_id"], "refresh_token": credentials["refresh_token"]}
    def refresh(_):
        try:
            return app.state.platform.tokens.refresh(payload)
        except PermissionError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(refresh, range(2)))
    assert sum(result is not None for result in results) == 1
    rotated = next(result for result in results if result)
    with pytest.raises(PermissionError):
        app.state.platform.windows.authorize(rotated["access_token"])
    with app.state.platform.sessions() as db:
        assert list(db.scalars(select(AuditLog.event))).count("refresh_reuse") == 1


def test_approval_owner_controls_device_and_revocation_isolated(cloud):
    client, app = cloud
    enrollment = start(client)
    other_id = str(uuid.uuid4())
    with app.state.platform.sessions.begin() as db:
        db.add(User(id=other_id, username="other", password_hash="disabled", created_at=int(time.time())))
    app.state.platform.enrollment.decide(other_id, enrollment["user_code"], approved=True)
    credentials = app.state.platform.enrollment.exchange({"device_code": enrollment["device_code"]})
    assert app.state.platform.windows.authorize(credentials["access_token"])[0] == other_id
    login(client)
    assert client.get(f'/api/v2/devices/{credentials["device_id"]}').status_code == 404
    assert client.post(f'/devices/{credentials["device_id"]}/revoke', data={"csrf": client.cookies["lp_csrf"]}).status_code == 400
    assert app.state.platform.windows.authorize(credentials["access_token"])[0] == other_id


def test_invalid_type_and_enrollment_rate_limit(cloud):
    client, _app = cloud
    for invalid in ("client", "linux", [], None):
        assert client.post("/api/v2/enroll/start", json={"device_type": invalid,
            "name": "Bad", "version": "1.4.0", "protocol_version": "2"}).status_code == 400
    for _ in range(16):
        start(client)
    assert client.post("/api/v2/enroll/start", json={}).status_code == 429


@pytest.mark.parametrize("device_type", ["windows", "gateway"])
def test_device_can_disconnect_itself_without_revoking_other_identities(cloud, device_type):
    client, app = cloud
    csrf = login(client)
    enrolled = start(client, device_type)
    approve(client, enrolled)
    credentials = client.post("/api/v2/enroll/token", json={"device_code": enrolled["device_code"]}).json()
    other = start(client, "windows")
    approve(client, other)
    other_credentials = client.post("/api/v2/enroll/token", json={"device_code": other["device_code"]}).json()
    code = app.state.platform.mobile.create_enrollment(ADMIN_ID, "Phone")
    phone = client.post("/api/v2/clients/enroll", json={"code": code}).json()
    assert client.post("/api/v2/devices/revoke", headers={"x-csrf-token": csrf}).status_code == 401
    assert client.post("/api/v2/devices/revoke", headers={"Authorization": "Bearer " + phone["access_token"]}).status_code == 401
    headers = {"Authorization": "Bearer " + credentials["access_token"]}
    pending = None
    if device_type == "windows":
        app.state.platform.windows.heartbeat(credentials["device_id"], {"device_id": credentials["device_id"],
            "state": "online", "version": "1.4.0", "uptime": 1, "lan_ip": "192.168.1.20", "wol_capable": False})
        pending = app.state.platform.issue_command(ADMIN_ID, credentials["device_id"], "status")
    # A caller-supplied target cannot change the identity being removed.
    assert client.post("/api/v2/devices/revoke", headers=headers,
                       json={"device_id": other_credentials["device_id"]}).status_code == 200
    assert client.post("/api/v2/devices/revoke", headers=headers).status_code == 401
    assert client.post("/api/v2/devices/token", json={"device_id": credentials["device_id"],
        "refresh_token": credentials["refresh_token"]}).status_code == 401
    assert app.state.platform.tokens.authorize(other_credentials["access_token"], expected_type="windows")[1] == other_credentials["device_id"]
    if pending:
        assert app.state.platform.windows.command_result(ADMIN_ID, pending["command_id"])["state"] == "failed"
    with app.state.platform.sessions() as db:
        events = list(db.scalars(select(AuditLog).where(AuditLog.event == "device_revoked")))
        assert len(events) == 1 and events[0].target_device_id == credentials["device_id"]
