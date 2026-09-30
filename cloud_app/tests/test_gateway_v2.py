from concurrent.futures import ThreadPoolExecutor
import time
import uuid

import pytest

from cloud_app.app.models import Device, GatewayCommand, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_enrollment import approve, start
from cloud_app.tests.test_platform import login, make_client


@pytest.fixture
def cloud(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    csrf = login(client)
    try:
        yield client, app.state.platform, csrf
    finally:
        client.close()
        app.state.engine.dispose()


def enroll(client, kind):
    pending = start(client, kind)
    assert approve(client, pending).status_code == 200
    response = client.post("/api/v2/enroll/token", json={"device_code": pending["device_code"]})
    assert response.status_code == 200, response.text
    credentials = response.json()
    return credentials["device_id"], {"Authorization": "Bearer " + credentials["access_token"]}


def heartbeat(client, gateway, headers, targets):
    return client.post("/api/v2/gateway/heartbeat", headers=headers, json={
        "device_id": gateway, "version": "2.0.0", "uptime": 1, "targets": targets})


def target(device_id, relay=False, state="unknown"):
    return {"device_id": device_id, "lan_state": state, "wol_capable": True, "relay_enabled": relay}


def link(client, csrf, gateway, windows, backup=False, remove=False):
    return client.post(f"/gateways/{gateway}/links", data={"csrf": csrf, "windows_id": windows,
        **({"backup": "on"} if backup else {}), **({"operation": "remove"} if remove else {})}, follow_redirects=False)


def issue(client, csrf, windows, action):
    return client.post(f"/api/v2/devices/{windows}/commands", headers={"x-csrf-token": csrf}, json={"action": action})


def test_multiple_windows_round_trip_direct_priority_and_result_idempotency(cloud):
    client, platform, csrf = cloud
    gateway, headers = enroll(client, "gateway")
    pc_a, windows_headers = enroll(client, "windows")
    pc_b, _ = enroll(client, "windows")
    assert heartbeat(client, gateway, headers, [target(pc_a, True, "online"), target(pc_b)]).status_code == 200
    for pc in (pc_a, pc_b):
        assert link(client, csrf, gateway, pc, backup=True).status_code == 303
    assert client.post("/api/v2/windows/heartbeat", headers=windows_headers, json={
        "device_id": pc_a, "version": "2.0.0", "state": "online", "uptime": 1,
        "lan_ip": "192.168.1.7", "wol_capable": True}).status_code == 200
    direct = issue(client, csrf, pc_a, "shutdown").json()
    assert direct["route"] == "windows_direct"
    assert client.get("/api/v2/windows/commands", headers=windows_headers).json()["command"]["command_id"] == direct["command_id"]
    for pc in (pc_a, pc_b):
        command = issue(client, csrf, pc, "wake").json()
        assert command["route"] == "wake_gateway"
        delivered = client.get("/api/v2/gateway/commands", headers=headers).json()["command"]
        assert delivered["command_id"] == command["command_id"]
        assert delivered["target_device_id"] == pc and delivered["gateway_id"] == gateway
        result = {"command_id": command["command_id"], "ok": True, "state": "waking", "error": ""}
        assert client.post("/api/v2/gateway/results", headers=headers, json={**result, "state": "online"}).status_code == 400
        for _ in range(2):
            assert client.post("/api/v2/gateway/results", headers=headers, json=result).status_code == 200
        assert client.get(f'/api/v2/commands/{command["command_id"]}').json()["state"] == "completed"
        assert client.post("/api/v2/gateway/results", headers=headers, json={**result, "ok": False, "state": "failed"}).status_code == 400
    assert platform.gateway.poll(gateway, timeout=0) is None
    assert client.get("/api/v2/gateway/commands", headers=windows_headers).status_code == 401
    assert client.get("/api/v2/windows/commands", headers=headers).status_code == 401


@pytest.mark.parametrize("action", ["status", "sleep", "hibernate", "restart", "shutdown"])
def test_backup_relay_requires_both_permissions_and_lan_reachability(cloud, action):
    client, platform, csrf = cloud
    gateway, headers = enroll(client, "gateway")
    pc, _ = enroll(client, "windows")
    for local_enabled, cloud_enabled, lan in [(False, True, "online"), (True, False, "online"), (True, True, "offline")]:
        assert heartbeat(client, gateway, headers, [target(pc, local_enabled, lan)]).status_code == 200
        assert link(client, csrf, gateway, pc, backup=cloud_enabled).status_code == 303
        assert issue(client, csrf, pc, action).status_code == 503
    assert heartbeat(client, gateway, headers, [target(pc, True, "online")]).status_code == 200
    assert link(client, csrf, gateway, pc, backup=True).status_code == 303
    command = issue(client, csrf, pc, action).json()
    assert command["route"] == "gateway_relay"
    assert platform.gateway.poll(gateway, timeout=0)["target_device_id"] == pc
    result = {"command_id": command["command_id"], "ok": True,
              "state": "online" if action == "status" else "transitioning", "error": ""}
    assert client.post("/api/v2/gateway/results", headers=headers, json=result).status_code == 200


def test_multiple_gateways_skip_offline_or_unconfigured_routes(cloud):
    client, platform, csrf = cloud
    gateways = [enroll(client, "gateway") for _ in range(2)]
    gateways.sort(key=lambda item: item[0])
    pc, pc_headers = enroll(client, "windows")
    for gateway, _headers in gateways:
        assert link(client, csrf, gateway, pc).status_code == 303
    live, live_headers = gateways[1]
    assert heartbeat(client, live, live_headers, []).status_code == 200
    assert client.get(f"/api/v2/devices/{pc}").json()["wake_available"] is False
    assert issue(client, csrf, pc, "wake").status_code == 503
    assert heartbeat(client, live, live_headers, [target(pc)]).status_code == 200
    status = client.get(f"/api/v2/devices/{pc}").json()
    assert status["wake_gateway"]["device_id"] == live
    assert issue(client, csrf, pc, "wake").json()["route"] == "wake_gateway"
    assert platform.gateway.poll(live, timeout=0)["target_device_id"] == pc
    with platform.sessions.begin() as db:
        db.get(Device, live).last_seen_at = int(time.time()) - 76
    assert issue(client, csrf, pc, "wake").status_code == 503
    assert client.post("/api/v2/windows/heartbeat", headers=pc_headers, json={
        "device_id": pc, "version": "2.0.0", "state": "online", "uptime": 2,
        "lan_ip": "192.168.1.7", "wol_capable": True}).status_code == 200
    assert issue(client, csrf, pc, "shutdown").json()["route"] == "windows_direct"


@pytest.mark.parametrize("change", ["unlink", "gateway_revoke", "target_revoke", "expiry"])
def test_pending_commands_stop_after_permission_change_or_expiry(cloud, change):
    client, platform, csrf = cloud
    gateway, headers = enroll(client, "gateway")
    pc, _ = enroll(client, "windows")
    assert heartbeat(client, gateway, headers, [target(pc)]).status_code == 200
    assert issue(client, csrf, pc, "wake").status_code == 503
    assert link(client, "", gateway, pc).status_code == 403
    assert link(client, csrf, gateway, pc).status_code == 303
    command = issue(client, csrf, pc, "wake").json()
    if change == "unlink":
        assert link(client, csrf, gateway, pc, remove=True).status_code == 303
    elif change.endswith("revoke"):
        revoked = gateway if change == "gateway_revoke" else pc
        assert client.post(f"/devices/{revoked}/revoke", data={"csrf": csrf}).status_code == 200
        if revoked == gateway:
            assert client.get("/api/v2/gateway/commands", headers=headers).status_code == 401
    else:
        with platform.sessions.begin() as db:
            db.get(GatewayCommand, command["command_id"]).expires_at = int(time.time()) - 1
    assert platform.gateway.poll(gateway, timeout=0) is None
    assert client.get(f'/api/v2/commands/{command["command_id"]}').json()["state"] == "failed"


def test_gateway_input_owner_boundaries_and_removed_target_isolation(cloud):
    client, platform, csrf = cloud
    gateway, headers = enroll(client, "gateway")
    pc, _ = enroll(client, "windows")
    other = str(uuid.uuid4())
    foreign = str(uuid.uuid4())
    with platform.sessions.begin() as db:
        db.add(User(id=other, username="other", password_hash="disabled", created_at=1))
        db.flush()
        db.add(Device(id=foreign, owner_id=other, device_type="windows", name="other PC", version="2",
                      protocol_version="2", created_at=1, meta={}))
    for invalid in [target(foreign), target(gateway), target(str(uuid.uuid4())), {**target(pc), "lan_token": "local-only"}]:
        assert heartbeat(client, gateway, headers, [invalid]).status_code == 400
    assert link(client, csrf, gateway, foreign).status_code == 400
    assert link(client, csrf, pc, gateway).status_code == 400
    assert heartbeat(client, gateway, headers, [target(pc), target(pc)]).status_code == 400
    platform.windows.revoke_device(ADMIN_ID, pc)
    pc_b, _ = enroll(client, "windows")
    assert heartbeat(client, gateway, headers, [target(pc), target(pc_b)]).status_code == 200
    assert platform.device(ADMIN_ID, gateway).meta["targets"] == [target(pc_b)]
    assert link(client, csrf, gateway, pc_b).status_code == 303
    assert issue(client, csrf, pc_b, "wake").status_code == 200


def test_atomic_delivery_and_result_requires_issued_command(cloud):
    client, platform, csrf = cloud
    gateway, headers = enroll(client, "gateway")
    pc, _ = enroll(client, "windows")
    heartbeat(client, gateway, headers, [target(pc)])
    link(client, csrf, gateway, pc)
    command = issue(client, csrf, pc, "wake").json()
    result = {"command_id": command["command_id"], "ok": True, "state": "waking", "error": ""}
    assert client.post("/api/v2/gateway/results", headers=headers, json=result).status_code == 400
    with ThreadPoolExecutor(max_workers=2) as pool:
        delivered = list(pool.map(lambda _: platform.gateway.poll(gateway, timeout=0), range(2)))
    assert sum(value is not None for value in delivered) == 1
    second, second_headers = enroll(client, "gateway")
    assert client.post("/api/v2/gateway/results", headers=second_headers, json=result).status_code == 400
    assert client.post("/api/v2/gateway/results", headers=headers, json={**result, "command_id": str(uuid.uuid4())}).status_code == 400
    assert link(client, csrf, gateway, pc, remove=True).status_code == 303
    assert client.post("/api/v2/gateway/results", headers=headers, json=result).status_code == 400


def test_heartbeat_accepts_maximum_target_count(cloud):
    client, platform, _csrf = cloud
    gateway, headers = enroll(client, "gateway")
    targets = []
    with platform.sessions.begin() as db:
        for index in range(32):
            pc = str(uuid.uuid4())
            db.add(Device(id=pc, owner_id=ADMIN_ID, device_type="windows", name=f"PC {index}", version="2",
                          protocol_version="2", created_at=1, meta={}))
            targets.append(target(pc, False, "offline"))
    assert heartbeat(client, gateway, headers, targets).status_code == 200
    assert heartbeat(client, gateway, headers, targets + [target(str(uuid.uuid4()))]).status_code == 400


def test_windows_presence_exposes_details_and_own_gateway_only(cloud):
    client, platform, csrf = cloud
    gateway, gateway_headers = enroll(client, "gateway")
    pc, windows_headers = enroll(client, "windows")
    beat = {"device_id": pc, "version": "2.0.0", "state": "online", "uptime": 1,
            "lan_ip": "192.168.1.20", "wol_capable": True}
    before = client.post("/api/v2/windows/heartbeat", headers=windows_headers, json=beat).json()
    assert before == {"ok": True, "wake_available": False, "wake_gateway": None, "presence_protocol": 1,
                      "wake_setup_protocol": 1, "wake_setup_message": "选择家中的网关后，将自动配置这台电脑。"}
    assert "未配置唤醒网关" in client.get("/dashboard").text
    heartbeat(client, gateway, gateway_headers, [target(pc)])
    link(client, csrf, gateway, pc)
    after = client.post("/api/v2/windows/heartbeat", headers=windows_headers, json=beat).json()
    assert after["wake_available"] and after["wake_gateway"]["device_id"] == gateway
    with platform.sessions.begin() as db:
        device = db.get(Device, pc)
        device.meta = {**device.meta, "private_marker": "must-not-leak"}
    status = client.get(f"/api/v2/devices/{pc}")
    assert status.json()["lan_ip"] == beat["lan_ip"]
    assert status.json()["wol_capable"] is True
    assert status.json()["last_seen_at"] is not None
    assert status.json()["protocol_version"] == "2"
    assert "must-not-leak" not in status.text
    page = client.get("/devices").text
    assert "192.168.1.20" in page and "系统允许唤醒" in page and "最近连接" in page
    assert "在线的唤醒网关</span><strong>1" in client.get("/system").text
