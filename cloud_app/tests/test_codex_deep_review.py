import pytest

from cloud_app.app.remote import ProtocolError, validate_request
from cloud_app.tests.test_codex_remote import remote, connected, browser


@pytest.mark.parametrize("character", ["x", "中", "🎨"])
def test_long_input_keeps_unicode_validation(character):
    def request(text):
        return {"id": "send", "method": "turn/start", "params": {"threadId": "chat", "input": [{"type": "text", "text": text}]}}
    assert validate_request(request(character * 16000)) == "turn/start"
    assert validate_request(request(character * 100000)) == "turn/start"
    with pytest.raises(ProtocolError): validate_request(request("\ud800"))


def test_validation_rejection_is_correlated_and_does_not_touch_another_page(remote):
    client, app, creds, _, _ = remote
    with connected(client, creds) as (up, first, session):
        with browser(client, creds) as second:
            assert second.receive_json()["state"] == "runtime_ready"
            second.send_json({"type": "rpc", "payload": {"id": 1, "method": "lanpower/status", "params": {}}})
            routed = up.receive_json()
            first.send_json({"type": "rpc", "payload": {"id": 1, "method": "turn/start", "params": {
                    "threadId": "chat", "input": [{"type": "text", "text": None}]}}})
            rejected = first.receive_json()
            assert rejected["type"] == "rpc" and rejected["payload"]["id"] == 1
            assert rejected["payload"]["error"] == {"code": -32602, "message": "invalid_params", "data": {"notSent": True}}
            up.send_json({"type": "rpc", "session": session, "payload": {"id": routed["payload"]["id"], "result": {"ok": True}}})
            assert second.receive_json()["payload"] == {"id": 1, "result": {"ok": True}}
            first.send_json({"type": "ping"})
            assert first.receive_json() == {"type": "pong"}


def test_targeted_history_and_metadata_methods_keep_strict_fields():
    def check(method, params): return validate_request({"id": "rpc", "method": method, "params": params})
    assert check("lanpower/history/action", {"threadId": "chat", "turnId": "turn-1", "expectedTailTurnId": "turn-180", "action": "fork"})
    assert check("lanpower/library/list", {"query": "项目", "archived": False, "refresh": True, "limit": 50})
    assert check("lanpower/library/check", {"threadIds": ["chat-150"], "archived": False})
    with pytest.raises(ProtocolError): check("lanpower/history/action", {"threadId": "chat", "turnId": "turn-1", "expectedTailTurnId": "turn-180", "action": "delete"})
    with pytest.raises(ProtocolError): check("lanpower/library/check", {"threadIds": ["x"] * 257})
    with pytest.raises(ProtocolError): check("lanpower/library/list", {"refresh": "true"})


def test_many_original_images_and_large_queue_can_be_submitted():
    payload = {"id": "send", "method": "turn/start", "params": {"threadId": "chat", "input": [
        {"type": "image", "url": "data:image/png;base64," + "A" * 220000} for _ in range(10)]}}
    assert validate_request(payload)
    payload = {"id": "sort", "method": "thread/queue/reorder", "params": {"threadId": "chat", "queuedSubmissionIds": [str(i) for i in range(33)]}}
    assert validate_request(payload)
