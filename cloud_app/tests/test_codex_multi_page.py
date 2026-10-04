import json

import pytest
from starlette.websockets import WebSocketDisconnect

from cloud_app.app.remote import Peer, SharedSession
from cloud_app.tests.test_codex_remote import (remote, connected, browser, agent,
    phone_credentials, phone_socket)


def sync(socket):
    socket.send_json({"type": "ping"})
    assert socket.receive_json() == {"type": "pong"}


def test_same_ids_route_separately_and_closing_one_page_keeps_others(remote):
    client, app, creds, _, _ = remote
    phone = phone_credentials(client, app, ["codex"])
    with connected(client, creds) as (up, first, session):
        with browser(client, creds) as second:
            assert second.receive_json()["state"] == "runtime_ready"
            with phone_socket(client, creds["device_id"], phone) as mobile:
                assert mobile.receive_json()["state"] == "runtime_ready"
                sockets = [first, second, mobile]
                routes = []
                for socket in sockets:
                    socket.send_json({"type": "rpc", "payload": {"id": 1, "method": "lanpower/status", "params": {}}})
                    frame = up.receive_json()
                    assert frame["session"] == session
                    routes.append(frame["payload"]["id"])
                assert len(set(routes)) == 3
                for index in reversed(range(3)):
                    up.send_json({"type": "rpc", "session": session, "payload": {"id": routes[index], "result": {"page": index}}})
                for index, socket in enumerate(sockets):
                    assert socket.receive_json() == {"type": "rpc", "payload": {"id": 1, "result": {"page": index}}}
                    sync(socket)
                event = {"method": "turn/started", "params": {"threadId": "same-thread", "turn": {"id": "turn"}}}
                up.send_json({"type": "rpc", "session": session, "payload": event})
                for socket in sockets: assert socket.receive_json()["payload"] == event
            sync(up)  # Leaving the phone must not send close/open to the Host.
            sync(first); sync(second)
        sync(up); sync(first)
        group = app.state.codex_relay.clients[creds["device_id"]]
        assert group.session == session and len(group.peers) == 1 and not group.requests
        assert app.state.codex_relay.status(creds["device_id"])["busy"]
    assert not app.state.codex_relay.clients


def test_pending_approval_replayed_and_decided_only_once_across_pages(remote):
    client, _, creds, _, _ = remote
    with connected(client, creds) as (up, first, session):
        approval = {"id": "approval", "method": "item/fileChange/requestApproval", "params": {"threadId": "thread"}}
        up.send_json({"type": "rpc", "session": session, "payload": approval})
        assert first.receive_json()["payload"] == approval
        with browser(client, creds) as second:
            assert second.receive_json()["state"] == "runtime_ready"
            assert second.receive_json()["payload"] == approval
            decision = {"type": "rpc", "payload": {"id": "approval", "result": {"decision": "accept"}}}
            first.send_json(decision)
            assert up.receive_json()["payload"] == decision["payload"]
            second.send_json(decision)
            assert second.receive_json()["code"] == "approval_unavailable"
            up.send_json({"type": "rpc", "session": session, "payload": {"id": "approval", "error": {"message": "approval_unavailable"}}})
            assert first.receive_json()["payload"]["error"]["message"] == "approval_unavailable"
            second.send_json(decision)
            assert up.receive_json()["payload"] == decision["payload"]
            resolved = {"method": "serverRequest/resolved", "params": {"requestId": "approval"}}
            up.send_json({"type": "rpc", "session": session, "payload": resolved})
            for socket in (first, second): assert socket.receive_json()["payload"] == resolved
            first.send_json(decision)
            assert first.receive_json()["code"] == "approval_unavailable"


def test_chunks_with_colliding_client_ids_keep_body_and_destination(remote):
    client, app, creds, _, temp = remote
    sentinel = "multi-page-private-chunk-sentinel"
    with connected(client, creds) as (up, first, session):
        with browser(client, creds) as second:
            assert second.receive_json()["state"] == "runtime_ready"
            routes = []
            for socket in (first, second):
                socket.send_json({"type": "rpc", "payload": {"id": "same", "method": "thread/read", "params": {"threadId": "thread"}}})
                routes.append(up.receive_json()["payload"]["id"])
            bodies = [json.dumps({"id": route, "result": {"text": sentinel + str(index) + "中文🎨" * 20000}}, ensure_ascii=False) for index, route in enumerate(routes)]
            for index, socket in enumerate((first, second)):
                parts = [bodies[index][i:i + 16000] for i in range(0, len(bodies[index]), 16000)]
                received = []
                for part_index, data in enumerate(parts):
                    up.send_json({"type": "rpc_chunk", "session": session, "id": routes[index], "index": part_index, "count": len(parts), "data": data})
                    frame = socket.receive_json()
                    assert frame["id"] == "same" and frame["rpcId"] == routes[index]
                    received.append(frame["data"])
                assert "".join(received) == bodies[index]
                sync(socket)
            assert not app.state.codex_relay.clients[creds["device_id"]].requests
    assert sentinel not in (temp / "platform.db").read_bytes().decode("latin1")


def test_agent_replacement_restores_every_page_without_replaying_requests(remote):
    client, app, creds, _, _ = remote
    with connected(client, creds) as (old, first, session):
        with browser(client, creds) as second:
            assert second.receive_json()["state"] == "runtime_ready"
            first.send_json({"type": "rpc", "payload": {"id": "pending", "method": "thread/list", "params": {}}})
            old.receive_json()
            with agent(client, creds) as new:
                for socket in (first, second): assert socket.receive_json()["state"] == "runtime_starting"
                new.send_json({"type": "hello", "protocol": 1, "state": "host_ready"})
                assert new.receive_json() == {"type": "open", "session": session}
                for socket in (first, second): assert socket.receive_json()["state"] == "host_ready"
                new.send_json({"type": "state", "session": session, "state": "runtime_ready"})
                for socket in (first, second): assert socket.receive_json()["state"] == "runtime_ready"
                sync(new)
                assert not app.state.codex_relay.clients[creds["device_id"]].requests


def test_slow_page_backpressure_is_isolated():
    slow, fast = Peer(None, "owner", "device"), Peer(None, "owner", "device")
    group = SharedSession(peers={slow.session: slow, fast.session: fast})
    for _ in range(32): slow.send({"type": "ping"})
    group.broadcast({"type": "state", "state": "runtime_ready"})
    assert slow.failed.is_set() and not fast.failed.is_set()
    assert json.loads(fast.queue.get_nowait()[0])["state"] == "runtime_ready"


def test_revoking_phone_permission_leaves_browser_connected(remote):
    client, app, creds, csrf, _ = remote
    phone = phone_credentials(client, app, ["codex"])
    with connected(client, creds) as (up, web, session):
        with phone_socket(client, creds["device_id"], phone) as mobile:
            assert mobile.receive_json()["state"] == "runtime_ready"
            assert client.post("/clients/" + phone["client_id"] + "/permissions",
                data={"csrf": csrf, "allow_status": "on"}).status_code == 200
            mobile.send_json({"type": "rpc", "payload": {"id": 1, "method": "lanpower/status", "params": {}}})
            assert mobile.receive_json()["code"] == "remote_revoked"
            with pytest.raises(WebSocketDisconnect): mobile.receive_json()
        sync(up); sync(web)
        assert app.state.codex_relay.clients[creds["device_id"]].session == session
