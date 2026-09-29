from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, JSON, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[int] = mapped_column(Integer)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    identity_initialized_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    device_type: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str] = mapped_column(String(100))
    version: Mapped[str] = mapped_column(String(32), default="")
    protocol_version: Mapped[str] = mapped_column(String(16), default="1")
    created_at: Mapped[int] = mapped_column(Integer)
    last_seen_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    legacy_gateway_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class DeviceLink(Base):
    __tablename__ = "device_links"

    gateway_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)
    windows_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)
    relationship: Mapped[str] = mapped_column(String(24), primary_key=True)
    created_at: Mapped[int] = mapped_column(Integer)


class WebSession(Base):
    __tablename__ = "web_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer, index=True)


class Passkey(Base):
    __tablename__ = "passkeys"

    credential_id: Mapped[str] = mapped_column(String(2048), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    public_key: Mapped[str] = mapped_column(String(2048))
    sign_count: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[int] = mapped_column(Integer)
    last_used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    backed_up: Mapped[bool] = mapped_column(default=False)


class RecoveryCode(Base):
    __tablename__ = "recovery_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[int] = mapped_column(Integer)
    used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AuthChallenge(Base):
    __tablename__ = "auth_challenges"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    challenge: Mapped[str] = mapped_column(String(128))
    purpose: Mapped[str] = mapped_column(String(16))
    binding_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class LegacyClient(Base):
    __tablename__ = "legacy_clients"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    credential_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[int] = mapped_column(Integer)


class ClientSession(Base):
    __tablename__ = "client_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    access_hash: Mapped[str] = mapped_column(String(64), unique=True)
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    access_expires_at: Mapped[int] = mapped_column(Integer)
    refresh_expires_at: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[int] = mapped_column(Integer)
    last_seen_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ClientEnrollment(Base):
    __tablename__ = "client_enrollments"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    expires_at: Mapped[int] = mapped_column(Integer)
    used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class UsedClientRefreshToken(Base):
    __tablename__ = "used_client_refresh_tokens"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("client_sessions.id"), index=True)
    used_at: Mapped[int] = mapped_column(Integer)


class EnrollmentSession(Base):
    __tablename__ = "enrollment_sessions"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    device_type: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class DeviceSession(Base):
    __tablename__ = "device_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    access_hash: Mapped[str] = mapped_column(String(64), unique=True)
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    access_expires_at: Mapped[int] = mapped_column(Integer)
    refresh_expires_at: Mapped[int] = mapped_column(Integer)
    generation: Mapped[int] = mapped_column(Integer, default=0)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class DeviceAuthorization(Base):
    __tablename__ = "device_authorizations"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    device_type: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(100))
    version: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer, index=True)
    next_poll_at: Mapped[int] = mapped_column(Integer)
    approved_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    denied_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    redeemed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class UsedRefreshToken(Base):
    __tablename__ = "used_refresh_tokens"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("device_sessions.id"), index=True)
    used_at: Mapped[int] = mapped_column(Integer)


class DeviceHeartbeat(Base):
    __tablename__ = "heartbeats"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    seen_at: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(16))
    uptime: Mapped[int] = mapped_column(Integer)
    lan_ip: Mapped[str] = mapped_column(String(45))
    wol_capable: Mapped[bool] = mapped_column()


class DeviceCommand(Base):
    __tablename__ = "device_commands"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    target_device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    action: Mapped[str] = mapped_column(String(16))
    nonce: Mapped[str] = mapped_column(String(32), unique=True)
    issued_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    delivered_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    result_ok: Mapped[bool | None] = mapped_column(nullable=True)
    result_state: Mapped[str | None] = mapped_column(String(24), nullable=True)
    error: Mapped[str | None] = mapped_column(String(160), nullable=True)


class Command(Base):
    __tablename__ = "platform_commands"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    target_device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    action: Mapped[str] = mapped_column(String(16))
    route: Mapped[str] = mapped_column(String(24))
    state: Mapped[str] = mapped_column(String(24))
    issued_at: Mapped[int] = mapped_column(Integer)
    completed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str] = mapped_column(String(160), default="")


class GatewayCommand(Base):
    __tablename__ = "gateway_commands"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    gateway_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    target_device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    action: Mapped[str] = mapped_column(String(16))
    nonce: Mapped[str] = mapped_column(String(32), unique=True)
    issued_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    delivered_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    result_ok: Mapped[bool | None] = mapped_column(nullable=True)
    result_state: Mapped[str | None] = mapped_column(String(24), nullable=True)
    error: Mapped[str | None] = mapped_column(String(160), nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    event: Mapped[str] = mapped_column(String(40))
    target_device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    route: Mapped[str | None] = mapped_column(String(24), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer)
