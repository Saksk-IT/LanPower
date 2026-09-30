from __future__ import annotations

import time
import uuid
import hashlib
import secrets

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from cloud_remote.server import Relay
from cloud_app.app.models import AuditLog, Command, Device, DeviceLink, LegacyClient, User, WebSession
from cloud_app.app.routing import select_route
from cloud_app.app.settings import Settings
from cloud_app.app.windows import WindowsProtocol
from cloud_app.app.enrollment import Enrollment
from cloud_app.app.clients import Clients
from cloud_app.app.gateway import GatewayProtocol
from cloud_app.password import hash_password

ADMIN_ID = "00000000-0000-0000-0000-000000000001"
NAMESPACE = uuid.UUID("e09ab1c0-306f-4d8e-9b1f-afd27fab0715")


def seed_admin(settings: Settings, sessions: sessionmaker[Session]) -> None:
    now = int(time.time())
    with sessions.begin() as db:
        admin = db.get(User, ADMIN_ID)
        if admin is None:
            password_hash = settings.admin_password_hash or hash_password(secrets.token_urlsafe(32))
            db.add(User(id=ADMIN_ID, username="admin", password_hash=password_hash,
                        created_at=now))
        elif settings.admin_password_hash is not None and admin.password_hash != settings.admin_password_hash:
            admin.password_hash = settings.admin_password_hash
            db.execute(delete(WebSession).where(WebSession.owner_id == ADMIN_ID))


