"""Bounded, memory-only Codex relay. Never log messages or exception text."""
from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
import json
import re
import time
import uuid

import anyio

from fastapi import WebSocket, WebSocketDisconnect

from cloud_app.app.auth import current_session

MAX_FRAME = 1024 * 1024
MAX_PENDING = 64
MAX_RESULT = 16 * MAX_FRAME
FIELDS = {
    "lanpower/status": set(),
    "lanpower/chat/start": {"model"}, "skills/list": {"cwd"}, "lanpower/automations/list": set(),
    "lanpower/files/list": {"cwd", "path", "cursor"}, "lanpower/files/read": {"cwd", "path"},
    "lanpower/files/search": {"cwd", "query"},
    "lanpower/library/update": {"revision", "preferences"}, "lanpower/image/read": {"threadId", "path"},
    "lanpower/submission/read": {"threadId", "submissionId"}, "lanpower/history/item/read": {"threadId", "reference", "offset"},
    "plugin/list": {"cwd"}, "app/list": {"cursor", "limit", "threadId"}, "mcpServerStatus/list": {"cursor", "limit"},
    "config/mcpServer/reload": set(), "account/rateLimits/read": set(), "collaborationMode/list": set(),
    "lanpower/session/release": {"threadId"},
    "model/list": {"cursor", "limit"},
    "thread/list": {"cursor", "limit", "cwd", "archived"},
    "thread/start": {"cwd", "model"},
    "thread/resume": {"threadId"},
    "thread/read": {"threadId", "includeTurns", "historyLimit"},
    "thread/turns/list": {"threadId", "cursor", "limit"},
    "thread/fork": {"threadId"},
    "thread/rollback": {"threadId", "numTurns"},
    "thread/name/set": {"threadId", "name"},
    "thread/archive": {"threadId"},
    "thread/unarchive": {"threadId"},
    "thread/queue/add": {"threadId", "input", "clientUserMessageId", "submissionId"},
    "thread/queue/list": {"threadId", "cursor", "limit"},
    "thread/queue/update": {"threadId", "queuedSubmissionId", "input", "submissionId"},
    "thread/queue/delete": {"threadId", "queuedSubmissionId"},
    "thread/queue/start": {"threadId", "queuedSubmissionId"},
    "thread/queue/reorder": {"threadId", "queuedSubmissionIds"},
    "turn/start": {"threadId", "input", "model", "effort", "mode", "submissionId"},
    "turn/interrupt": {"threadId", "turnId"},
    "turn/steer": {"threadId", "expectedTurnId", "input", "submissionId"},
}
APPROVALS = {
    "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
    "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request",
}
STATES = {"host_offline", "disabled", "host_ready", "runtime_starting", "runtime_ready", "runtime_error"}


class ProtocolError(ValueError):
    def __init__(self, code: str = "invalid_frame"):
        super().__init__(code)


def rpc_id(payload: dict) -> str:
    value = payload.get("id")
    if not (isinstance(value, str) and 1 <= len(value) <= 100 or
            type(value) is int and abs(value) <= 2**53 - 1):
        raise ProtocolError()
    return json.dumps(value, ensure_ascii=True)


def parse_frame(raw: str) -> dict:
    if len(raw.encode("utf-8")) > MAX_FRAME:
        raise ProtocolError("frame_too_large")
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ProtocolError()
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ProtocolError()))
    except (ValueError, RecursionError):
        raise ProtocolError() from None
    def depth(item, level=0):
        if level > 24:
            raise ProtocolError()
        if isinstance(item, dict):
            for child in item.values(): depth(child, level + 1)
        elif isinstance(item, list):
            for child in item: depth(child, level + 1)
    depth(value)
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise ProtocolError()
    return value


