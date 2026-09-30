import time
import uuid

import pytest

from cloud_app.app.models import Device, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_gateway_v2 import cloud, enroll, heartbeat, link, target


def pc_heartbeat(client, pc, headers, **changes):
    payload = {"device_id": pc, "version": "1.5.0", "state": "online", "uptime": 1,
               "lan_ip": "192.168.1.20", "wol_capable": True, "heartbeat_interval": 10,
               "wake_profile": {"token": "c" * 64, "port": 48211, "expires_at": int(time.time()) + 90}}
    return client.post("/api/v2/windows/heartbeat", headers=headers, json={**payload, **changes})


def sync(client, headers, results=None):
    return client.post("/api/v2/gateway/wake-setup", headers=headers, json={"results": results or []})


def test_select_gateway_auto_setup_and_unlink_without_exposing_ticket(cloud):
    client, platform, csrf = cloud
    gateway, gh = enroll(client, "gateway")
    pc, wh = enroll(client, "windows")
    other, other_h = enroll(client, "gateway")
    assert pc_heartbeat(client, pc, wh).status_code == 200
    assert sync(client, gh).json() == {"targets": []}
    assert link(client, csrf, gateway, pc).status_code == 303
    assert sync(client, other_h).json() == {"targets": []}
    response = sync(client, gh).json()
    assert response["targets"][0]["profile"]["token"] == "c" * 64
    assert response["targets"][0]["device_id"] == pc
    heartbeat(client, gateway, gh, [])
    page = client.get(f"/gateways?computer={pc}").text
    assert "使用这个网关" in page and "正在自动配置" in page and f'value="{pc}" selected' in page
    assert not client.get(f"/api/v2/devices/{pc}").json()["wake_available"]
    assert sync(client, gh, [{"device_id": pc, "state": "ready"}]).status_code == 200
    # A setup report alone does not make the power button available.
    assert not client.get(f"/api/v2/devices/{pc}").json()["wake_available"]
    heartbeat(client, gateway, gh, [target(pc)])
    assert client.get(f"/api/v2/devices/{pc}").json()["wake_available"]
    for url in ("/api/v2/devices", f"/api/v2/devices/{pc}", "/gateways", "/devices", "/activity"):
        assert "c" * 64 not in client.get(url).text
    assert sync(client, wh).status_code == 401
    assert client.post(f"/gateways/{gateway}/links", data={"windows_id": pc}).status_code == 403
    assert link(client, csrf, gateway, pc, remove=True).status_code == 303
    assert sync(client, gh, [{"device_id": pc, "state": "ready"}]).json() == {"targets": []}
    assert not client.get(f"/api/v2/devices/{pc}").json()["wake_available"]


@pytest.mark.parametrize("changes", [
    {"lan_ip": "127.0.0.1"}, {"lan_ip": "8.8.8.8"}, {"lan_ip": "::1"},
    {"wake_profile": {"token": "bad", "port": 48211, "expires_at": 0}},
    {"wake_profile": {"token": "c" * 64, "port": True, "expires_at": int(time.time()) + 90}},
    {"wake_profile": {"token": "c" * 64, "port": 48211, "expires_at": int(time.time()) + 900}},
    {"mac": "02:00:00:00:00:01"}, {"lan_token": "d" * 64},
])
def test_rejects_invalid_or_excessive_profile_information(cloud, changes):
    client, _, _ = cloud
    pc, wh = enroll(client, "windows")
    assert pc_heartbeat(client, pc, wh, **changes).status_code == 400


def test_offline_expiry_unreachable_and_older_clients(cloud):
    client, platform, csrf = cloud
    gateway, gh = enroll(client, "gateway")
    pc, wh = enroll(client, "windows")
    link(client, csrf, gateway, pc)
    heartbeat(client, gateway, gh, [])
    assert "升级网关" in client.get(f"/api/v2/devices/{pc}").json()["wake_setup_message"]
    sync(client, gh)
    assert "请先开启" in client.get(f"/api/v2/devices/{pc}").json()["wake_setup_message"]
    pc_heartbeat(client, pc, wh)
    sync(client, gh, [{"device_id": pc, "state": "unreachable"}])
    assert "同一局域网" in client.get(f"/api/v2/devices/{pc}").json()["wake_setup_message"]
    with platform.sessions.begin() as db:
        device = db.get(Device, pc)
        device.meta = {**device.meta, "wake_profile": {**device.meta["wake_profile"], "expires_at": int(time.time()) - 1}}
    assert sync(client, gh).json()["targets"][0]["profile"] is None
    pc_heartbeat(client, pc, wh, state="offline")
    assert sync(client, gh).json()["targets"][0]["profile"] is None
    pc_heartbeat(client, pc, wh)
    platform.windows.revoke_device(ADMIN_ID, pc)
    assert sync(client, gh).json() == {"targets": []}


def test_gateway_from_another_account_never_receives_pc_tickets(cloud):
    client, platform, csrf = cloud
    gateway, gh = enroll(client, "gateway")
    pc, wh = enroll(client, "windows")
    pc_heartbeat(client, pc, wh)
    link(client, csrf, gateway, pc)
    owner = str(uuid.uuid4())
    with platform.sessions.begin() as db:
        db.add(User(id=owner, username="separate", password_hash="!", created_at=int(time.time())))
        db.flush()
        db.get(Device, pc).owner_id = owner
    assert sync(client, gh).json() == {"targets": []}
