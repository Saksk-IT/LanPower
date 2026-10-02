"""Bounded, memory-only Codex relay. Never log messages or exception text."""
from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
import json
import time
import uuid

import anyio

from fastapi import WebSocket, WebSocketDisconnect

from cloud_app.app.auth import current_session

MAX_FRAME = 1024 * 1024
MAX_PENDING = 64
FIELDS = {
    "lanpower/status": set(),
    "lanpower/session/release": {"threadId"},
    "model/list": {"cursor", "limit"},
    "thread/list": {"cursor", "limit", "cwd", "archived"},
    "thread/start": {"cwd", "model"},
    "thread/resume": {"threadId"},
    "thread/read": {"threadId", "includeTurns"},
    "thread/name/set": {"threadId", "name"},
    "thread/archive": {"threadId"},
    "thread/unarchive": {"threadId"},
    "turn/start": {"threadId", "input", "model", "effort"},
    "turn/interrupt": {"threadId", "turnId"},
    "turn/steer": {"threadId", "expectedTurnId", "input"},
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
    for key in ("cwd", "model", "cursor", "name", "effort", "turnId", "expectedTurnId"):
        if key in params and (not isinstance(params[key], str) or not 1 <= len(params[key]) <= 1000):
            raise ProtocolError()
    if "limit" in params and (type(params["limit"]) is not int or not 1 <= params["limit"] <= 50):
        raise ProtocolError()
    for key in ("includeTurns", "archived"):
        if key in params and type(params[key]) is not bool: raise ProtocolError()
    if method == "turn/interrupt" and "turnId" not in params: raise ProtocolError()
    if method == "turn/steer" and "expectedTurnId" not in params: raise ProtocolError()
    if method in {"turn/start", "turn/steer"}:
        inputs = params.get("input")
        if (not isinstance(inputs, list) or len(inputs) != 1 or not isinstance(inputs[0], dict) or
                set(inputs[0]) != {"type", "text"} or inputs[0]["type"] != "text" or
                not isinstance(inputs[0]["text"], str) or not 1 <= len(inputs[0]["text"]) <= 16000):
            raise ProtocolError()
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
    approvals: dict[str, str] = field(default_factory=dict)
    deciding: set[str] = field(default_factory=set)
    last_seen: float = field(default_factory=time.monotonic)
    incoming: list[float] = field(default_factory=list)

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
            await asyncio.wait_for(self.socket.send_text(raw), 10)


class CodexRelay:
    def __init__(self, platform):
        self.platform = platform
        self.agents: dict[str, Peer] = {}
        self.clients: dict[str, Peer] = {}
        self.states: dict[str, str] = {}

    def status(self, device: str) -> dict:
        return {"state": self.states.get(device, "cloud_offline"),
                "connected": device in self.agents, "busy": device in self.clients}

    def audit(self, peer: Peer, event: str):
        self.platform.record(peer.owner, event, peer.device)

    async def revoke(self, device: str):
        for peer in (self.agents.get(device), self.clients.get(device)):
            if peer:
                with suppress(RuntimeError, anyio.ClosedResourceError, anyio.BrokenResourceError): await peer.socket.close(4403)

    async def shutdown(self):
        for device in list(set(self.agents) | set(self.clients)): await self.revoke(device)

    async def serve(self, socket: WebSocket, agent: bool, device: str = ""):
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
            else:
                if socket.headers.get("origin") != self.platform.settings.public_url: raise PermissionError()
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
        if not agent and device in self.clients:
            await socket.send_json({"type": "error", "code": "controller_busy"})
            await socket.close(4409); return
        if agent:
            old = self.agents.get(device)
            self.agents[device] = peer
            if old:
                with suppress(RuntimeError, anyio.ClosedResourceError, anyio.BrokenResourceError): await old.socket.close(4410)
            self.states[device] = "host_offline"
            client = self.clients.get(device)
            if client:
                client.requests.clear(); client.approvals.clear(); client.deciding.clear()
                client.send({"type": "state", "state": "runtime_starting"})
                peer.send({"type": "open", "session": client.session})
        else:
            self.clients[device] = peer
            peer.send({"type": "state", "state": self.status(device)["state"]})
            if (upstream := self.agents.get(device)):
                upstream.send({"type": "open", "session": peer.session})
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
            while True:
                try: raw = await socket.receive_text()
                except KeyError: raise ProtocolError("invalid_frame") from None
                peer.last_seen = time.monotonic()
                try:
                    message = parse_frame(raw)
                    if message == {"type": "pong"}: continue
                    if message == {"type": "ping"}: peer.send({"type": "pong"}); continue
                    if agent: self.from_agent(peer, message)
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

        tasks = [asyncio.create_task(fn()) for fn in (peer.write, read, monitor)]
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
                    if (client := self.clients.get(device)):
                        client.requests.clear(); client.approvals.clear(); client.deciding.clear()
                        with suppress(ProtocolError): client.send({"type": "state", "state": "cloud_offline"})
                elif not agent and self.clients.get(device) is peer:
                    self.clients.pop(device, None)
                    if (upstream := self.agents.get(device)):
                        with suppress(ProtocolError): upstream.send({"type": "close", "session": peer.session})
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                peer.requests.clear(); peer.approvals.clear(); peer.deciding.clear()
                with suppress(RuntimeError, anyio.ClosedResourceError, anyio.BrokenResourceError): await socket.close(1000)

    def from_client(self, peer: Peer, frame: dict):
        if set(frame) != {"type", "payload"} or frame["type"] != "rpc": raise ProtocolError()
        upstream = self.agents.get(peer.device)
        if upstream is None: raise ProtocolError("agent_offline")
        payload = frame["payload"]
        if not isinstance(payload, dict): raise ProtocolError()
        key = rpc_id(payload)
        if "method" in payload:
            method = validate_request(payload)
            if key in peer.requests or len(peer.requests) >= MAX_PENDING: raise ProtocolError("request_busy")
            peer.requests[key] = (method, time.monotonic())
        else:
            if set(payload) != {"id", "result"} or key not in peer.approvals or key in peer.deciding: raise ProtocolError("approval_unavailable")
            validate_decision(peer.approvals[key], payload["result"])
            peer.deciding.add(key)
            method = "approval"
        try: upstream.send({"type": "rpc", "session": peer.session, "payload": payload})
        except ProtocolError:
            peer.requests.pop(key, None)
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
            client = self.clients.get(peer.device)
            if client:
                client.send({"type": "state", "state": frame["state"]})
                peer.send({"type": "open", "session": client.session})
            return
        client = self.clients.get(peer.device)
        if client is None or frame.get("session") != client.session: return
        if kind == "state":
            if set(frame) != {"type", "session", "state"} or frame["state"] not in STATES: raise ProtocolError()
            self.states[peer.device] = frame["state"]
            if frame["state"] != "runtime_ready": client.requests.clear(); client.approvals.clear(); client.deciding.clear()
            client.send({"type": "state", "state": frame["state"]}); return
        if kind != "rpc" or set(frame) != {"type", "session", "payload"} or not isinstance(frame["payload"], dict):
            raise ProtocolError()
        payload = frame["payload"]
        if "id" in payload:
            key = rpc_id(payload)
            if "method" in payload:
                if payload["method"] not in APPROVALS or len(client.approvals) >= MAX_PENDING: raise ProtocolError()
                if set(payload) != {"id", "method", "params"} or not isinstance(payload["params"], dict): raise ProtocolError()
                client.approvals[key] = payload["method"]
            elif key in client.requests:
                client.requests.pop(key)
            elif key in client.deciding and "error" in payload:
                client.deciding.discard(key)
            else: return
        elif payload.get("method") == "serverRequest/resolved":
            request = payload.get("params", {}).get("requestId")
            if request is not None:
                key = rpc_id({"id": request})
                client.approvals.pop(key, None); client.deciding.discard(key)
        client.send({"type": "rpc", "payload": payload})
