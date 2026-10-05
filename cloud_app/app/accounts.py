"""One account across Web, Windows and mobile, with independent native credentials."""
from __future__ import annotations

import re
import secrets
import time
import uuid

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from cloud_app.app.auth import digest
from cloud_app.app.clients import CLIENT_ACTIONS
from cloud_app.app.device_auth import ACCESS_SECONDS, DeviceTokens
from cloud_app.app.models import AccountConnection, AuditLog, ClientSession, Device, DeviceSession, User, WebSession
from cloud_app.app.platform import ADMIN_ID
from cloud_app.password import hash_password, verify_password


class AccountConflict(ValueError):
    pass


class Accounts:
    def __init__(self, platform):
        self.platform = platform
        self.sessions = platform.sessions
        self.dummy_hash = hash_password(secrets.token_urlsafe(32))

    @staticmethod
    def username(value: str) -> str:
        return value.strip().lower()

    def password_enabled(self, owner: User) -> bool:
        return owner.account_password_enabled or (owner.id == ADMIN_ID and self.platform.settings.admin_password_hash is not None)

    def has_password_accounts(self) -> bool:
        if self.platform.settings.admin_password_hash is not None:
            return True
        with self.sessions() as db:
            return db.scalar(select(User.id).where(User.account_password_enabled.is_(True), User.revoked_at.is_(None)).limit(1)) is not None

    def authenticate(self, username, password) -> User:
        if not isinstance(username, str) or len(username) > 80 or not isinstance(password, str) or len(password) > 256:
            raise PermissionError("账号或密码不正确")
        with self.sessions() as db:
            owner = db.scalar(select(User).where(User.username == self.username(username), User.revoked_at.is_(None)))
            enabled = owner is not None and self.password_enabled(owner)
            valid = verify_password(password, owner.password_hash if enabled else self.dummy_hash)
            if not enabled or not valid:
                raise PermissionError("账号或密码不正确")
            return owner

    @staticmethod
    def validate_password(password) -> None:
        if not isinstance(password, str) or not 12 <= len(password) <= 256:
            raise ValueError("密码需要 12 至 256 个字符")

    def register(self, payload: dict) -> User:
        if not self.platform.settings.allow_registration:
            raise PermissionError("此 Cloud 暂未开放账号注册，请联系部署者")
        if set(payload) != {"username", "password"} or not isinstance(payload["username"], str):
            raise ValueError("请填写账号和密码")
        username = self.username(payload["username"])
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,39}", username) or username == "admin":
            raise ValueError("账号需为 3 至 40 位字母、数字、点、下划线或短横线；admin 为保留账号")
        self.validate_password(payload["password"])
        now = int(time.time())
        owner = User(id=str(uuid.uuid4()), username=username, password_hash=hash_password(payload["password"]),
                     account_password_enabled=True, identity_initialized_at=now, created_at=now)
        try:
            with self.sessions.begin() as db:
                db.add(owner)
                db.flush()
                db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner.id, event="account_registered", created_at=now))
        except IntegrityError as error:
            raise AccountConflict("此账号已被使用，请登录或更换账号") from error
        return owner

    def set_password(self, session, current_password, password) -> None:
        self.validate_password(password)
        now = int(time.time())
        encoded = hash_password(password)
        with self.sessions.begin() as db:
            owner = db.get(User, session.owner_id)
            if owner is None or owner.revoked_at is not None:
                raise PermissionError("账号不可用")
            if owner.id == ADMIN_ID and self.platform.settings.admin_password_hash is not None:
                raise ValueError("此账号密码由部署配置管理，请由部署者修改")
            fresh_identity = session.auth_method in {"passkey", "recovery"} and session.created_at > now - 300
            if self.password_enabled(owner) and not fresh_identity:
                if not isinstance(current_password, str) or len(current_password) > 256 or not verify_password(current_password, owner.password_hash):
                    raise PermissionError("当前密码不正确；也可重新使用 Passkey 或恢复码登录后设置")
            owner.password_hash = encoded
            owner.account_password_enabled = True
            db.execute(delete(WebSession).where(WebSession.owner_id == owner.id, WebSession.token_hash != session.token_hash))
            # Only revoke connections created by account login. Legacy pairing
            # remains valid, and all device identifiers and records stay intact.
            connections = list(db.scalars(select(AccountConnection).where(AccountConnection.owner_id == owner.id)))
            devices = [row.device_id for row in connections if row.device_id]
            clients = [row.client_id for row in connections if row.client_id]
            if devices:
                db.execute(update(DeviceSession).where(DeviceSession.device_id.in_(devices)).values(revoked_at=now))
            if clients:
                db.execute(update(ClientSession).where(ClientSession.id.in_(clients)).values(revoked_at=now))
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner.id, event="account_password_changed", created_at=now))

    def connect(self, owner: User, payload: dict) -> dict:
        try:
            return self._connect(owner, payload)
        except IntegrityError as error:
            raise AccountConflict("连接已变化，请重新登录") from error

    def _connect(self, owner: User, payload: dict) -> dict:
        required = {"username", "password", "client_type", "connection_key", "name", "version", "protocol_version"}
        if set(payload) not in (required, required | {"previous"}):
            raise ValueError("登录请求无效")
        kind, key, name, version = (payload[field] for field in ("client_type", "connection_key", "name", "version"))
        if (not isinstance(kind, str) or kind not in {"windows", "mobile"} or not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", key)
                or not isinstance(name, str) or not 1 <= len(name.strip()) <= 100
                or not isinstance(version, str) or len(version) > 32
                or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", version)
                or payload["protocol_version"] != "2"):
            raise ValueError("登录请求无效或版本不受支持")
        previous = payload.get("previous")
        if previous is not None and (not isinstance(previous, dict) or set(previous) != {"id", "refresh_token"}
                or not isinstance(previous["id"], str) or len(previous["id"]) > 64
                or not isinstance(previous["refresh_token"], str) or not 32 <= len(previous["refresh_token"]) <= 128):
            raise ValueError("原连接凭据无效")
        now = int(time.time())
        with self.sessions.begin() as db:
            # Serialize connections before reading the stable installation key.
            # Also reject a password change/revocation racing this login.
            changed = db.execute(update(User).where(User.id == owner.id, User.revoked_at.is_(None),
                User.password_hash == owner.password_hash).values(username=User.username))
            if changed.rowcount != 1:
                raise PermissionError("账号状态已变化，请重新登录")
            connection = db.get(AccountConnection, digest(key))
            if connection and (connection.owner_id != owner.id or connection.client_type != kind):
                raise AccountConflict("当前连接属于其他账号，请先退出当前账号后再登录")
            old = None
            if previous is not None:
                model = DeviceSession if kind == "windows" else ClientSession
                identifier = model.device_id if kind == "windows" else model.id
                old = db.scalar(select(model).where(identifier == previous["id"], model.refresh_hash == digest(previous["refresh_token"])))
                # The stable installation key already proves this connection.
                # A lost mobile login response can leave the caller holding the
                # previous refresh token after its row has been rotated in place.
                mapped_id = connection.device_id if connection and kind == "windows" else connection.client_id if connection else None
                if (old is None and mapped_id != previous["id"]) or (old is not None and old.owner_id != owner.id):
                    raise AccountConflict("当前连接属于其他账号或凭据已失效，请先退出当前账号")
            if kind == "windows":
                device_id = connection.device_id if connection else old.device_id if old else None
                device = db.get(Device, device_id) if device_id else None
                if device and (device.owner_id != owner.id or device.device_type != "windows"):
                    raise AccountConflict("电脑归属不一致，请先退出当前账号")
                if device is None or device.revoked_at is not None:
                    device = Device(id=str(uuid.uuid4()), owner_id=owner.id, device_type="windows", name=name.strip(),
                                    version=version, protocol_version="2", created_at=now, meta={})
                    db.add(device)
                    db.flush()
                else:
                    device.version = version
                db.execute(update(DeviceSession).where(DeviceSession.device_id == device.id, DeviceSession.revoked_at.is_(None)).values(revoked_at=now))
                result = DeviceTokens.issue(db, owner.id, device.id, now)
                target_id = device.id
            else:
                client_id = connection.client_id if connection else old.id if old else None
                client = db.get(ClientSession, client_id) if client_id else None
                access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
                if client is None or client.revoked_at is not None:
                    client = ClientSession(id=str(uuid.uuid4()), owner_id=owner.id, name=name.strip(), created_at=now)
                    db.add(client)
                client.version, client.protocol_version = version, "2"
                client.allowed_actions = ",".join(CLIENT_ACTIONS)
                client.access_hash, client.refresh_hash = digest(access), digest(refresh)
                client.access_expires_at, client.refresh_expires_at, client.last_seen_at = now + ACCESS_SECONDS, None, now
                db.flush()
                result = {"client_id": client.id, "access_token": access, "refresh_token": refresh, "access_expires_at": now + ACCESS_SECONDS}
                target_id = client.id
            if connection is None:
                connection = AccountConnection(key_hash=digest(key), owner_id=owner.id, client_type=kind)
                db.add(connection)
            connection.device_id = target_id if kind == "windows" else None
            connection.client_id = target_id if kind == "mobile" else None
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner.id, event="account_login",
                            target_device_id=target_id if kind == "windows" else None, created_at=now))
        return {**result, "account": {"id": owner.id, "username": owner.username}}
