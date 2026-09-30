from __future__ import annotations

import secrets
import threading
import time
import uuid

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from cloud_app.app.models import AuditLog, Command, Device, DeviceLink, GatewayCommand
from cloud_app.app.windows import POWER_ACTIONS, WindowsProtocol


class GatewayProtocol:
    def __init__(self, sessions: sessionmaker[Session]):
        self.sessions = sessions
        self.changed = threading.Condition(threading.RLock())

    @staticmethod
    def online(device: Device) -> bool:
        return (device.protocol_version == "2" and device.revoked_at is None and device.last_seen_at is not None
                and 0 <= int(time.time()) - device.last_seen_at <= 75)

    @staticmethod
    def target(gateway: Device, windows_id: str) -> dict | None:
        return next((target for target in gateway.meta.get("targets", []) if target["device_id"] == windows_id), None)

    def heartbeat(self, owner_id: str, device_id: str, payload: dict) -> None:
        if (set(payload) != {"device_id", "version", "uptime", "targets"} or payload["device_id"] != device_id or
                not isinstance(payload["version"], str) or len(payload["version"]) > 32 or
                type(payload["uptime"]) is not int or payload["uptime"] < 0 or
                not isinstance(payload["targets"], list) or len(payload["targets"]) > 32):
            raise ValueError("invalid gateway heartbeat")
        seen = set()
        active_targets = []
        with self.sessions.begin() as db:
            for target in payload["targets"]:
                if (not isinstance(target, dict) or set(target) != {"device_id", "lan_state", "wol_capable", "relay_enabled"} or
                        not isinstance(target["device_id"], str) or target["device_id"] in seen or
                        target["lan_state"] not in ("online", "offline", "unknown") or
                        type(target["wol_capable"]) is not bool or type(target["relay_enabled"]) is not bool):
                    raise ValueError("invalid gateway target")
                device = db.get(Device, target["device_id"])
                if device is None or device.owner_id != owner_id or device.device_type != "windows":
                    raise ValueError("gateway target unavailable")
                seen.add(target["device_id"])
                # A removed computer must not take the gateway's other targets
                # offline while its local configuration awaits maintenance.
                if device.revoked_at is None:
                    active_targets.append(target)
            gateway = db.get(Device, device_id)
            if gateway is None or gateway.owner_id != owner_id or gateway.revoked_at is not None or gateway.device_type != "gateway":
                raise PermissionError("gateway unavailable")
            gateway.last_seen_at = int(time.time())
            gateway.version = payload["version"]
            gateway.meta = {**gateway.meta, "targets": active_targets, "uptime": payload["uptime"]}

    def sync_wake_setup(self, owner_id: str, gateway_id: str, payload: dict) -> list[dict]:
        if (set(payload) != {"results"} or not isinstance(payload["results"], list) or len(payload["results"]) > 32):
            raise ValueError("invalid wake setup report")
        results = {}
        for result in payload["results"]:
            if (not isinstance(result, dict) or set(result) != {"device_id", "state"}
                    or not isinstance(result["device_id"], str) or result["device_id"] in results
                    or result["state"] not in ("ready", "unreachable", "invalid_profile", "save_failed", "capacity")):
                raise ValueError("invalid wake setup result")
            results[result["device_id"]] = result["state"]
        with self.sessions.begin() as db:
            gateway = db.get(Device, gateway_id)
            if (gateway is None or gateway.owner_id != owner_id or gateway.device_type != "gateway"
                    or gateway.revoked_at is not None or gateway.protocol_version != "2"):
                raise PermissionError("gateway unavailable")
            computers = list(db.scalars(select(Device).join(DeviceLink, Device.id == DeviceLink.windows_id).where(
                DeviceLink.gateway_id == gateway_id, DeviceLink.relationship == "wake_gateway",
                Device.owner_id == owner_id, Device.device_type == "windows", Device.revoked_at.is_(None)
            ).order_by(Device.id)))
            ids = {computer.id for computer in computers}
            # An unlink between the request and the report is harmless. Do not
            # retain reports or hand out tickets for computers no longer linked.
            gateway.meta = {**gateway.meta, "wake_setup_supported": True,
                            "wake_setup_results": {key: value for key, value in results.items() if key in ids}}
            targets = []
            now = int(time.time())
            for computer in computers:
                profile = computer.meta.get("wake_profile")
                ticket = None
                if (WindowsProtocol.presence_state(computer) == "online" and profile
                        and profile["expires_at"] > now):
                    ticket = {**profile, "lan_ip": computer.meta["lan_ip"]}
                targets.append({"device_id": computer.id, "profile": ticket})
            return targets

    def setup_message(self, gateway: Device, computer: Device) -> str:
        if not self.online(gateway):
            return "等待网关上线，配置会自动继续。"
        target = self.target(gateway, computer.id)
        if target and target["wol_capable"]:
            return "唤醒信息已就绪。请确认电脑已开启网络唤醒，并在方便时测试实际开机。"
        if not gateway.meta.get("wake_setup_supported"):
            return "请升级网关程序以自动配置；旧版仍可使用本地配置。"
        if WindowsProtocol.presence_state(computer) != "online":
            return "请先开启这台电脑并连接 Cloud，配置会自动继续。"
        if not computer.meta.get("wake_setup_supported"):
            return "请升级 Windows 应用以自动提供唤醒信息。"
        if not computer.meta.get("wake_profile"):
            return "请在 Windows 应用的网络设置中选择已连接的局域网网卡。"
        state = gateway.meta.get("wake_setup_results", {}).get(computer.id)
        return {"unreachable": "无法从网关连接电脑，请确认两者在同一局域网；系统会自动重试。",
                "invalid_profile": "电脑唤醒信息校验失败，请检查网卡选择或升级 Windows 应用。",
                "save_failed": "网关无法保存配置，请检查存储空间和目录权限。",
                "capacity": "网关最多支持 32 台电脑，请先解除不再使用的关联。"}.get(
                    state, "正在自动配置，请保持电脑和网关在线，通常约 30 秒完成。")

    def link(self, owner_id: str, gateway_id: str, windows_id: str, *, backup: bool, remove: bool = False) -> None:
        with self.changed, self.sessions.begin() as db:
            gateway, windows = db.get(Device, gateway_id), db.get(Device, windows_id)
            if (not gateway or not windows or gateway.owner_id != owner_id or windows.owner_id != owner_id or
                    gateway.device_type != "gateway" or windows.device_type != "windows" or
                    gateway.protocol_version != "2" or gateway.revoked_at is not None or windows.revoked_at is not None):
                raise ValueError("device unavailable")
            existing = db.get(DeviceLink, (gateway_id, windows_id, "wake_gateway"))
            count = db.scalar(select(func.count()).select_from(DeviceLink).where(
                DeviceLink.gateway_id == gateway_id, DeviceLink.relationship == "wake_gateway"))
            if not remove and existing is None and count >= 32:
                raise ValueError("gateway supports at most 32 computers")
            db.execute(delete(DeviceLink).where(DeviceLink.gateway_id == gateway_id, DeviceLink.windows_id == windows_id))
            if not remove:
                for relationship in (["wake_gateway", "backup_relay"] if backup else ["wake_gateway"]):
                    db.add(DeviceLink(gateway_id=gateway_id, windows_id=windows_id,
                                      relationship=relationship, created_at=int(time.time())))
            # Cancel queued work when permissions are edited. Already delivered
            # commands cannot be recalled from an offline gateway.
            for command in db.scalars(select(GatewayCommand).where(
                    GatewayCommand.gateway_id == gateway_id, GatewayCommand.target_device_id == windows_id,
                    GatewayCommand.result_ok.is_(None))):
                self.fail(db, command, "网关关联已变更")
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id,
                            event="gateway_unlinked" if remove else "gateway_linked", target_device_id=windows_id,
                            created_at=int(time.time())))
            self.changed.notify_all()

    def permitted(self, db: Session, gateway_id: str, windows_id: str, action: str) -> bool:
        gateway, windows = db.get(Device, gateway_id), db.get(Device, windows_id)
        if (gateway is None or windows is None or gateway.owner_id != windows.owner_id or
                gateway.device_type != "gateway" or windows.device_type != "windows" or
                gateway.revoked_at is not None or windows.revoked_at is not None or not self.online(gateway)):
            return False
        target = self.target(gateway, windows_id)
        if target is None or db.get(DeviceLink, (gateway_id, windows_id, "wake_gateway")) is None:
            return False
        if action == "wake":
            return target["wol_capable"]
        return bool(target["relay_enabled"] and target["lan_state"] == "online" and
                    db.get(DeviceLink, (gateway_id, windows_id, "backup_relay")))

    def issue(self, owner_id: str, gateway_id: str, windows_id: str, action: str) -> dict:
        if action not in {"wake", "status", *POWER_ACTIONS}:
            raise ValueError("unknown action")
        now, command_id = int(time.time()), str(uuid.uuid4())
        route = "wake_gateway" if action == "wake" else "gateway_relay"
        with self.changed, self.sessions.begin() as db:
            target = db.get(Device, windows_id)
            if target is None or target.owner_id != owner_id or not self.permitted(db, gateway_id, windows_id, action):
                raise ConnectionError("gateway route unavailable")
            actions = POWER_ACTIONS if action in POWER_ACTIONS else {action}
            previous = db.scalar(select(func.max(Command.issued_at)).where(Command.target_device_id == windows_id, Command.action.in_(actions)))
            if previous is not None and now - previous < (2 if action == "status" else 15):
                raise BlockingIOError("command rate limit")
            db.add(GatewayCommand(id=command_id, gateway_id=gateway_id, target_device_id=windows_id, action=action,
                                 nonce=secrets.token_hex(16), issued_at=now, expires_at=now + 45))
            db.add(Command(id=command_id, owner_id=owner_id, target_device_id=windows_id, action=action,
                           route=route, state="accepted", issued_at=now, error=""))
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event="command_issued", target_device_id=windows_id,
                            route=route, created_at=now))
            self.changed.notify_all()
        return {"command_id": command_id, "accepted": True, "route": route, "state": "accepted"}

    @staticmethod
    def fail(db: Session, command: GatewayCommand, reason: str) -> None:
        command.result_ok, command.result_state, command.error = False, "failed", reason
        row = db.get(Command, command.id)
        if row is not None:
            row.state, row.error, row.completed_at = "failed", reason, int(time.time())

    def poll(self, gateway_id: str, timeout: float = 25) -> dict | None:
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                now = int(time.time())
                with self.sessions.begin() as db:
                    pending = list(db.scalars(select(GatewayCommand).where(
                        GatewayCommand.gateway_id == gateway_id, GatewayCommand.result_ok.is_(None)
                    ).order_by(GatewayCommand.issued_at, GatewayCommand.id)))
                    for command in pending:
                        if command.expires_at <= now or not self.permitted(db, gateway_id, command.target_device_id, command.action):
                            self.fail(db, command, "网关指令已过期或关联不可用")
                            continue
                        if command.delivered_at is not None and command.delivered_at > now - 10:
                            continue
                        claimed = db.execute(update(GatewayCommand).where(GatewayCommand.id == command.id,
                            GatewayCommand.result_ok.is_(None),
                            or_(GatewayCommand.delivered_at.is_(None), GatewayCommand.delivered_at <= now - 10)
                        ).values(delivered_at=now))
                        if claimed.rowcount:
                            return {"command_id": command.id, "gateway_id": gateway_id, "target_device_id": command.target_device_id,
                                    "action": command.action, "issued_at": command.issued_at,
                                    "expires_at": command.expires_at, "nonce": command.nonce}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.changed.wait(min(remaining, 1))

    def result(self, gateway_id: str, payload: dict) -> None:
        if (set(payload) != {"command_id", "ok", "state", "error"} or
                not isinstance(payload["command_id"], str) or len(payload["command_id"]) > 64 or
                type(payload["ok"]) is not bool or payload["state"] not in ("waking", "online", "transitioning", "failed") or
                not isinstance(payload["error"], str) or len(payload["error"]) > 160 or
                payload["ok"] == (payload["state"] == "failed")):
            raise ValueError("invalid gateway result")
        with self.changed, self.sessions.begin() as db:
            command = db.get(GatewayCommand, payload["command_id"])
            if command is None or command.gateway_id != gateway_id or command.delivered_at is None:
                raise ValueError("unknown gateway command")
            if command.result_ok is not None:
                if (command.result_ok, command.result_state, command.error) == (payload["ok"], payload["state"], payload["error"]):
                    return
                raise ValueError("conflicting gateway result")
            expected_state = "waking" if command.action == "wake" else "online" if command.action == "status" else "transitioning"
            if payload["ok"] and payload["state"] != expected_state:
                raise ValueError("invalid action result")
            command.result_ok, command.result_state, command.error = payload["ok"], payload["state"], payload["error"]
            row = db.get(Command, command.id)
            row.state = "failed" if not payload["ok"] else "transitioning" if payload["state"] == "transitioning" else "completed"
            row.error, row.completed_at = payload["error"], int(time.time())
