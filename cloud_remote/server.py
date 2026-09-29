"""Single-home remote relay. Bind to loopback and terminate HTTPS at a reverse proxy."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid


ACTIONS = {"wake", "status", "sleep", "hibernate", "restart", "shutdown"}
VERSION = "1.1.2"
POWER_ACTIONS = ACTIONS - {"wake", "status"}
HEX_SECRET = re.compile(r"^[0-9a-fA-F]{64}$")
GATEWAY_ID = re.compile(r"^[A-Za-z0-9_-]{3,64}$")


@dataclass(frozen=True)
class Config:
    gateway_id: str
    gateway_secret: str
    client_secret: str
    database: Path
    listen_port: int = 8765

    @classmethod
    def load(cls, path: Path) -> "Config":
        if path.stat().st_mode & 0o077:
            raise ValueError("cloud config must be readable only by its owner (chmod 600)")
        data = json.loads(path.read_text(encoding="utf-8"))
        allowed = {"gateway_id", "gateway_secret", "client_secret", "database", "listen_port"}
        if set(data) - allowed:
            raise ValueError("unknown cloud configuration field")
        config = cls(
            gateway_id=data["gateway_id"],
            gateway_secret=data["gateway_secret"],
            client_secret=data["client_secret"],
            database=Path(data["database"]),
            listen_port=data.get("listen_port", 8765),
        )
        config.validate()
        return config

    def validate(self) -> None:
        if not GATEWAY_ID.fullmatch(self.gateway_id):
            raise ValueError("invalid gateway_id")
        if not HEX_SECRET.fullmatch(self.gateway_secret) or not HEX_SECRET.fullmatch(self.client_secret):
            raise ValueError("credentials must be 64 hexadecimal characters")
        if hmac.compare_digest(self.gateway_secret.lower(), self.client_secret.lower()):
            raise ValueError("gateway and client credentials must differ")
        if not isinstance(self.listen_port, int) or not 1 <= self.listen_port <= 65535:
            raise ValueError("invalid listen_port")


class Relay:
    def __init__(self, config: Config):
        config.validate()
        self.config = config
        self.changed = threading.Condition(threading.RLock())
        config.database.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _db(self):
        connection = sqlite3.connect(self.config.database, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self):
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS commands (
                    command_id TEXT PRIMARY KEY,
                    gateway_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    nonce TEXT NOT NULL UNIQUE,
                    issued_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    delivered_at INTEGER,
                    result_ok INTEGER,
                    state TEXT,
                    error TEXT
                );
                CREATE TABLE IF NOT EXISTS heartbeat (
                    gateway_id TEXT PRIMARY KEY,
                    seen_at INTEGER NOT NULL,
                    pc_state TEXT NOT NULL,
                    version TEXT NOT NULL,
                    uptime INTEGER NOT NULL
                );
            """)

    def heartbeat(self, payload: dict) -> None:
        if (set(payload) != {"gateway_id", "pc_state", "version", "uptime"}
                or payload["gateway_id"] != self.config.gateway_id
                or not isinstance(payload["pc_state"], str)
                or payload["pc_state"] not in {"online", "offline"}
                or not isinstance(payload["version"], str) or len(payload["version"]) > 32
                or type(payload["uptime"]) is not int or payload["uptime"] < 0):
            raise ValueError("invalid heartbeat")
        now = int(time.time())
        with self.changed, self._db() as db:
            db.execute("""INSERT INTO heartbeat VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(gateway_id) DO UPDATE SET seen_at=excluded.seen_at,
                pc_state=excluded.pc_state, version=excluded.version, uptime=excluded.uptime""",
                (self.config.gateway_id, now, payload["pc_state"], payload["version"], payload["uptime"]))
            db.execute("DELETE FROM commands WHERE issued_at < ?", (now - 86400,))
            self.changed.notify_all()

    def status(self) -> dict:
        with self.changed, self._db() as db:
            row = db.execute("SELECT * FROM heartbeat WHERE gateway_id=?", (self.config.gateway_id,)).fetchone()
        if row is None or int(time.time()) - row["seen_at"] > 75:
            return {"gateway": "offline", "pc": "unknown"}
        return {"gateway": "online", "pc": row["pc_state"], "seen_at": row["seen_at"]}

    def issue(self, action: str) -> dict:
        if not isinstance(action, str) or action not in ACTIONS:
            raise ValueError("unknown action")
        now = int(time.time())
        with self.changed, self._db() as db:
            status = self.status()
            if status["gateway"] != "online":
                raise ConnectionError("gateway offline")
            if action in POWER_ACTIONS and status["pc"] != "online":
                raise ValueError("PC offline")
            if action in POWER_ACTIONS:
                last = db.execute("SELECT MAX(issued_at) AS at FROM commands WHERE action IN ('sleep','hibernate','restart','shutdown')").fetchone()["at"]
            else:
                last = db.execute("SELECT MAX(issued_at) AS at FROM commands WHERE action=?", (action,)).fetchone()["at"]
            minimum = 2 if action == "status" else 5 if action == "wake" else 15
            if last is not None and now - last < minimum:
                raise BlockingIOError("command rate limit")
            command = {
                "command_id": str(uuid.uuid4()), "gateway_id": self.config.gateway_id,
                "action": action, "issued_at": now, "expires_at": now + 45,
                "nonce": secrets.token_hex(16),
            }
            db.execute("""INSERT INTO commands
                (command_id, gateway_id, action, nonce, issued_at, expires_at)
                VALUES (:command_id, :gateway_id, :action, :nonce, :issued_at, :expires_at)""", command)
            self.changed.notify_all()
        return command

    def poll(self, timeout: float = 25) -> dict | None:
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                now = int(time.time())
                with self._db() as db:
                    row = db.execute("""SELECT * FROM commands WHERE gateway_id=? AND delivered_at IS NULL
                        AND expires_at>? ORDER BY issued_at, rowid LIMIT 1""",
                        (self.config.gateway_id, now)).fetchone()
                    if row is not None:
                        db.execute("UPDATE commands SET delivered_at=? WHERE command_id=?", (now, row["command_id"]))
                        return {key: row[key] for key in
                            ("command_id", "gateway_id", "action", "issued_at", "expires_at", "nonce")}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.changed.wait(remaining)

    def result(self, payload: dict) -> None:
        if (set(payload) - {"command_id", "ok", "state", "error"}
                or not isinstance(payload.get("command_id"), str)
                or type(payload.get("ok")) is not bool
                or not isinstance(payload.get("state", ""), str)
                or payload.get("state", "") not in {"", "online", "offline", "waking", "transitioning"}
                or not isinstance(payload.get("error", ""), str)
                or len(payload.get("error", "")) > 160):
            raise ValueError("invalid result")
        with self.changed, self._db() as db:
            row = db.execute("SELECT * FROM commands WHERE command_id=? AND gateway_id=?",
                (payload["command_id"], self.config.gateway_id)).fetchone()
            if row is None or row["delivered_at"] is None:
                raise ValueError("unknown command result")
            if row["result_ok"] is not None:
                if (bool(row["result_ok"]) == payload["ok"] and row["state"] == payload.get("state", "")
                        and row["error"] == payload.get("error", "")):
                    return
                raise ValueError("conflicting command result")
            db.execute("UPDATE commands SET result_ok=?, state=?, error=? WHERE command_id=?",
                (int(payload["ok"]), payload.get("state", ""), payload.get("error", ""), payload["command_id"]))
            self.changed.notify_all()

    def wait_result(self, command_id: str, timeout: float = 30) -> dict:
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                with self._db() as db:
                    row = db.execute("SELECT result_ok, state, error FROM commands WHERE command_id=?",
                        (command_id,)).fetchone()
                if row and row["result_ok"] is not None:
                    return {"command_id": command_id, "ok": bool(row["result_ok"]),
                        "state": row["state"], "error": row["error"]}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return {"command_id": command_id, "ok": False,
                        "state": "", "error": "gateway result timed out"}
                self.changed.wait(remaining)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, config: Config):
        super().__init__(address, Handler)
        self.relay = Relay(config)


