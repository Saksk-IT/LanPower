from contextlib import contextmanager
import json
from pathlib import Path
import tempfile

import pytest
from starlette.websockets import WebSocketDisconnect

from cloud_app.app.platform import ADMIN_ID
from cloud_app.app.remote import MAX_FRAME, Peer, ProtocolError, parse_frame, validate_request, validate_decision
from cloud_app.tests.test_platform import login, make_client

PROTOCOL = ["lanpower.codex.v1"]


@pytest.fixture
def remote():
    with tempfile.TemporaryDirectory() as temp:
        client, app = make_client(Path(temp), no_gateway=True)
        with client:
            csrf = login(client)
            code = app.state.platform.windows.create_enrollment(ADMIN_ID)
            creds = client.post("/api/v2/windows/enroll", json={"code": code, "name": "Remote test",
                "version": "1.8.0", "protocol_version": "2"}).json()
            yield client, app, creds, csrf, Path(temp)


def agent(client, creds):
    return client.websocket_connect("/api/v2/remote/agent", subprotocols=PROTOCOL,
        headers={"Authorization": "Bearer " + creds["access_token"]})


def browser(client, creds, **kwargs):
    return client.websocket_connect("wss://power.example.com/api/v2/remote/client/" + creds["device_id"], subprotocols=PROTOCOL,
        headers={"Origin": "https://power.example.com", **kwargs})


@contextmanager
def connected(client, creds):
    with agent(client, creds) as up:
        up.send_json({"type": "hello", "protocol": 1, "state": "host_ready"})
        up.send_json({"type": "ping"}); assert up.receive_json() == {"type": "pong"}
        with browser(client, creds) as down:
            assert down.receive_json() == {"type": "state", "state": "host_ready"}
            session = up.receive_json()["session"]
            up.send_json({"type": "state", "session": session, "state": "runtime_ready"})
            assert down.receive_json()["state"] == "runtime_ready"
            yield up, down, session


def test_roundtrip_notifications_approval_interrupt_and_no_persistence(remote):
    client, app, creds, _, temp = remote
    private = "private-source-sentinel-remote"
    with connected(client, creds) as (up, down, session):
        request = {"id": "first", "method": "turn/start", "params": {"threadId": "thread-test",
            "input": [{"type": "text", "text": private}]}}
        down.send_json({"type": "rpc", "payload": request})
        forwarded = up.receive_json(); assert forwarded == {"type": "rpc", "session": session, "payload": request}
        up.send_json({"type": "rpc", "session": session, "payload": {"id": "first", "result": {"turn": {"id": "turn-test"}}}})
        assert down.receive_json()["payload"]["id"] == "first"
        for method, params in [("item/agentMessage/delta", {"delta": private}), ("turn/diff/updated", {"diff": private})]:
            up.send_json({"type": "rpc", "session": session, "payload": {"method": method, "params": params}})
            assert down.receive_json()["payload"]["params"] == params
        approval = {"id": 7, "method": "item/commandExecution/requestApproval", "params": {"command": private}}
        up.send_json({"type": "rpc", "session": session, "payload": approval})
        assert down.receive_json()["payload"] == approval
        down.send_json({"type": "rpc", "payload": {"id": 7, "result": {"decision": "acceptForSession"}}})
        assert down.receive_json()["code"] == "invalid_decision"
        down.send_json({"type": "rpc", "payload": {"id": 7, "result": {"decision": "accept"}}})
        assert up.receive_json()["payload"] == {"id": 7, "result": {"decision": "accept"}}
        down.send_json({"type": "rpc", "payload": {"id": 7, "result": {"decision": "accept"}}})
        assert down.receive_json()["code"] == "approval_unavailable"
        down.send_json({"type": "rpc", "payload": {"id": 8, "method": "turn/interrupt",
            "params": {"threadId": "thread-test", "turnId": "turn-test"}}})
        assert up.receive_json()["payload"]["method"] == "turn/interrupt"
        up.send_json({"type": "rpc", "session": "wrong-device", "payload": {"id": 8, "result": {"ignored": True}}})
        up.send_json({"type": "rpc", "session": session, "payload": {"id": 8, "result": {}}})
        assert down.receive_json()["payload"] == {"id": 8, "result": {}}
    assert private not in (temp / "platform.db").read_bytes().decode("latin1")
    assert private not in client.get("/activity").text
    assert any(item.event == "remote_task_started" for item in app.state.platform.audit(ADMIN_ID))


def test_steering_roundtrip_and_required_active_turn(remote):
    client, app, creds, _, temp = remote
    with connected(client, creds) as (up, down, session):
        params = {"threadId": "thread-test", "expectedTurnId": "turn-test",
            "input": [{"type": "text", "text": "private-steer-sentinel"}]}
        down.send_json({"type": "rpc", "payload": {"id": "steer", "method": "turn/steer", "params": params}})
        assert up.receive_json()["payload"]["params"] == params
        up.send_json({"type": "rpc", "session": session, "payload": {"id": "steer", "result": {"turnId": "turn-test"}}})
        assert down.receive_json()["payload"]["result"]["turnId"] == "turn-test"
        for invalid in [{k: v for k, v in params.items() if k != "expectedTurnId"}, {**params, "model": "override"}]:
            with pytest.raises(ProtocolError):
                validate_request({"id": "invalid", "method": "turn/steer", "params": invalid})
    assert "private-steer-sentinel" not in (temp / "platform.db").read_bytes().decode("latin1")


