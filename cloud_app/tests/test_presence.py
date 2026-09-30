import time

import pytest

from cloud_app.app.models import Device
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_gateway_v2 import enroll, heartbeat as gateway_heartbeat, link, target
from cloud_app.tests.test_platform import login, make_client


@pytest.fixture
def cloud(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    csrf = login(client)
    yield client, app.state.platform, csrf
    client.close()
    app.state.engine.dispose()


def report(client, device, headers, state="online", interval=10):
    body = {"device_id": device, "version": "1.4.0", "state": state,
            "uptime": 10, "lan_ip": "192.168.1.7", "wol_capable": True}
    if interval is not None:
        body["heartbeat_interval"] = interval
    return client.post("/api/v2/windows/heartbeat", headers=headers, json=body)


def test_browser_and_mobile_share_live_state_and_stopping_preserves_authorization(cloud):
    client, platform, _ = cloud
    device, headers = enroll(client, "windows")
    phone = platform.mobile.enroll({"code": platform.mobile.create_enrollment(ADMIN_ID, "Phone")})
    mobile_headers = {"Authorization": "Bearer " + phone["access_token"]}
    for state in ("online", "transitioning", "offline", "online"):
        response = report(client, device, headers, state)
        assert response.status_code == 200 and response.json()["presence_protocol"] == 1
        browser = client.get("/api/v2/devices").json()
        mobile = client.get("/api/v2/devices", headers=mobile_headers).json()
        assert browser == mobile
        assert browser[0]["state"] == state
        assert browser[0]["remote_control_available"] is (state == "online")
        assert browser[0]["lan_ip"] == "192.168.1.7"
    for page in ("/dashboard", "/devices", "/gateways"):
        response = client.get(page)
        assert 'data-status-sync' in response.text
        assert '/static/status.js' in response.text
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("interval,seconds", [(10, 35), (None, 75)])
def test_presence_expires_after_missed_heartbeats_and_recovers(cloud, monkeypatch, interval, seconds):
    client, platform, _ = cloud
    device, headers = enroll(client, "windows")
    now = int(time.time())
    monkeypatch.setattr(time, "time", lambda: now)
    assert report(client, device, headers, interval=interval).status_code == 200
    now += seconds
    assert platform.device_status(ADMIN_ID, device)["state"] == "online"
    now += 1
    status = platform.device_status(ADMIN_ID, device)
    assert status["state"] == "offline" and status["remote_control_available"] is False
    assert report(client, device, headers, interval=interval).status_code == 200
    assert platform.device_status(ADMIN_ID, device)["state"] == "online"
    with platform.sessions.begin() as db:
        db.get(Device, device).last_seen_at = now + 100
    assert platform.device_status(ADMIN_ID, device)["state"] == "offline"


@pytest.mark.parametrize("state", ["offline", "transitioning"])
def test_old_gateway_observation_cannot_override_power_transition(cloud, monkeypatch, state):
    client, platform, csrf = cloud
    device, windows_headers = enroll(client, "windows")
    gateway, gateway_headers = enroll(client, "gateway")
    assert link(client, csrf, gateway, device, backup=True).status_code == 303
    now = int(time.time())
    monkeypatch.setattr(time, "time", lambda: now)
    assert gateway_heartbeat(client, gateway, gateway_headers, [target(device, True, "online")]).status_code == 200
    now += 1
    assert report(client, device, windows_headers, state).status_code == 200
    status = platform.device_status(ADMIN_ID, device)
    assert status["state"] == state and status["remote_control_available"] is False
    now += 36
    assert platform.device_status(ADMIN_ID, device)["state"] == "offline"
    # A later, fresh observation can establish LAN reachability again.
    assert gateway_heartbeat(client, gateway, gateway_headers, [target(device, True, "online")]).status_code == 200
    status = platform.device_status(ADMIN_ID, device)
    assert status["state"] == "online" and status["remote_control_available"] is True
    with platform.sessions.begin() as db:
        db.get(Device, gateway).last_seen_at = now + 100
    assert platform.device_status(ADMIN_ID, device)["state"] == "offline"


def test_lan_presence_does_not_grant_backup_control_and_stale_gateway_cannot_keep_pc_online(cloud):
    client, platform, csrf = cloud
    device, _ = enroll(client, "windows")
    gateway, headers = enroll(client, "gateway")
    assert link(client, csrf, gateway, device, backup=False).status_code == 303
    assert gateway_heartbeat(client, gateway, headers, [target(device, False, "online")]).status_code == 200
    status = platform.device_status(ADMIN_ID, device)
    assert status["state"] == "online" and status["cloud_agent"] == "offline"
    assert status["remote_control_available"] is False and status["backup_gateway"] is None
    assert client.post(f"/api/v2/devices/{device}/commands", headers={"x-csrf-token": csrf},
                       json={"action": "shutdown"}).status_code == 503
    assert gateway_heartbeat(client, gateway, headers, [target(device, False, "offline")]).status_code == 200
    assert platform.device_status(ADMIN_ID, device)["state"] == "offline"
    assert gateway_heartbeat(client, gateway, headers, [target(device, False, "online")]).status_code == 200
    with platform.sessions.begin() as db:
        db.get(Device, gateway).last_seen_at = int(time.time()) - 76
    assert platform.device_status(ADMIN_ID, device)["state"] == "offline"


@pytest.mark.parametrize("action", ["sleep", "hibernate", "restart", "shutdown"])
def test_power_acknowledgement_is_transitioning_until_a_new_heartbeat(cloud, action):
    client, platform, _ = cloud
    device, headers = enroll(client, "windows")
    assert report(client, device, headers).status_code == 200
    issued = platform.windows.issue(ADMIN_ID, device, action)
    platform.windows.poll(device, timeout=0)
    result = {"command_id": issued["command_id"], "ok": True, "state": "transitioning", "error": ""}
    assert client.post("/api/v2/windows/results", headers=headers, json=result).status_code == 200
    status = platform.device_status(ADMIN_ID, device)
    assert status["state"] == "transitioning" and status["remote_control_available"] is False
    assert '正在执行电源操作' in client.get("/dashboard").text
    assert report(client, device, headers, "offline").status_code == 200
    assert platform.device_status(ADMIN_ID, device)["state"] == "offline"
    assert report(client, device, headers).status_code == 200
    # A duplicated old receipt must not overwrite the recovered online state.
    assert client.post("/api/v2/windows/results", headers=headers, json=result).status_code == 200
    assert platform.device_status(ADMIN_ID, device)["state"] == "online"


@pytest.mark.parametrize("change", [{"state": "sleep"}, {"heartbeat_interval": True},
                                    {"heartbeat_interval": 0}, {"heartbeat_interval": 100}])
def test_invalid_presence_report_cannot_overwrite_online_state(cloud, change):
    client, platform, _ = cloud
    device, headers = enroll(client, "windows")
    assert report(client, device, headers).status_code == 200
    invalid = {"device_id": device, "version": "1.4.0", "state": "online", "uptime": 10,
               "lan_ip": "192.168.1.7", "wol_capable": True, "heartbeat_interval": 10, **change}
    assert client.post("/api/v2/windows/heartbeat", headers=headers, json=invalid).status_code == 400
    assert platform.device_status(ADMIN_ID, device)["state"] == "online"