def validate_request(payload: dict) -> str:
    if not isinstance(payload, dict) or set(payload) != {"id", "method", "params"}:
        raise ProtocolError()
    rpc_id(payload)
    method, params = payload["method"], payload["params"]
    if not isinstance(method, str) or method not in FIELDS:
        raise ProtocolError("method_not_allowed")
    if not isinstance(params, dict) or set(params) - FIELDS[method]:
        raise ProtocolError("params_not_allowed")
    if method.startswith("thread/") and method not in {"thread/list", "thread/start"} or method.startswith("turn/") or method == "lanpower/session/release":
        if not isinstance(params.get("threadId"), str) or not 1 <= len(params["threadId"]) <= 100:
            raise ProtocolError()
    for key in ("cwd", "path", "query", "model", "cursor", "name", "effort", "turnId", "expectedTurnId"):
        if key in params and (not isinstance(params[key], str) or not 1 <= len(params[key]) <= 1000):
            raise ProtocolError()
    if "threadId" in params and (not isinstance(params["threadId"],str) or not 1 <= len(params["threadId"]) <= 100): raise ProtocolError()
    if "limit" in params and (type(params["limit"]) is not int or not 1 <= params["limit"] <= 50):
        raise ProtocolError()
    if "historyLimit" in params and (type(params["historyLimit"]) is not int or not 1 <= params["historyLimit"] <= 8): raise ProtocolError()
    if "submissionId" in params and (not isinstance(params["submissionId"], str) or not 1 <= len(params["submissionId"]) <= 100): raise ProtocolError()
    if method == "lanpower/submission/read" and not {"threadId", "submissionId"} <= params.keys(): raise ProtocolError()
    if method == "lanpower/history/item/read" and (not isinstance(params.get("threadId"), str) or not isinstance(params.get("reference"), str) or not 1 <= len(params["reference"]) <= 100 or type(params.get("offset")) is not int or not 0 <= params["offset"] <= 64 * 1024 * 1024): raise ProtocolError()
    if method == "thread/rollback" and (type(params.get("numTurns")) is not int or not 1 <= params["numTurns"] <= 100000):
        raise ProtocolError()
    if method.startswith("lanpower/files/"):
        if not isinstance(params.get("cwd"), str) or not params["cwd"]: raise ProtocolError()
        if method == "lanpower/files/read" and (not isinstance(params.get("path"), str) or not params["path"]): raise ProtocolError()
        if method == "lanpower/files/search" and (not isinstance(params.get("query"), str) or not 1 <= len(params["query"]) <= 256): raise ProtocolError()
    if method == "lanpower/image/read" and (not isinstance(params.get("threadId"), str) or not 1 <= len(params["threadId"]) <= 100 or not isinstance(params.get("path"), str) or not params["path"]): raise ProtocolError()
    if method == "lanpower/library/update":
        if type(params.get("revision")) is not int or not 0 <= params["revision"] < 2**53 - 1: raise ProtocolError()
        prefs = params.get("preferences")
        if not isinstance(prefs, dict) or len(json.dumps(prefs).encode()) > 128 * 1024 or set(prefs) - {"collapsed", "pinned", "hidden", "order", "aliases", "sections", "sort", "chatsFirst"}: raise ProtocolError()
        for key in ("collapsed", "pinned", "hidden", "order"):
            values = prefs.get(key, [])
            if not isinstance(values, list) or len(values) > (64 if key == "pinned" else 1024) or any(not isinstance(v, str) or not 1 <= len(v) <= (100 if key == "pinned" else 1000) for v in values) or len(set(values)) != len(values): raise ProtocolError()
        aliases = prefs.get("aliases", {})
        if not isinstance(aliases, dict) or len(aliases) > 1024 or any(not 1 <= len(k) <= 1000 or not isinstance(v, str) or not 1 <= len(v) <= 120 for k, v in aliases.items()): raise ProtocolError()
        sections = prefs.get("sections", {})
        if not isinstance(sections, dict) or set(sections) - {"projects", "chats", "pinned"} or any(type(v) is not bool for v in sections.values()): raise ProtocolError()
        if prefs.get("sort", "updated") not in ("updated", "created") or type(prefs.get("chatsFirst", False)) is not bool: raise ProtocolError()
    if "mode" in params and params["mode"] not in ("default", "plan"): raise ProtocolError()
    for key in ("includeTurns", "archived"):
        if key in params and type(params[key]) is not bool: raise ProtocolError()
    if method == "turn/interrupt" and "turnId" not in params: raise ProtocolError()
    if method == "turn/steer" and "expectedTurnId" not in params: raise ProtocolError()
    for key, required in (("clientUserMessageId", method == "thread/queue/add"),
                          ("queuedSubmissionId", method in {"thread/queue/update", "thread/queue/delete", "thread/queue/start"})):
        if required or key in params:
            if not isinstance(params.get(key), str) or not 1 <= len(params[key]) <= 100: raise ProtocolError()
    if method == "thread/queue/reorder":
        ids = params.get("queuedSubmissionIds")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 32 or any(not isinstance(i, str) or not 1 <= len(i) <= 100 for i in ids) or len(set(ids)) != len(ids):
            raise ProtocolError()
    if method in {"turn/start", "turn/steer", "thread/queue/add", "thread/queue/update"}:
        inputs = params.get("input")
        if not isinstance(inputs, list) or not 1 <= len(inputs) <= 13:
            raise ProtocolError()
        text_count = image_count = image_bytes = skill_count = 0
        for item in inputs:
            if not isinstance(item, dict): raise ProtocolError()
            if item.get("type") == "skill":
                skill_count += 1
                if set(item) != {"type", "name", "path"} or skill_count > 8 or not isinstance(item["name"], str) or not 1 <= len(item["name"]) <= 120 or not isinstance(item["path"], str) or not 1 <= len(item["path"]) <= 1000: raise ProtocolError()
            elif item.get("type") == "text":
                text_count += 1
                if set(item) != {"type", "text"} or text_count > 1 or not isinstance(item["text"], str) or not 1 <= len(item["text"]) <= 16000: raise ProtocolError()
            elif item.get("type") == "image":
                image_count += 1
                url = item.get("url")
                if set(item) != {"type", "url"} or not isinstance(url, str) or not 1 <= len(url) <= 700000: raise ProtocolError()
                image_bytes += len(url)
                if image_count > 4 or image_bytes > 850000 or re.fullmatch(r"data:image/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}", url) is None: raise ProtocolError()
            else: raise ProtocolError()
    return method


