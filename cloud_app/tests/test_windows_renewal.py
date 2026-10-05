"""Windows pairing must survive interrupted renewal and expired access."""

import time
import uuid

import pytest
from sqlalchemy import select

from cloud_app.app.auth import digest
from cloud_app.app.device_auth import DeviceTokens, REFRESH_SECONDS
from cloud_app.app.models import Device, DeviceSession, UsedRefreshToken, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_enrollment import approve, enroll, start
from cloud_app.tests.test_platform import login, make_client


@pytest.fixture
def cloud(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    try:
        login(client)
        yield client, app
    finally:
        client.close()
        app.state.engine.dispose()


def payload(credentials):
    return {key: credentials[key] for key in ("device_id", "refresh_token")}


def test_lost_response_and_cloud_restart_keep_windows_pairing(cloud):
    client, app = cloud
    credentials = enroll(app)
    request = payload(credentials)
    first = client.post("/api/v2/windows/renew", json=request)
    assert first.status_code == 200
    # Discard the first access grant as if its response had never arrived.
    recovered = DeviceTokens(app.state.platform.sessions).renew(request, expected_type="windows")
    assert recovered["device_id"] == credentials["device_id"]
    assert recovered["refresh_token"] == credentials["refresh_token"]
    assert recovered["access_token"] != first.json()["access_token"]
    assert app.state.platform.windows.authorize(recovered["access_token"]) == (ADMIN_ID, credentials["device_id"])
    with app.state.platform.sessions() as db:
        session = db.scalar(select(DeviceSession).where(DeviceSession.device_id == credentials["device_id"]))
        assert session.revoked_at is None and session.generation == 0
        assert db.get(UsedRefreshToken, digest(credentials["refresh_token"])) is None


def test_expired_access_after_resume_renews_without_reenrollment(cloud, monkeypatch):
    client, app = cloud
    credentials = enroll(app)
    headers = {"Authorization": "Bearer " + credentials["access_token"]}
    now = int(time.time()) + 12 * 3600
    monkeypatch.setattr("cloud_app.app.device_auth.time.time", lambda: now)
    heartbeat = {"device_id": credentials["device_id"], "version": "1.22.1", "state": "online",
                 "uptime": 1, "lan_ip": "192.168.1.7", "wol_capable": False}
    assert client.post("/api/v2/windows/heartbeat", headers=headers, json=heartbeat).status_code == 401
    response = client.post("/api/v2/windows/renew", json=payload(credentials))
    assert response.status_code == 200
    assert response.json()["refresh_token"] == credentials["refresh_token"]
    assert client.post("/api/v2/windows/heartbeat", json=heartbeat,
                       headers={"Authorization": "Bearer " + response.json()["access_token"]}).status_code == 200
    with app.state.platform.sessions() as db:
        session = db.scalar(select(DeviceSession).where(DeviceSession.device_id == credentials["device_id"]))
        assert session.refresh_expires_at == now + REFRESH_SECONDS


@pytest.mark.parametrize("rejected", ["session", "device", "owner", "expired"])
def test_revoked_or_expired_authorization_is_never_restored(cloud, rejected):
    client, app = cloud
    credentials = enroll(app)
    with app.state.platform.sessions.begin() as db:
        session = db.scalar(select(DeviceSession).where(DeviceSession.device_id == credentials["device_id"]))
        if rejected == "expired":
            session.refresh_expires_at = int(time.time()) - 1
        else:
            entity = session if rejected == "session" else db.get(Device, credentials["device_id"]) if rejected == "device" else db.get(User, ADMIN_ID)
            entity.revoked_at = int(time.time())
    assert client.post("/api/v2/windows/renew", json=payload(credentials)).status_code == 401


def test_gateway_credentials_cannot_use_windows_renewal(cloud):
    client, app = cloud
    pending = start(client, "gateway")
    assert approve(client, pending).status_code == 200
    credentials = client.post("/api/v2/enroll/token", json={"device_code": pending["device_code"]}).json()
    assert client.post("/api/v2/windows/renew", json=payload(credentials)).status_code == 401
    assert client.post("/api/v2/devices/renew", json=payload(credentials)).status_code == 200


def test_invalid_payload_and_wrong_device_leave_original_authorization_usable(cloud):
    client, app = cloud
    credentials = enroll(app)
    request = payload(credentials)
    assert client.post("/api/v2/windows/renew", json={**request, "extra": True}).status_code == 400
    assert client.post("/api/v2/windows/renew", json={**request, "device_id": str(uuid.uuid4())}).status_code == 401
    assert client.post("/api/v2/windows/renew", json=request).status_code == 200


def test_consumed_legacy_token_cannot_be_restored_or_revoke_the_current_session(cloud):
    client, app = cloud
    credentials = enroll(app)
    rotated = client.post("/api/v2/windows/token", json=payload(credentials)).json()
    assert client.post("/api/v2/windows/renew", json=payload(credentials)).status_code == 401
    assert client.post("/api/v2/windows/renew", json=payload(rotated)).status_code == 200
