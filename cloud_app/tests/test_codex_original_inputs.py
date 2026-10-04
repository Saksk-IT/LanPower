import json
import hashlib

import pytest

from cloud_app.app.remote import ProtocolError, RequestUploads, parse_frame
from cloud_app.tests.test_codex_remote import remote, connected


def upload_frames(payload):
    raw = json.dumps({"type": "rpc", "payload": payload}, ensure_ascii=False)
    count = (len(raw) + 16383) // 16384
    return [{"type": "rpc_upload", "id": payload["id"], "index": i, "count": count,
             "data": raw[i * 16384:(i + 1) * 16384]} for i in range(count)]


def test_original_many_images_long_text_and_skills_survive_real_relay(remote):
    client, app, creds, _, temp = remote
    sentinel = "original-input-memory-only-sentinel"
    inputs = [{"type": "text", "text": "中🎨" * 20000 + sentinel}]
    inputs += [{"type": "image", "url": "data:image/png;base64," + "A" * 900000} for _ in range(10)]
    inputs += [{"type": "skill", "name": "skill" + str(i), "path": "D:/Skill/" + str(i)} for i in range(20)]
    request = {"id": "original", "method": "turn/start", "params": {"threadId": "chat", "input": inputs}}
    with connected(client, creds) as (up, down, session):
        frames = upload_frames(request)
        for frame in frames[:-1]: down.send_json(frame)
        # Ping is an ordering barrier. No runtime dispatch before the final piece.
        down.send_json({"type": "ping"}); assert down.receive_json() == {"type": "pong"}
        assert not app.state.codex_relay.clients[creds["device_id"]].requests
        down.send_json(frames[-1])
        assembled = []
        while True:
            part = up.receive_json()
            assert part["type"] == "rpc_upload" and part["session"] == session
            assert part["index"] == len(assembled)
            parse_frame(json.dumps(part, ensure_ascii=False))
            assembled.append(part["data"])
            if len(assembled) == part["count"]: break
        forwarded = json.loads("".join(assembled))
        assert forwarded["payload"]["params"] == request["params"]
        up.send_json({"type": "rpc", "session": session, "payload": {"id": forwarded["payload"]["id"], "result": {"accepted": True}}})
        assert down.receive_json()["payload"] == {"id": "original", "result": {"accepted": True}}
        peer = next(iter(app.state.codex_relay.clients[creds["device_id"]].peers.values()))
        assert not peer.uploads.parts and not peer.requests
    assert sentinel not in (temp / "platform.db").read_bytes().decode("latin1")


def test_response_beyond_16mb_and_512_chunks_is_not_truncated(remote):
    client, _, creds, _, _ = remote
    with connected(client, creds) as (up, down, session):
        down.send_json({"type": "rpc", "payload": {"id": "large", "method": "lanpower/status", "params": {}}})
        wire = up.receive_json()["payload"]["id"]
        body = json.dumps({"id": wire, "result": {"text": "x" * (17 * 1024 * 1024)}})
        pieces = [body[i:i+32768] for i in range(0, len(body), 32768)]
        assert len(pieces) > 512
        result = hashlib.sha256()
        for i, piece in enumerate(pieces):
            up.send_json({"type": "rpc_chunk", "session": session, "id": wire, "index": i, "count": len(pieces), "data": piece})
            part = down.receive_json(); assert part["id"] == "large" and part["index"] == i
            result.update(part["data"].encode())
        assert result.digest() == hashlib.sha256(body.encode()).digest()


@pytest.mark.parametrize("change", ["sequence", "count", "identity", "duplicate_keys"])
def test_request_fragments_never_dispatch_malformed_requests(change):
    request = {"id": "rpc", "method": "turn/start", "params": {"threadId": "chat", "input": [{"type": "text", "text": "x" * 100000}]}}
    parts = upload_frames(request)
    uploads = RequestUploads()
    if change == "sequence": parts[0]["index"] = 1
    elif change == "count": parts[1]["count"] += 1
    elif change == "identity":
        for part in parts: part["id"] = "different"
    else:
        parts = [{"type": "rpc_upload", "id": "rpc", "index": 0, "count": 1,
                  "data": '{"type":"rpc","type":"rpc","payload":{"id":"rpc"}}'}]
    with pytest.raises(ProtocolError):
        for part in parts: uploads.accept(part)
    assert not uploads.parts


def test_upload_without_message_ceiling_and_abandoned_upload_expiration():
    request = {"id": "huge", "method": "turn/start", "params": {"threadId": "chat", "input": [{"type": "image", "url": "data:image/png;base64," + "A" * (28 * 1024 * 1024)}]}}
    parts = upload_frames(request); uploads = RequestUploads()
    for part in parts: result = uploads.accept(part)
    assert result["payload"] == request and not uploads.parts
    assert uploads.accept(parts[0]) is None
    key = next(iter(uploads.parts)); count, values, updated = uploads.parts[key]
    uploads.parts[key] = count, values, updated - 301
    uploads.expire(); assert not uploads.parts