def validate_decision(method: str, result: dict):
    if not isinstance(result, dict): raise ProtocolError("invalid_decision")
    if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
        if set(result) != {"decision"} or result["decision"] not in ("accept", "decline", "cancel"):
            raise ProtocolError("invalid_decision")
    elif method == "item/permissions/requestApproval":
        permissions = result.get("permissions")
        if (set(result) - {"permissions", "scope"} or result.get("scope", "turn") != "turn" or
                not isinstance(permissions, dict) or set(permissions) - {"network"} or
                "network" in permissions and permissions["network"] != {"enabled": True}):
            raise ProtocolError("invalid_decision")
    elif method == "item/tool/requestUserInput":
        if set(result) != {"answers"} or not isinstance(result["answers"], dict) or len(result["answers"]) > 20:
            raise ProtocolError("invalid_decision")
        for entry in result["answers"].values():
            if (not isinstance(entry, dict) or set(entry) != {"answers"} or not isinstance(entry["answers"], list) or
                    len(entry["answers"]) > 20 or any(not isinstance(text, str) or len(text) > 4000 for text in entry["answers"])):
                raise ProtocolError("invalid_decision")
    elif set(result) != {"action", "content"} or result["action"] not in ("decline", "cancel") or result["content"] is not None:
        raise ProtocolError("invalid_decision")


@dataclass(eq=False)
class Peer:
    socket: WebSocket
    owner: str
    device: str
    session: str = field(default_factory=lambda: str(uuid.uuid4()))
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))
    queued_bytes: int = 0
    requests: dict[str, tuple[str, float]] = field(default_factory=dict)
    last_seen: float = field(default_factory=time.monotonic)
    incoming: list[float] = field(default_factory=list)
    fragments: dict[str, tuple[int, int, int]] = field(default_factory=dict)
    drained: asyncio.Event = field(default_factory=asyncio.Event)
    failed: asyncio.Event = field(default_factory=asyncio.Event)

    async def wait_for_capacity(self):
        while self.queued_bytes > 2 * MAX_FRAME or self.queue.qsize() >= 16:
            self.drained.clear()
            await asyncio.wait_for(self.drained.wait(), 10)

    def send(self, payload: dict):
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        size = len(raw.encode("utf-8"))
        if size > MAX_FRAME or self.queued_bytes + size > 8 * MAX_FRAME:
            raise ProtocolError("remote_backpressure")
        try: self.queue.put_nowait((raw, size))
        except asyncio.QueueFull: raise ProtocolError("remote_backpressure") from None
        self.queued_bytes += size

    async def write(self):
        while True:
            raw, size = await self.queue.get()
            self.queued_bytes -= size
            self.drained.set()
            await asyncio.wait_for(self.socket.send_text(raw), 10)


def deliver(peer: Peer, payload: dict):
    # A slow page must not tear down the Agent or the other authorized pages.
    if peer.failed.is_set(): return
    try: peer.send(payload)
    except ProtocolError: peer.failed.set()