class Handler(BaseHTTPRequestHandler):
    server: Server

    def log_message(self, format_string, *args):
        # Never log bearer credentials or request bodies.
        pass

    def send_json(self, code: int, payload: dict):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self, role: str) -> bool:
        secret = self.server.relay.config.gateway_secret if role == "gateway" else self.server.relay.config.client_secret
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + secret)

    def parse_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > 4096:
                raise ValueError("invalid body size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("body must be an object")
            return payload
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("invalid JSON") from error

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path == "/healthz":
            return self.send_json(200, {"ok": True, "version": VERSION})
        if path.path == "/api/v1/client/status":
            if not self.authorized("client"):
                return self.send_json(401, {"error": "unauthorized"})
            if parse_qs(path.query).get("gateway_id") != [self.server.relay.config.gateway_id]:
                return self.send_json(400, {"error": "invalid gateway"})
            return self.send_json(200, self.server.relay.status())
        if path.path == "/api/v1/gateway/commands":
            if not self.authorized("gateway"):
                return self.send_json(401, {"error": "unauthorized"})
            if parse_qs(path.query).get("gateway_id") != [self.server.relay.config.gateway_id]:
                return self.send_json(400, {"error": "invalid gateway"})
            return self.send_json(200, {"command": self.server.relay.poll()})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlsplit(self.path).path
        roles = {
            "/api/v1/client/commands": "client",
            "/api/v1/gateway/heartbeat": "gateway",
            "/api/v1/gateway/results": "gateway",
        }
        if path not in roles:
            return self.send_json(404, {"error": "not found"})
        if not self.authorized(roles[path]):
            return self.send_json(401, {"error": "unauthorized"})
        try:
            payload = self.parse_body()
            relay = self.server.relay
            if path == "/api/v1/gateway/heartbeat":
                relay.heartbeat(payload)
                return self.send_json(200, {"ok": True})
            if path == "/api/v1/gateway/results":
                relay.result(payload)
                return self.send_json(200, {"ok": True})
            if (set(payload) != {"gateway_id", "action"} or payload["gateway_id"] != relay.config.gateway_id
                    or not isinstance(payload["action"], str)):
                raise ValueError("invalid command request")
            command = relay.issue(payload["action"])
            return self.send_json(200, relay.wait_result(command["command_id"]))
        except ConnectionError as error:
            self.send_json(503, {"error": str(error)})
        except BlockingIOError as error:
            self.send_json(429, {"error": str(error)})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description="LanPower cloud relay")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config = Config.load(args.config)
    with Server(("127.0.0.1", config.listen_port), config) as server:
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
