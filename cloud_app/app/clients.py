"""Mobile client credentials are independent from browser and device credentials."""
from __future__ import annotations

import secrets
import re
import time
import uuid

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from cloud_app.app.audit import credential_failure
from cloud_app.app.auth import digest
from cloud_app.app.device_auth import ACCESS_SECONDS
from cloud_app.app.models import AuditLog, ClientEnrollment, ClientSession, UsedClientRefreshToken, User

CLIENT_ACTIONS = ("status", "sleep", "hibernate", "restart", "shutdown", "wake")


def normalize_actions(actions: list[str] | None) -> str:
    # Missing scopes preserve the old full-access enrollment API. An explicitly
    # empty selection must never become an unrestricted authorization.
    if actions is None:
        return ""
    if (not isinstance(actions, list) or not actions or
            any(not isinstance(action, str) or action not in CLIENT_ACTIONS for action in actions)):
        raise ValueError("请至少选择一项有效的客户端权限")
    return ",".join(action for action in CLIENT_ACTIONS if action in actions)


class Clients:
    def __init__(self, sessions: sessionmaker[Session]):
        self.sessions = sessions

    @staticmethod
    def active(db: Session, owner_id: str) -> bool:
        user = db.get(User, owner_id)
        return user is not None and user.revoked_at is None

    @staticmethod
    def audit(db: Session, owner_id: str, event: str) -> None:
        db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event=event, created_at=int(time.time())))

    def create_enrollment(self, owner_id: str, name: str, allowed_actions: list[str] | None = None) -> str:
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError("请填写客户端名称，最多 100 个字")
        scopes = normalize_actions(allowed_actions)
        code, now = secrets.token_urlsafe(32), int(time.time())
        with self.sessions.begin() as db:
            if not self.active(db, owner_id):
                raise PermissionError("administrator unavailable")
            # A newly displayed QR replaces all unclaimed QR codes for this owner.
            db.execute(delete(ClientEnrollment).where(ClientEnrollment.owner_id == owner_id))
            db.add(ClientEnrollment(code_hash=digest(code), owner_id=owner_id, name=name.strip(),
                                    allowed_actions=scopes, expires_at=now + 600))
            self.audit(db, owner_id, "client_enrollment_created")
        return code

    def enroll(self, payload: dict) -> dict:
        if (set(payload) not in ({"code"}, {"code", "version", "protocol_version"}) or
                not isinstance(payload["code"], str) or not 32 <= len(payload["code"]) <= 128):
            raise ValueError("invalid enrollment")
        version, protocol = payload.get("version", ""), payload.get("protocol_version", "2")
        if (protocol != "2" or not isinstance(version, str) or len(version) > 32 or
                ("version" in payload and not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", version))):
            raise ValueError("invalid client version or unsupported protocol")
        now = int(time.time())
        with self.sessions.begin() as db:
            enrollment = db.get(ClientEnrollment, digest(payload["code"]))
            if enrollment is None or not self.active(db, enrollment.owner_id):
                raise ValueError("enrollment unavailable")
            changed = db.execute(update(ClientEnrollment).where(
                ClientEnrollment.code_hash == enrollment.code_hash, ClientEnrollment.used_at.is_(None),
                ClientEnrollment.expires_at > now).values(used_at=now))
            if changed.rowcount != 1:
                raise ValueError("enrollment unavailable")
            client_id, access, refresh = str(uuid.uuid4()), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            db.add(ClientSession(id=client_id, owner_id=enrollment.owner_id, name=enrollment.name,
                                 version=version, protocol_version=protocol,
                                 allowed_actions=enrollment.allowed_actions,
                                 access_hash=digest(access), refresh_hash=digest(refresh),
                                 access_expires_at=now + ACCESS_SECONDS, refresh_expires_at=None,
                                 created_at=now, last_seen_at=now))
            self.audit(db, enrollment.owner_id, "client_enrolled")
        return {"client_id": client_id, "access_token": access, "refresh_token": refresh,
                "access_expires_at": now + ACCESS_SECONDS}

    def authorize(self, token: str) -> tuple[str, str]:
        if not token or len(token) > 128:
            raise PermissionError("client unauthorized")
        now, result = int(time.time()), None
        with self.sessions.begin() as db:
            client = db.scalar(select(ClientSession).where(
                ClientSession.access_hash == digest(token)))
            if client is not None:
                if (client.access_expires_at > now and client.revoked_at is None
                        and self.active(db, client.owner_id)):
                    if client.last_seen_at is None or client.last_seen_at < now - 60:
                        client.last_seen_at = now
                    result = client.owner_id, client.id
                else:
                    credential_failure(db, client.owner_id, "client_credential_failed", now)
        if result is None:
            raise PermissionError("client unauthorized")
        return result

    def permits(self, client_id: str, action: str) -> bool:
        with self.sessions() as db:
            client = db.get(ClientSession, client_id)
            return bool(client and client.revoked_at is None and
                        (not client.allowed_actions or action in client.allowed_actions.split(",")))

    def revoke_reuse(self, db: Session, token_hash: str, client_id: str) -> None:
        used = db.get(UsedClientRefreshToken, token_hash)
        if used is None or used.session_id != client_id:
            return
        client = db.get(ClientSession, client_id)
        changed = db.execute(update(ClientSession).where(
            ClientSession.id == client_id, ClientSession.revoked_at.is_(None)).values(revoked_at=int(time.time())))
        if changed.rowcount:
            self.audit(db, client.owner_id, "client_refresh_reuse")

    def refresh(self, payload: dict) -> dict:
        """Legacy rotation endpoint; new phones use retryable renew instead."""
        if (set(payload) != {"client_id", "refresh_token"} or
                not all(isinstance(value, str) for value in payload.values()) or
                len(payload["client_id"]) > 64 or not 1 <= len(payload["refresh_token"]) <= 128):
            raise ValueError("invalid refresh request")
        now, result = int(time.time()), None
        submitted = digest(payload["refresh_token"])
        with self.sessions.begin() as db:
            client = db.scalar(select(ClientSession).where(
                ClientSession.id == payload["client_id"], ClientSession.refresh_hash == submitted))
            if client is None:
                self.revoke_reuse(db, submitted, payload["client_id"])
            elif ((client.refresh_expires_at is not None and client.refresh_expires_at <= now) or client.revoked_at is not None
                    or not self.active(db, client.owner_id)):
                credential_failure(db, client.owner_id, "client_credential_failed", now)
            else:
                access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
                changed = db.execute(update(ClientSession).where(
                    ClientSession.id == client.id, ClientSession.refresh_hash == submitted,
                    or_(ClientSession.refresh_expires_at.is_(None), ClientSession.refresh_expires_at > now),
                    ClientSession.revoked_at.is_(None)
                ).values(access_hash=digest(access), refresh_hash=digest(refresh),
                         access_expires_at=now + ACCESS_SECONDS, refresh_expires_at=None))
                if changed.rowcount:
                    db.add(UsedClientRefreshToken(token_hash=submitted, session_id=client.id, used_at=now))
                    self.audit(db, client.owner_id, "client_refresh_rotated")
                    result = {"client_id": client.id, "access_token": access, "refresh_token": refresh,
                              "access_expires_at": now + ACCESS_SECONDS}
                else:
                    self.revoke_reuse(db, submitted, payload["client_id"])
        if result is None:
            raise PermissionError("client refresh unavailable")
        return result

    def renew(self, payload: dict) -> dict:
        """Renew short-lived access without consuming the phone's authorization.

        A separate endpoint lets phones retry after a lost response or restart,
        even when upgrading from a pending legacy refresh. An older Cloud will
        reject this route without consuming its single-use refresh token.
        """
        if (set(payload) != {"client_id", "refresh_token"} or
                not all(isinstance(value, str) for value in payload.values()) or
                len(payload["client_id"]) > 64 or not 1 <= len(payload["refresh_token"]) <= 128):
            raise ValueError("invalid renewal request")
        now, result = int(time.time()), None
        submitted = digest(payload["refresh_token"])
        with self.sessions.begin() as db:
            client = db.scalar(select(ClientSession).where(
                ClientSession.id == payload["client_id"], ClientSession.refresh_hash == submitted))
            if client is not None:
                if ((client.refresh_expires_at is not None and client.refresh_expires_at <= now)
                        or client.revoked_at is not None or not self.active(db, client.owner_id)):
                    credential_failure(db, client.owner_id, "client_credential_failed", now)
                else:
                    access = secrets.token_urlsafe(32)
                    changed = db.execute(update(ClientSession).where(
                        ClientSession.id == client.id, ClientSession.refresh_hash == submitted,
                        ClientSession.revoked_at.is_(None),
                        or_(ClientSession.refresh_expires_at.is_(None), ClientSession.refresh_expires_at > now)
                    ).values(access_hash=digest(access), access_expires_at=now + ACCESS_SECONDS,
                             last_seen_at=now))
                    if changed.rowcount:
                        result = {"client_id": client.id, "access_token": access,
                                  "refresh_token": payload["refresh_token"], "access_expires_at": now + ACCESS_SECONDS}
        if result is None:
            raise PermissionError("client renewal unavailable")
        return result

    def list(self, owner_id: str) -> list[ClientSession]:
        with self.sessions() as db:
            return list(db.scalars(select(ClientSession).where(
                ClientSession.owner_id == owner_id, ClientSession.revoked_at.is_(None)).order_by(ClientSession.created_at)))

    def revoke(self, owner_id: str, client_id: str) -> None:
        with self.sessions.begin() as db:
            changed = db.execute(update(ClientSession).where(
                ClientSession.id == client_id, ClientSession.owner_id == owner_id,
                ClientSession.revoked_at.is_(None)).values(revoked_at=int(time.time())))
            if changed.rowcount != 1:
                raise ValueError("client unavailable")
            self.audit(db, owner_id, "client_revoked")