@dataclass
class SharedSession:
    session: str = field(default_factory=lambda: str(uuid.uuid4()))
    peers: dict[str, Peer] = field(default_factory=dict)
    requests: dict[str, tuple[Peer, str | int]] = field(default_factory=dict)
    approvals: dict[str, dict] = field(default_factory=dict)
    deciding: dict[str, Peer] = field(default_factory=dict)
    approval_bytes: int = 0

    def broadcast(self, payload: dict):
        for peer in tuple(self.peers.values()): deliver(peer, payload)

    def clear(self):
        self.requests.clear(); self.approvals.clear(); self.deciding.clear(); self.approval_bytes = 0
        for peer in self.peers.values(): peer.requests.clear(); peer.fragments.clear()


class CodexRelay:
    def __init__(self, platform):
        self.platform = platform
        self.agents: dict[str, Peer] = {}
        self.clients: dict[str, SharedSession] = {}
        self.states: dict[str, str] = {}

    def status(self, device: str) -> dict:
        return {"state": self.states.get(device, "cloud_offline"),
                "connected": device in self.agents, "busy": device in self.clients}

    def audit(self, peer: Peer, event: str):
        self.platform.record(peer.owner, event, peer.device)

    async def revoke(self, device: str):
        shared = self.clients.get(device)
        for peer in (self.agents.get(device), *(tuple(shared.peers.values()) if shared else ())):
            if peer:
                with suppress(RuntimeError, anyio.ClosedResourceError, anyio.BrokenResourceError): await peer.socket.close(4403)

    async def shutdown(self):
        for device in list(set(self.agents) | set(self.clients)): await self.revoke(device)

    async def serve(self, socket: WebSocket, agent: bool, device: str = "", *, mobile: bool = False):
        # No tokens in query strings, no cross-site cookies, no protocol downgrade.
        if socket.query_params or socket.headers.get("sec-websocket-protocol") != "lanpower.codex.v1":
            await socket.close(4400); return
        try:
            if agent:
                if socket.headers.get("origin"):
                    raise PermissionError()
                auth = socket.headers.get("authorization", "")
                if not auth.startswith("Bearer "): raise PermissionError()
                owner, device = self.platform.tokens.authorize(auth[7:], expected_type="windows")
                valid = lambda: self.platform.tokens.authorize(auth[7:], expected_type="windows") == (owner, device)
            elif mobile:
                # Native mini-program sockets use an explicit bearer credential;
                # browser cookies and Origin never grant access to this endpoint.
                auth = socket.headers.get("authorization", "")
                if not auth.startswith("Bearer "): raise PermissionError()
                owner, client_id = self.platform.mobile.authorize(auth[7:])
                def mobile_valid():
                    return (self.platform.mobile.authorize(auth[7:]) == (owner, client_id) and
                            self.platform.mobile.permits(client_id, "codex") and
                            (target := self.platform.device(owner, device)) is not None and
                            target.device_type == "windows")
                valid = mobile_valid
                if not valid(): raise PermissionError()
            else:
                if socket.headers.get("origin") not in self.platform.settings.browser_origins: raise PermissionError()
                def session():
                    with self.platform.sessions() as db: return current_session(socket, db)
                identity = session()
                if identity is None: raise PermissionError()
                owner = identity.owner_id
                target = self.platform.device(owner, device)
                if target is None or target.device_type != "windows": raise PermissionError()
                valid = lambda: (session() is not None and self.platform.device(owner, device) is not None)
        except (PermissionError, ValueError):
            await socket.close(4403); return
        await socket.accept(subprotocol="lanpower.codex.v1", headers=[(b"cache-control", b"no-store")])
        peer = Peer(socket, owner, device)
        if agent:
            old = self.agents.get(device)
            self.agents[device] = peer
            if old:
                with suppress(RuntimeError, anyio.ClosedResourceError, anyio.BrokenResourceError): await old.socket.close(4410)
            self.states[device] = "host_offline"
            if shared := self.clients.get(device):
                shared.clear()
                shared.broadcast({"type": "state", "state": "runtime_starting"})
        else:
            first = device not in self.clients
            shared = self.clients.setdefault(device, SharedSession())
            shared.peers[peer.session] = peer
            peer.send({"type": "state", "state": self.status(device)["state"]})
            if first and (upstream := self.agents.get(device)):
                upstream.send({"type": "open", "session": shared.session})
        self.audit(peer, "remote_connected")

        async def monitor():
            while True:
                await asyncio.sleep(5)
                try: authorized = valid()
                except PermissionError: authorized = False
                if not authorized: raise ProtocolError("remote_revoked")
                now = time.monotonic()
                if now - peer.last_seen > 90: raise ProtocolError("remote_timeout")
                if now - peer.last_seen > 30: peer.send({"type": "ping"})
                if any(now - started > 120 for _, started in peer.requests.values()):
                    raise ProtocolError("request_timeout")

        async def read():
            if not agent:
                # Replay only still-pending approvals, without reopening the Host.
                for key, approval in tuple(shared.approvals.items()):
                    await peer.wait_for_capacity()
                    if shared.approvals.get(key) is approval: deliver(peer, {"type": "rpc", "payload": approval})
            while True:
                try: raw = await socket.receive_text()
                except KeyError: raise ProtocolError("invalid_frame") from None
                peer.last_seen = time.monotonic()
                try:
                    message = parse_frame(raw)
                    if message == {"type": "pong"}: continue
                    if message == {"type": "ping"}: peer.send({"type": "pong"}); continue
                    if agent:
                        if message["type"] == "rpc_chunk" and (group := self.clients.get(device)):
                            route = group.requests.get(rpc_id(message))
                            if route and not route[0].failed.is_set():
                                try: await route[0].wait_for_capacity()
                                except asyncio.TimeoutError: route[0].failed.set()
                        self.from_agent(peer, message)
                    else:
                        if not valid(): raise ProtocolError("remote_revoked")
                        now = time.monotonic()
                        peer.incoming = [stamp for stamp in peer.incoming if now - stamp < 10]
                        if len(peer.incoming) >= 120: raise ProtocolError("rate_limited")
                        peer.incoming.append(now)
                        self.from_client(peer, message)
                except ProtocolError as error:
                    peer.send({"type": "error", "code": str(error)})
                    if str(error) in {"frame_too_large", "remote_backpressure", "remote_revoked", "rate_limited"}: raise

        async def failed():
            await peer.failed.wait()
            raise ProtocolError("remote_backpressure")

        tasks = [asyncio.create_task(fn()) for fn in (peer.write, read, monitor, failed)]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done: task.result()
        except asyncio.CancelledError:
            pass
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError, ProtocolError,
                anyio.ClosedResourceError, anyio.BrokenResourceError):
            # Record a fixed category only; never exception text or frame content.
            self.audit(peer, "remote_disconnected")
        finally:
            # TestClient and ASGI servers can cancel the endpoint on disconnect.
            # Shield cleanup so cancelled sockets never retain routes or payloads.
            with anyio.CancelScope(shield=True):
                if agent and self.agents.get(device) is peer:
                    self.agents.pop(device, None); self.states.pop(device, None)
                    if group := self.clients.get(device):
                        group.clear()
                        group.broadcast({"type": "state", "state": "cloud_offline"})
                elif not agent and (group := self.clients.get(device)) and group.peers.get(peer.session) is peer:
                    group.peers.pop(peer.session)
                    for key, route in tuple(group.requests.items()):
                        if route[0] is peer: group.requests.pop(key)
                    if not group.peers:
                        self.clients.pop(device, None)
                        group.clear()
                        if upstream := self.agents.get(device):
                            with suppress(ProtocolError): upstream.send({"type": "close", "session": group.session})
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                peer.requests.clear(); peer.fragments.clear()
                with suppress(RuntimeError, anyio.ClosedResourceError, anyio.BrokenResourceError): await socket.close(1000)

    def from_client(self, peer: Peer, frame: dict):
        if set(frame) != {"type", "payload"} or frame["type"] != "rpc": raise ProtocolError()
        upstream = self.agents.get(peer.device)
        if upstream is None: raise ProtocolError("agent_offline")
        shared = self.clients.get(peer.device)
        if shared is None or shared.peers.get(peer.session) is not peer: raise ProtocolError("remote_revoked")
        payload = frame["payload"]
        if not isinstance(payload, dict): raise ProtocolError()
        key = rpc_id(payload)
        if "method" in payload:
            method = validate_request(payload)
            if key in peer.requests or key in shared.approvals or len(shared.requests) >= MAX_PENDING: raise ProtocolError("request_busy")
            peer.requests[key] = (method, time.monotonic())
            wire_id = "r-" + uuid.uuid4().hex
            wire_key = rpc_id({"id": wire_id})
            shared.requests[wire_key] = (peer, payload["id"])
            forwarded = {**payload, "id": wire_id}
        else:
            if set(payload) != {"id", "result"} or key not in shared.approvals or key in shared.deciding: raise ProtocolError("approval_unavailable")
            validate_decision(shared.approvals[key]["method"], payload["result"])
            shared.deciding[key] = peer
            forwarded = payload
            method = "approval"
        try: upstream.send({"type": "rpc", "session": shared.session, "payload": forwarded})
        except ProtocolError:
            if method == "approval": shared.deciding.pop(key, None)
            else: peer.requests.pop(key, None); shared.requests.pop(wire_key, None)
            raise
        if method in {"turn/start", "turn/interrupt", "approval"}:
            self.audit(peer, {"turn/start": "remote_task_started", "turn/interrupt": "remote_interrupted",
                              "approval": "remote_approval_decided"}[method])

    def from_agent(self, peer: Peer, frame: dict):
        if self.agents.get(peer.device) is not peer: raise ProtocolError("agent_replaced")
        kind = frame["type"]
        if kind == "hello":
            if set(frame) != {"type", "protocol", "state"} or frame["protocol"] != 1 or frame["state"] not in STATES:
                raise ProtocolError()
            self.states[peer.device] = frame["state"]
            if shared := self.clients.get(peer.device):
                shared.clear()
                shared.broadcast({"type": "state", "state": frame["state"]})
                peer.send({"type": "open", "session": shared.session})
            return
        shared = self.clients.get(peer.device)
        if shared is None or frame.get("session") != shared.session: return
        if kind == "rpc_chunk":
            if set(frame) != {"type", "session", "id", "index", "count", "data"}: raise ProtocolError()
            key = rpc_id(frame)
            route = shared.requests.get(key)
            if route is None: return
            client, original = route
            index, count, data = frame["index"], frame["count"], frame["data"]
            if (type(index) is not int or type(count) is not int or not 1 <= count <= 512 or
                    not 0 <= index < count or not isinstance(data, str) or not 1 <= len(data) <= 65536):
                raise ProtocolError("invalid_chunk")
            previous_index, previous_count, size = client.fragments.get(key, (0, count, 0))
            size += len(data.encode("utf-8"))
            if index != previous_index or count != previous_count or size > MAX_RESULT or (key not in client.fragments and len(client.fragments) >= 4):
                raise ProtocolError("invalid_chunk")
            deliver(client, {**{k: v for k, v in frame.items() if k != "session"}, "id": original, "rpcId": frame["id"]})
            if index + 1 == count:
                client.fragments.pop(key, None); client.requests.pop(rpc_id({"id": original}), None); shared.requests.pop(key)
            else: client.fragments[key] = (index + 1, count, size)
            return
        if kind == "state":
            if set(frame) != {"type", "session", "state"} or frame["state"] not in STATES: raise ProtocolError()
            self.states[peer.device] = frame["state"]
            if frame["state"] != "runtime_ready": shared.clear()
            shared.broadcast({"type": "state", "state": frame["state"]}); return
        if kind != "rpc" or set(frame) != {"type", "session", "payload"} or not isinstance(frame["payload"], dict):
            raise ProtocolError()
        payload = frame["payload"]
        if "id" in payload:
            key = rpc_id(payload)
            if "method" in payload:
                if (payload["method"] not in APPROVALS or key in shared.requests or
                        len(shared.approvals) >= MAX_PENDING and key not in shared.approvals): raise ProtocolError()
                if set(payload) != {"id", "method", "params"} or not isinstance(payload["params"], dict): raise ProtocolError()
                previous = shared.approvals.get(key)
                size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
                old_size = len(json.dumps(previous, ensure_ascii=False).encode("utf-8")) if previous else 0
                if shared.approval_bytes + size - old_size > 8 * MAX_FRAME: raise ProtocolError("remote_backpressure")
                shared.approval_bytes += size - old_size
                shared.approvals[key] = payload
                shared.broadcast({"type": "rpc", "payload": payload}); return
            elif route := shared.requests.pop(key, None):
                client, original = route
                client.requests.pop(rpc_id({"id": original}), None); client.fragments.pop(key, None)
                deliver(client, {"type": "rpc", "payload": {**payload, "id": original}}); return
            elif key in shared.deciding and "error" in payload:
                deliver(shared.deciding.pop(key), {"type": "rpc", "payload": payload}); return
            else: return
        elif payload.get("method") == "serverRequest/resolved":
            request = payload.get("params", {}).get("requestId")
            if request is not None:
                key = rpc_id({"id": request})
                previous = shared.approvals.pop(key, None); shared.deciding.pop(key, None)
                if previous: shared.approval_bytes -= len(json.dumps(previous, ensure_ascii=False).encode("utf-8"))
        shared.broadcast({"type": "rpc", "payload": payload})