def seed_legacy(settings: Settings, sessions: sessionmaker[Session]) -> tuple[str, str]:
    if settings.legacy is None:
        raise ValueError("legacy gateway not configured")
    seed_admin(settings, sessions)
    now = int(time.time())
    gateway_id = str(uuid.uuid5(NAMESPACE, "gateway:" + settings.legacy.gateway_id))
    windows_id = str(uuid.uuid5(NAMESPACE, "windows:" + settings.legacy.gateway_id))
    client_id = str(uuid.uuid5(NAMESPACE, "client:" + settings.legacy.gateway_id))
    with sessions.begin() as db:
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
        self.relay = Relay(settings.legacy) if settings.legacy is not None else None
        self.windows = WindowsProtocol(sessions)
        self.tokens = self.windows.tokens
        self.enrollment = Enrollment(sessions, settings.public_url)
        self.mobile = Clients(sessions)
        self.gateway = GatewayProtocol(sessions)
        if settings.legacy is None:
            seed_admin(settings, sessions)
            self.gateway_id, self.windows_id = None, None
        else:
            self.gateway_id, self.windows_id = seed_legacy(settings, sessions)

    def devices(self, owner_id: str) -> list[Device]:
        with self.sessions() as db:
            return list(db.scalars(select(Device).where(Device.owner_id == owner_id, Device.revoked_at.is_(None)).order_by(Device.created_at, Device.id)))

    def device(self, owner_id: str, device_id: str) -> Device | None:
        with self.sessions() as db:
            return db.scalar(select(Device).where(Device.id == device_id, Device.owner_id == owner_id, Device.revoked_at.is_(None)))

    def presence(self) -> dict:
        return self.relay.status() if self.relay is not None else {"gateway": "offline", "pc": "unknown"}

    def device_status(self, owner_id: str, device_id: str) -> dict:
        with self.sessions() as db:
            device = db.scalar(select(Device).where(Device.id == device_id, Device.owner_id == owner_id,
                                                    Device.revoked_at.is_(None)))
            if device is None:
                raise ValueError("device unavailable")
            details = {"version": device.version, "protocol_version": device.protocol_version,
                       "last_seen_at": device.last_seen_at}
            legacy = bool(device.meta.get("legacy"))
            gateways = list(db.scalars(select(Device).join(DeviceLink, Device.id == DeviceLink.gateway_id).where(
                DeviceLink.windows_id == device_id, DeviceLink.relationship == "wake_gateway",
                Device.owner_id == owner_id, Device.revoked_at.is_(None)).order_by(Device.id))) if device.device_type == "windows" else []
            if device.device_type == "gateway":
                state = self.presence()["gateway"] if device.id == self.gateway_id else "online" if self.gateway.online(device) else "offline"
                computers = list(db.scalars(select(Device).join(DeviceLink, Device.id == DeviceLink.windows_id).where(
                    DeviceLink.gateway_id == device.id, DeviceLink.relationship == "wake_gateway",
                    Device.owner_id == owner_id, Device.revoked_at.is_(None))))
                return {**details, "device_id": device.id, "name": device.name, "device_type": device.device_type,
                        "state": state, "cloud_agent": "offline", "wake_available": False,
                        "wake_setup_supported": bool(device.meta.get("wake_setup_supported")),
                        "wake_targets": [{"device_id": computer.id, "message": self.gateway.setup_message(device, computer)}
                                         for computer in computers],
                        "wake_gateway": None, "remote_control_available": False}
            direct = device.protocol_version == "2" and self.windows.online(device)
            def current_observation(gateway):
                # A pre-shutdown LAN observation must not resurrect the device.
                return not (device.meta.get("presence_state") in {"offline", "transitioning"}
                            and device.last_seen_at is not None
                            and (gateway.last_seen_at or 0) <= device.last_seen_at)

            wake, backup = None, None
            for gateway in gateways:
                if gateway.protocol_version == "2":
                    if wake is None and self.gateway.permitted(db, gateway.id, device.id, "wake"):
                        wake = gateway
                    if backup is None and current_observation(gateway) and self.gateway.permitted(db, gateway.id, device.id, "status"):
                        backup = gateway
                elif legacy and gateway.id == self.gateway_id:
                    relay = self.presence()
                    if relay["gateway"] == "online":
                        wake = wake or gateway
                        if relay["pc"] == "online":
                            backup = backup or gateway
            linked = wake or (gateways[0] if gateways else None)
            linked_online = bool(linked and (self.gateway.online(linked) if linked.protocol_version == "2"
                                             else self.presence()["gateway"] == "online"))
            lan_states = [self.gateway.target(gateway, device.id)["lan_state"] for gateway in gateways
                          if self.gateway.online(gateway) and current_observation(gateway)
                          and self.gateway.target(gateway, device.id) is not None]
            lan_state = "online" if "online" in lan_states else "offline" if "offline" in lan_states else "unknown"
            transitioning = device.protocol_version == "2" and self.windows.presence_state(device) == "transitioning"
            # Reachability is independent of permission to relay power commands.
            state = "transitioning" if transitioning else "online" if direct or backup or lan_state == "online" else "offline"
            if transitioning:
                backup = None
            wake_reason = ("" if wake else "未配置唤醒网关" if not gateways else
                           "唤醒网关未连接" if not any(self.gateway.online(gateway) if gateway.protocol_version == "2"
                                                    else self.presence()["gateway"] == "online" for gateway in gateways)
                           else "网关尚未配置此电脑的唤醒信息")
            return {**details, "device_id": device.id, "name": device.name, "device_type": device.device_type,
                    "state": state, "cloud_agent": "online" if direct else "offline",
                    "lan_ip": device.meta.get("lan_ip"), "wol_capable": device.meta.get("wol_capable"),
                    "windows_lan_state": lan_state, "wake_unavailable_reason": wake_reason,
                    "wake_setup_message": self.gateway.setup_message(linked, device) if linked else "选择家中的网关后，将自动配置这台电脑。",
                    "wake_available": wake is not None,
                    "wake_gateway": {"device_id": linked.id, "name": linked.name, "state": "online" if linked_online else "offline"} if linked else None,
                    "backup_gateway": {"device_id": backup.id, "name": backup.name, "state": "online"} if backup else None,
                    "remote_control_available": not transitioning and (direct or backup is not None)}

    def issue_command(self, owner_id: str, device_id: str, action: str) -> dict:
        status = self.device_status(owner_id, device_id)
        if status["device_type"] != "windows":
            raise ValueError("device unavailable")
        gateway = status["wake_gateway"] if action == "wake" else status["backup_gateway"]
        route = select_route(action, windows_online=status["cloud_agent"] == "online",
                             gateway_online=bool(gateway and gateway["state"] == "online" and
                                                 (action != "wake" or status["wake_available"])),
                             linked_gateway=gateway is not None,
                             windows_lan_online=status["backup_gateway"] is not None,
                             backup_relay_enabled=status["backup_gateway"] is not None)
        if route == "windows_direct":
            return self.windows.issue(owner_id, device_id, action)
        if route in {"wake_gateway", "gateway_relay"}:
            linked = self.device(owner_id, gateway["device_id"])
            if linked is None:
                raise ConnectionError("gateway route unavailable")
            if linked.protocol_version == "2":
                return self.gateway.issue(owner_id, linked.id, device_id, action)
            return self.issue_legacy(owner_id, device_id, action)
        raise ConnectionError("requested action unavailable")

    def issue_legacy(self, owner_id: str, device_id: str, action: str) -> dict:
        device = self.device(owner_id, device_id)
        if (self.relay is None or self.settings.legacy is None or device is None or
                device.device_type != "windows" or device.legacy_gateway_id != self.settings.legacy.gateway_id):
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

    def links(self, owner_id: str) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        with self.sessions() as db:
            devices = {device.id: device for device in db.scalars(select(Device).where(
                Device.owner_id == owner_id, Device.revoked_at.is_(None)))}
            for link in db.scalars(select(DeviceLink).where(DeviceLink.relationship == "wake_gateway")):
                if link.gateway_id in devices and link.windows_id in devices:
                    result.setdefault(link.gateway_id, []).append({"device_id": link.windows_id,
                        "name": devices[link.windows_id].name,
                        "backup": db.get(DeviceLink, (link.gateway_id, link.windows_id, "backup_relay")) is not None})
        return result

    def record(self, owner_id: str, event: str, device_id: str | None = None, route: str | None = None) -> None:
        with self.sessions.begin() as db:
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event=event,
                            target_device_id=device_id, route=route, created_at=int(time.time())))
