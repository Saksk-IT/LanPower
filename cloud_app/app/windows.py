from __future__ import annotations

import ipaddress
import secrets
import threading
import time
import uuid

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from cloud_app.app.auth import digest
from cloud_app.app.device_auth import ACCESS_SECONDS, REFRESH_SECONDS, DeviceTokens
from cloud_app.app.models import (
    AuditLog, Command, Device, DeviceCommand, DeviceHeartbeat, DeviceSession,
    EnrollmentSession, GatewayCommand,
)

ENROLL_SECONDS = 10 * 60
ACTIONS = {"status", "sleep", "hibernate", "restart", "shutdown"}
POWER_ACTIONS = ACTIONS - {"status"}
PRESENCE_SECONDS = 75  # Older agents send one heartbeat per 25-second command poll.


class WindowsProtocol:
    def __init__(self, sessions: sessionmaker[Session]):
        self.sessions = sessions
        self.tokens = DeviceTokens(sessions)
        self.changed = threading.Condition(threading.RLock())

    def create_enrollment(self, owner_id: str) -> str:
        code = secrets.token_urlsafe(24)
        now = int(time.time())
        with self.sessions.begin() as db:
            db.add(EnrollmentSession(code_hash=digest(code), owner_id=owner_id, device_type="windows",
                                     created_at=now, expires_at=now + ENROLL_SECONDS))
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event="enrollment_created",
                            created_at=now))
        return code

    def enroll(self, payload: dict) -> dict:
        if (set(payload) != {"code", "name", "version", "protocol_version"}
                or not isinstance(payload["code"], str) or len(payload["code"]) > 80
                or not isinstance(payload["name"], str) or not 1 <= len(payload["name"].strip()) <= 100
                or not isinstance(payload["version"], str) or len(payload["version"]) > 32
                or payload["protocol_version"] != "2"):
            raise ValueError("invalid enrollment")
        now = int(time.time())
        device_id = str(uuid.uuid4())
        with self.sessions.begin() as db:
            row = db.get(EnrollmentSession, digest(payload["code"]))
            if row is None or row.device_type != "windows":
                raise ValueError("enrollment unavailable")
            changed = db.execute(update(EnrollmentSession).where(
                EnrollmentSession.code_hash == row.code_hash,
                EnrollmentSession.used_at.is_(None), EnrollmentSession.expires_at >= now
            ).values(used_at=now))
            if changed.rowcount != 1:
                raise ValueError("enrollment unavailable")
            db.add(Device(id=device_id, owner_id=row.owner_id, device_type="windows",
                          name=payload["name"].strip(), version=payload["version"], protocol_version="2",
                          created_at=now, meta={}))
            result = self.tokens.issue(db, row.owner_id, device_id, now)
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=row.owner_id, event="device_enrolled",
                            target_device_id=device_id, created_at=now))
        return result

    def refresh(self, payload: dict) -> dict:
        return self.tokens.refresh(payload, expected_type="windows")

    def authorize(self, token: str | None) -> tuple[str, str]:
        return self.tokens.authorize(token, expected_type="windows")

    def heartbeat(self, device_id: str, payload: dict) -> None:
        fields = {"device_id", "version", "state", "uptime", "lan_ip", "wol_capable"}
        if (set(payload) not in (fields, fields | {"heartbeat_interval"})
                or payload["device_id"] != device_id or payload["state"] not in ("online", "offline", "transitioning")
                or not isinstance(payload["version"], str) or len(payload["version"]) > 32
                or type(payload["uptime"]) is not int or payload["uptime"] < 0
                or not isinstance(payload["lan_ip"], str) or len(payload["lan_ip"]) > 45
                or type(payload["wol_capable"]) is not bool
                or type(payload.get("heartbeat_interval", 25)) is not int
                or not 5 <= payload.get("heartbeat_interval", 25) <= 25):
            raise ValueError("invalid heartbeat")
        try:
            ipaddress.ip_address(payload["lan_ip"])
        except ValueError as error:
            raise ValueError("invalid LAN address") from error
        now = int(time.time())
        with self.sessions.begin() as db:
            device = db.get(Device, device_id)
            if device is None or device.revoked_at is not None:
                raise PermissionError("device revoked")
            device.last_seen_at = now
            device.version = payload["version"]
            device.meta = {**device.meta, "lan_ip": payload["lan_ip"], "wol_capable": payload["wol_capable"],
                           "presence_state": payload["state"], "heartbeat_interval": payload.get("heartbeat_interval", 25)}
            db.add(DeviceHeartbeat(id=str(uuid.uuid4()), device_id=device_id, seen_at=now,
                                   state=payload["state"], uptime=payload["uptime"], lan_ip=payload["lan_ip"],
                                   wol_capable=payload["wol_capable"]))
            db.execute(delete(DeviceHeartbeat).where(DeviceHeartbeat.seen_at < now - 30 * 86400))

    @staticmethod
    def presence_state(device: Device) -> str:
        timeout = min(PRESENCE_SECONDS, device.meta.get("heartbeat_interval", 25) * 3 + 5)
        if (device.revoked_at is not None or device.last_seen_at is None
                or not 0 <= int(time.time()) - device.last_seen_at <= timeout):
            return "offline"
        return device.meta.get("presence_state", "online")

    def online(self, device: Device) -> bool:
        return self.presence_state(device) == "online"

    def issue(self, owner_id: str, device_id: str, action: str) -> dict:
        if action not in ACTIONS:
            raise ValueError("unknown action")
        now = int(time.time())
        command_id = str(uuid.uuid4())
        with self.changed, self.sessions.begin() as db:
            device = db.get(Device, device_id)
            if device is None or device.owner_id != owner_id or device.device_type != "windows" or not self.online(device):
                raise ConnectionError("windows agent offline")
            actions = POWER_ACTIONS if action in POWER_ACTIONS else {"status"}
            previous = db.scalar(select(func.max(Command.issued_at)).where(
                Command.target_device_id == device_id, Command.action.in_(actions)))
            if previous is not None and now - previous < (2 if action == "status" else 15):
                raise BlockingIOError("command rate limit")
            db.add(DeviceCommand(id=command_id, target_device_id=device_id, action=action,
                                 nonce=secrets.token_hex(16), issued_at=now, expires_at=now + 45))
            db.add(Command(id=command_id, owner_id=owner_id, target_device_id=device_id,
                           action=action, route="windows_direct", state="accepted", issued_at=now, error=""))
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event="command_issued",
                            target_device_id=device_id, route="windows_direct", created_at=now))
            self.changed.notify_all()
        return {"command_id": command_id, "accepted": True, "route": "windows_direct", "state": "accepted"}

    def poll(self, device_id: str, timeout: float = 25) -> dict | None:
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                now = int(time.time())
                with self.sessions.begin() as db:
                    expired = list(db.scalars(select(DeviceCommand).where(
                        DeviceCommand.target_device_id == device_id, DeviceCommand.expires_at <= now,
                        DeviceCommand.result_ok.is_(None))))
                    for stale in expired:
                        platform_command = db.get(Command, stale.id)
                        if platform_command and platform_command.state == "accepted":
                            platform_command.state = "failed"
                            platform_command.completed_at = now
                            platform_command.error = "Windows 未在时限内确认"
                    command = db.scalar(select(DeviceCommand).where(
                        DeviceCommand.target_device_id == device_id,
                        or_(DeviceCommand.delivered_at.is_(None), DeviceCommand.delivered_at <= now - 10),
                        DeviceCommand.result_ok.is_(None), DeviceCommand.expires_at > now
                    ).order_by(DeviceCommand.issued_at, DeviceCommand.id).limit(1))
                    if command:
                        command.delivered_at = now
                        return {"command_id": command.id, "target_device_id": command.target_device_id,
                                "action": command.action, "issued_at": command.issued_at,
                                "expires_at": command.expires_at, "nonce": command.nonce}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.changed.wait(remaining)

    def result(self, device_id: str, payload: dict) -> None:
        if (set(payload) != {"command_id", "ok", "state", "error"}
                or not isinstance(payload["command_id"], str) or len(payload["command_id"]) > 64
                or type(payload["ok"]) is not bool
                or not isinstance(payload["state"], str) or payload["state"] not in {"online", "transitioning", "failed"}
                or not isinstance(payload["error"], str) or len(payload["error"]) > 160
                or (payload["ok"] and payload["state"] == "failed")
                or (not payload["ok"] and payload["state"] != "failed")):
            raise ValueError("invalid result")
        now = int(time.time())
        with self.changed, self.sessions.begin() as db:
            command = db.get(DeviceCommand, payload["command_id"])
            if command is None or command.target_device_id != device_id or command.delivered_at is None:
                raise ValueError("unknown command result")
            if command.result_ok is not None:
                if command.result_ok == payload["ok"] and command.result_state == payload["state"] and command.error == payload["error"]:
                    return
                raise ValueError("conflicting command result")
            command.result_ok = payload["ok"]
            command.result_state = payload["state"]
            command.error = payload["error"]
            platform_command = db.get(Command, command.id)
            platform_command.state = payload["state"] if payload["ok"] and payload["state"] == "transitioning" else "completed" if payload["ok"] else "failed"
            platform_command.completed_at = now
            platform_command.error = payload["error"]
            if payload["ok"] and command.action in POWER_ACTIONS and payload["state"] == "transitioning":
                device = db.get(Device, device_id)
                device.meta = {**device.meta, "presence_state": "transitioning"}
                device.last_seen_at = now
            self.changed.notify_all()

    def command_result(self, owner_id: str, command_id: str) -> dict:
        with self.sessions.begin() as db:
            command = db.get(Command, command_id)
            if command is None or command.owner_id != owner_id:
                raise ValueError("command unavailable")
            if command.state == "accepted" and command.issued_at + 45 <= int(time.time()):
                command.state = "failed"
                command.completed_at = int(time.time())
                command.error = "设备未在时限内确认"
            return {"command_id": command.id, "accepted": True, "route": command.route,
                    "state": command.state, "error": command.error}

    def revoke_device(self, owner_id: str, device_id: str) -> None:
        now = int(time.time())
        with self.sessions.begin() as db:
            device = db.get(Device, device_id)
            if device is None or device.owner_id != owner_id or device.revoked_at is not None:
                raise ValueError("device unavailable")
            if device.protocol_version != "2":
                raise ValueError("旧版设备请在服务器的旧版配置中移除")
            device.revoked_at = now
            for session in db.scalars(select(DeviceSession).where(DeviceSession.device_id == device_id,
                                                                  DeviceSession.revoked_at.is_(None))):
                session.revoked_at = now
            pending = list(db.scalars(select(DeviceCommand).where(
                DeviceCommand.target_device_id == device_id, DeviceCommand.result_ok.is_(None))))
            pending += list(db.scalars(select(GatewayCommand).where(
                or_(GatewayCommand.gateway_id == device_id, GatewayCommand.target_device_id == device_id),
                GatewayCommand.result_ok.is_(None))))
            for command in pending:
                command.result_ok, command.result_state, command.error = False, "failed", "设备已移除，未完成命令已停止"
                row = db.get(Command, command.id)
                if row is not None:
                    row.state, row.error, row.completed_at = "failed", command.error, now
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event="device_revoked",
                            target_device_id=device_id, created_at=now))