def test_handoff_rpc_and_notification_roundtrip(remote):
    client, _, creds, _, _ = remote
    for params in ({}, {"threadId": "chat", "force": True}, {"threadId": False}):
        with pytest.raises(ProtocolError):
            validate_request({"id": "bad", "method": "lanpower/session/release", "params": params})
    with connected(client, creds) as (up, down, session):
        request = {"id": "release", "method": "lanpower/session/release", "params": {"threadId": "chat"}}
        down.send_json({"type": "rpc", "payload": request})
        assert up.receive_json()["payload"] == request
        notification = {"method": "lanpower/session/released", "params": {"threadId": "chat"}}
        up.send_json({"type": "rpc", "session": session, "payload": notification})
        assert down.receive_json()["payload"] == notification
        up.send_json({"type": "rpc", "session": session, "payload": {"id": "release", "result": {"released": True}}})
        assert down.receive_json()["payload"]["result"] == {"released": True}


def test_recent_sessions_do_not_require_workspace_filter():
    assert validate_request({"id": "recent", "method": "thread/list", "params": {"limit": 50}}) == "thread/list"


@pytest.mark.parametrize("method", ["command/exec", "account/login/start", "account/logout", "config/write", "fs/writeFile", "plugin/install"])
def test_forbidden_methods(remote, method):
    client, _, creds, _, _ = remote
    with connected(client, creds) as (_, down, _):
        down.send_json({"type": "rpc", "payload": {"id": 1, "method": method, "params": {}}})
        assert down.receive_json()["code"] == "method_not_allowed"


@pytest.mark.parametrize("headers", [{"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": ""}])
def test_cross_site_origin_rejected(remote, headers):
    client, _, creds, _, _ = remote
    with pytest.raises(WebSocketDisconnect):
        with browser(client, creds, **headers): pass


def test_no_auth_query_tokens_protocol_or_wrong_device(remote):
    client, _, creds, _, _ = remote
    for path, headers, protocols in [
        ("/api/v2/remote/agent", {}, PROTOCOL),
        ("/api/v2/remote/agent?token=not-allowed", {}, PROTOCOL),
        ("/api/v2/remote/agent", {"Authorization": "Bearer " + creds["access_token"]}, []),
        ("/api/v2/remote/client/other-device", {"Origin": "https://power.example.com"}, PROTOCOL),
    ]:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path, headers=headers, subprotocols=protocols): pass


def test_second_controller_and_revocation(remote):
    client, _, creds, csrf, _ = remote
    with connected(client, creds) as (up, down, _):
        with browser(client, creds) as other:
            assert other.receive_json()["code"] == "controller_busy"
        assert client.post(f"/devices/{creds['device_id']}/revoke", data={"csrf": csrf}).status_code == 200
        with pytest.raises(WebSocketDisconnect): down.receive_json()
        with pytest.raises(WebSocketDisconnect): up.receive_json()


def test_agent_replacement_and_offline_browser(remote):
    client, _, creds, _, _ = remote
    with agent(client, creds) as old:
        with agent(client, creds) as new:
            with pytest.raises(WebSocketDisconnect): old.receive_json()
            new.send_json({"type": "ping"}); assert new.receive_json() == {"type": "pong"}
    with browser(client, creds) as down:
        assert down.receive_json()["state"] == "cloud_offline"


def test_binary_frames_close_without_leaking_or_retaining_routes(remote):
    client, app, creds, _, _ = remote
    with connected(client, creds) as (_, down, _):
        down.send_bytes(b"binary-source-sentinel")
        with pytest.raises(WebSocketDisconnect): down.receive_json()
    assert not app.state.codex_relay.clients
    assert "binary-source-sentinel" not in client.get("/activity").text


def test_owner_isolation_and_pwa_no_code_cache(remote):
    from cloud_app.app.models import Device, User
    client, app, creds, _, _ = remote
    with app.state.platform.sessions.begin() as db:
        db.add(User(id="other-owner", username="other", password_hash="disabled", created_at=1))
        db.flush()
        db.get(Device, creds["device_id"]).owner_id = "other-owner"
    with pytest.raises(WebSocketDisconnect):
        with browser(client, creds): pass
    assert client.get("/api/v2/remote/status/" + creds["device_id"]).status_code == 404
    assert client.get("/remote").status_code == 200
    policy = client.get("/remote").headers["content-security-policy"]
    assert "manifest-src 'self'" in policy and "worker-src 'self'" in policy
    sw = client.get("/sw.js"); assert sw.headers["cache-control"] == "no-store"
    assert 'ASSETS.includes(url.pathname + url.search)' in sw.text
    assert client.get("/manifest.webmanifest").json()["start_url"] == "/remote"


@pytest.mark.parametrize("raw", ['{"type":"rpc","type":"ping"}', '{"type":"rpc","payload":NaN}',
    '{"type":"rpc","payload":' + '[' * 30 + '0' + ']' * 30 + '}', '[]'])
def test_malformed_frames(raw):
    with pytest.raises(ProtocolError): parse_frame(raw)


def test_sizes_backpressure_and_policy_overrides():
    with pytest.raises(ProtocolError): parse_frame(json.dumps({"type": "rpc", "payload": "a" * MAX_FRAME}))
    peer = Peer(None, "owner", "device")
    for _ in range(32): peer.send({"type": "ping"})
    with pytest.raises(ProtocolError): peer.send({"type": "ping"})
    for params in ({"cwd": "project", "approvalPolicy": "never"}, {"cwd": "project", "config": {}}, {"cwd": "project", "sandbox": "danger-full-access"}):
        with pytest.raises(ProtocolError): validate_request({"id": 1, "method": "thread/start", "params": params})
    with pytest.raises(ProtocolError): validate_request({"id": True, "method": "model/list", "params": {}})
    with pytest.raises(ProtocolError): validate_decision("item/permissions/requestApproval", {"permissions": {"fileSystem": {}}, "scope": "session"})
