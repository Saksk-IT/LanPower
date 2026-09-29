from __future__ import annotations

import time
import uuid
import hashlib

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from cloud_remote.server import Relay
from cloud_app.app.models import AuditLog, Command, Device, DeviceLink, LegacyClient, User, WebSession
from cloud_app.app.settings import Settings

ADMIN_ID = "00000000-0000-0000-0000-000000000001"
NAMESPACE = uuid.UUID("e09ab1c0-306f-4d8e-9b1f-afd27fab0715")


def seed_legacy(settings: Settings, sessions: sessionmaker[Session]) -> tuple[str, str]:
    now = int(time.time())
    gateway_id = str(uuid.uuid5(NAMESPACE, "gateway:" + settings.legacy.gateway_id))
    windows_id = str(uuid.uuid5(NAMESPACE, "windows:" + settings.legacy.gateway_id))
    client_id = str(uuid.uuid5(NAMESPACE, "client:" + settings.legacy.gateway_id))
    with sessions.begin() as db:
        admin = db.get(User, ADMIN_ID)
        if admin is None:
            db.add(User(id=ADMIN_ID, username="admin", password_hash=settings.admin_password_hash,
                        created_at=now))
        elif admin.password_hash != settings.admin_password_hash:
            admin.password_hash = settings.admin_password_hash
            db.execute(delete(WebSession).where(WebSession.owner_id == ADMIN_ID))
        gateway = db.get(Device, gateway_id)
        if gateway is None:
            db.add(Device(id=gateway_id, owner_id=ADMIN_ID, device_type="gateway",
                          name="Wake Gateway", version="1.1.2", protocol_version="1",
                          created_at=now, meta={}, legacy_gateway_id=settings.legacy.gateway_id))
        windows = db.get(Device, windows_id)
        if windows is None:
            db.add(Device(id=windows_id, owner_id=ADMIN_ID, device_type="windows",
                          name="Windows 电脑", version="1.1.2", protocol_version="1",
                          created_at=now, meta={"legacy": True}, legacy_gateway_id=settings.legacy.gateway_id))
        if db.get(DeviceLink, (gateway_id, windows_id, "wake_gateway")) is None:
            db.add(DeviceLink(gateway_id=gateway_id, windows_id=windows_id,
                              relationship="wake_gateway", created_at=now))
        client = db.get(LegacyClient, client_id)
        credential_hash = hashlib.sha256(settings.legacy.client_secret.encode()).hexdigest()
        if client is None:
            db.add(LegacyClient(id=client_id, owner_id=ADMIN_ID, name="旧版微信小程序",
                                credential_hash=credential_hash, created_at=now))
        elif client.credential_hash != credential_hash:
            client.credential_hash = credential_hash
    return gateway_id, windows_id


class Platform:
    def __init__(self, settings: Settings, sessions: sessionmaker[Session]):
        self.settings = settings
        self.sessions = sessions
        self.relay = Relay(settings.legacy)
        self.gateway_id, self.windows_id = seed_legacy(settings, sessions)

    def devices(self, owner_id: str) -> list[Device]:
        with self.sessions() as db:
            return list(db.scalars(select(Device).where(Device.owner_id == owner_id, Device.revoked_at.is_(None)).order_by(Device.created_at, Device.id)))

    def device(self, owner_id: str, device_id: str) -> Device | None:
        with self.sessions() as db:
            return db.scalar(select(Device).where(Device.id == device_id, Device.owner_id == owner_id, Device.revoked_at.is_(None)))

    def presence(self) -> dict:
        return self.relay.status()

    def issue_legacy(self, owner_id: str, device_id: str, action: str) -> dict:
        device = self.device(owner_id, device_id)
        if device is None or device.device_type != "windows" or device.legacy_gateway_id != self.settings.legacy.gateway_id:
            raise ValueError("device unavailable")
        if action not in {"wake", "status", "sleep", "hibernate", "restart", "shutdown"}:
            raise ValueError("unknown action")
        route = "wake_gateway" if action == "wake" else "gateway_relay"
        command = self.relay.issue(action)
        now = int(time.time())
        with self.sessions.begin() as db:
            db.add(Command(id=command["command_id"], owner_id=owner_id, target_device_id=device_id,
                           action=action, route=route, state="accepted", issued_at=now, error=""))
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event="command_issued",
                            target_device_id=device_id, route=route, created_at=now))
        result = self.relay.wait_result(command["command_id"])
        with self.sessions.begin() as db:
            row = db.get(Command, command["command_id"])
            row.state = "completed" if result["ok"] else "failed"
            row.completed_at = int(time.time())
            row.error = result["error"][:160]
        return {**result, "route": route, "action": action}

    def recent_commands(self, owner_id: str) -> list[Command]:
        with self.sessions() as db:
            return list(db.scalars(select(Command).where(Command.owner_id == owner_id).order_by(Command.issued_at.desc()).limit(20)))

    def audit(self, owner_id: str) -> list[AuditLog]:
        with self.sessions() as db:
            return list(db.scalars(select(AuditLog).where(AuditLog.owner_id == owner_id).order_by(AuditLog.created_at.desc()).limit(50)))

    def clients(self, owner_id: str) -> list[LegacyClient]:
        with self.sessions() as db:
            return list(db.scalars(select(LegacyClient).where(LegacyClient.owner_id == owner_id)))

    def record(self, owner_id: str, event: str, device_id: str | None = None, route: str | None = None) -> None:
        with self.sessions.begin() as db:
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event=event,
                            target_device_id=device_id, route=route, created_at=int(time.time())))
