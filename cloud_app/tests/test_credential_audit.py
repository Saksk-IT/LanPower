import time

import pytest
from sqlalchemy import select

from cloud_app.app.audit import FAILURE_AUDIT_SECONDS
from cloud_app.app.models import AuditLog, ClientSession, DeviceSession, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_platform import login, make_client


@pytest.fixture
def cloud(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    yield client, app
    client.close()
    app.state.engine.dispose()


def enroll(app, kind, owner=ADMIN_ID):
    platform = app.state.platform
    if kind == "device":
        return platform.windows.enroll({"code": platform.windows.create_enrollment(owner),
            "name": "PC", "version": "1.4.0", "protocol_version": "2"})
    return platform.mobile.enroll({"code": platform.mobile.create_enrollment(owner, "Phone")})


def credential_row(db, kind, credentials):
    if kind == "device":
        return db.scalar(select(DeviceSession).where(DeviceSession.device_id == credentials["device_id"]))
    return db.get(ClientSession, credentials["client_id"])


@pytest.mark.parametrize("kind", ["device", "client"])
def test_failed_access_is_persisted_throttled_private_and_owner_scoped(cloud, kind):
    client, app = cloud
    credentials = enroll(app, kind)
    prefix = "device" if kind == "device" else "client"
    event = prefix + "_credential_failed"
    endpoint = "/api/v2/windows/commands" if kind == "device" else "/api/v2/devices"
    headers = {"Authorization": "Bearer " + credentials["access_token"]}
    with app.state.platform.sessions.begin() as db:
        credential_row(db, kind, credentials).access_expires_at = 0
    for _ in range(4):
        assert client.get(endpoint, headers=headers).status_code == 401
    with app.state.platform.sessions() as db:
        events = list(db.scalars(select(AuditLog).where(AuditLog.event == event)))
        assert len(events) == 1
        record = events[0]
        assert record.owner_id == ADMIN_ID
        assert record.target_device_id == credentials.get("device_id")
        serialized = str({key: value for key, value in vars(record).items() if not key.startswith("_")})
        assert credentials["access_token"] not in serialized and credentials["refresh_token"] not in serialized
    with app.state.platform.sessions.begin() as db:
        db.get(AuditLog, record.id).created_at = int(time.time()) - FAILURE_AUDIT_SECONDS - 1
        db.add(User(id="other", username="other", password_hash="unused", created_at=1))
    assert client.get(endpoint, headers=headers).status_code == 401
    other = enroll(app, kind, "other")
    with app.state.platform.sessions.begin() as db:
        credential_row(db, kind, other).revoked_at = int(time.time())
    assert client.get(endpoint, headers={"Authorization": "Bearer " + other["access_token"]}).status_code == 401
    # Unknown or guessed credentials must not be attributed to an account.
    assert client.get(endpoint, headers={"Authorization": "Bearer unknown"}).status_code == 401
    with app.state.platform.sessions() as db:
        events = list(db.scalars(select(AuditLog).where(AuditLog.event == event)))
        assert len(events) == 3
        assert sum(row.owner_id == "other" for row in events) == 1
    login(client)
    activity = client.get("/activity")
    assert ("设备授权失败" if kind == "device" else "客户端授权失败") in activity.text
    assert credentials["access_token"] not in activity.text and credentials["refresh_token"] not in activity.text


@pytest.mark.parametrize("kind, renewal", [("device", False), ("client", False), ("client", True)])
@pytest.mark.parametrize("failure", ["expired", "revoked", "owner_revoked"])
def test_known_refresh_failure_commits_before_returning_unauthorized(cloud, kind, renewal, failure):
    client, app = cloud
    credentials = enroll(app, kind)
    with app.state.platform.sessions.begin() as db:
        row = credential_row(db, kind, credentials)
        if failure == "expired":
            row.refresh_expires_at = 0
        elif failure == "revoked":
            row.revoked_at = int(time.time())
        else:
            db.get(User, ADMIN_ID).revoked_at = int(time.time())
    field, endpoint = ("device_id", "/api/v2/devices/token") if kind == "device" else ("client_id", "/api/v2/clients/token")
    if renewal:
        endpoint = "/api/v2/clients/renew"
    payload = {field: credentials[field], "refresh_token": credentials["refresh_token"]}
    for _ in range(2):
        assert client.post(endpoint, json=payload).status_code == 401
    with app.state.platform.sessions() as db:
        events = list(db.scalars(select(AuditLog).where(AuditLog.event == kind + "_credential_failed")))
        assert len(events) == 1 and events[0].owner_id == ADMIN_ID
