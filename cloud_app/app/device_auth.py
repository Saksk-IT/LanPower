"""Independent device sessions shared by Windows and Wake Gateways."""

from __future__ import annotations

import secrets
import time
import uuid

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from cloud_app.app.audit import credential_failure
from cloud_app.app.auth import digest
from cloud_app.app.models import AuditLog, Device, DeviceSession, UsedRefreshToken, User

ACCESS_SECONDS = 15 * 60
REFRESH_SECONDS = 30 * 86400


class DeviceTokens:
    def __init__(self, sessions: sessionmaker[Session]):
        self.sessions = sessions

    @staticmethod
    def issue(db: Session, owner_id: str, device_id: str, now: int) -> dict:
        owner = db.get(User, owner_id)
        if owner is None or owner.revoked_at is not None:
            raise PermissionError("administrator unavailable")
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        db.add(DeviceSession(id=str(uuid.uuid4()), owner_id=owner_id, device_id=device_id,
                             access_hash=digest(access), refresh_hash=digest(refresh),
                             access_expires_at=now + ACCESS_SECONDS,
                             refresh_expires_at=now + REFRESH_SECONDS, generation=0))
        return {"device_id": device_id, "access_token": access, "refresh_token": refresh,
                "access_expires_at": now + ACCESS_SECONDS}

    @staticmethod
    def active(db: Session, session: DeviceSession, expected_type: str | None = None) -> bool:
        device, owner = db.get(Device, session.device_id), db.get(User, session.owner_id)
        return bool(device and owner and device.owner_id == owner.id and
                    device.revoked_at is None and owner.revoked_at is None and
                    (expected_type is None or device.device_type == expected_type))

    def authorize(self, token: str | None, *, expected_type: str) -> tuple[str, str]:
        if not token or len(token) > 128:
            raise PermissionError("device unauthorized")
        now, result = int(time.time()), None
        with self.sessions.begin() as db:
            session = db.scalar(select(DeviceSession).where(
                DeviceSession.access_hash == digest(token)))
            if session is not None:
                if (session.access_expires_at > now and session.revoked_at is None
                        and self.active(db, session, expected_type)):
                    result = session.owner_id, session.device_id
                else:
                    credential_failure(db, session.owner_id, "device_credential_failed", now, session.device_id)
        # Commit the audit event before returning the rejected request.
        if result is None:
            raise PermissionError("device unauthorized")
        return result

    def _revoke_reused(self, db: Session, submitted_hash: str, device_id: str) -> None:
        used = db.get(UsedRefreshToken, submitted_hash)
        if used is None:
            return
        compromised = db.get(DeviceSession, used.session_id)
        if compromised is None or compromised.device_id != device_id:
            return
        now = int(time.time())
        changed = db.execute(update(DeviceSession).where(
            DeviceSession.id == compromised.id, DeviceSession.revoked_at.is_(None)).values(revoked_at=now))
        if changed.rowcount:
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=compromised.owner_id,
                            event="refresh_reuse", target_device_id=compromised.device_id, created_at=now))

    def refresh(self, payload: dict, *, expected_type: str | None = None) -> dict:
        if (set(payload) != {"device_id", "refresh_token"} or
                not all(isinstance(value, str) for value in payload.values()) or
                not 1 <= len(payload["refresh_token"]) <= 128 or len(payload["device_id"]) > 64):
            raise ValueError("invalid refresh request")
        now = int(time.time())
        submitted_hash = digest(payload["refresh_token"])
        result = None
        with self.sessions.begin() as db:
            session = db.scalar(select(DeviceSession).where(
                DeviceSession.device_id == payload["device_id"], DeviceSession.refresh_hash == submitted_hash))
            if session is None:
                self._revoke_reused(db, submitted_hash, payload["device_id"])
            elif (session.revoked_at is not None or session.refresh_expires_at <= now
                    or not self.active(db, session, expected_type)):
                credential_failure(db, session.owner_id, "device_credential_failed", now, session.device_id)
            else:
                access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
                changed = db.execute(update(DeviceSession).where(
                    DeviceSession.id == session.id, DeviceSession.refresh_hash == submitted_hash,
                    DeviceSession.revoked_at.is_(None), DeviceSession.refresh_expires_at > now
                ).values(access_hash=digest(access), refresh_hash=digest(refresh),
                         access_expires_at=now + ACCESS_SECONDS, refresh_expires_at=now + REFRESH_SECONDS,
                         generation=DeviceSession.generation + 1))
                if changed.rowcount == 1:
                    db.add(UsedRefreshToken(token_hash=submitted_hash, session_id=session.id, used_at=now))
                    db.add(AuditLog(id=str(uuid.uuid4()), owner_id=session.owner_id,
                                    event="refresh_rotated", target_device_id=session.device_id, created_at=now))
                    result = {"device_id": session.device_id, "access_token": access, "refresh_token": refresh,
                              "access_expires_at": now + ACCESS_SECONDS}
                else:
                    self._revoke_reused(db, submitted_hash, payload["device_id"])
        # Reuse revocation must commit even though the request is rejected.
        if result is None:
            raise PermissionError("refresh unavailable")
        return result

    def renew(self, payload: dict, *, expected_type: str | None = None) -> dict:
        """Renew short-lived access without consuming the device authorization.

        The retryable endpoint lets a device recover when Cloud committed a
        renewal but the response or the local credential write was interrupted.
        The long-lived refresh token remains unchanged and is never recorded as
        used, so a restart can safely submit it again.
        """
        if (set(payload) != {"device_id", "refresh_token"} or
                not all(isinstance(value, str) for value in payload.values()) or
                not 1 <= len(payload["refresh_token"]) <= 128 or len(payload["device_id"]) > 64):
            raise ValueError("invalid renewal request")
        now, result = int(time.time()), None
        submitted_hash = digest(payload["refresh_token"])
        with self.sessions.begin() as db:
            session = db.scalar(select(DeviceSession).where(
                DeviceSession.device_id == payload["device_id"], DeviceSession.refresh_hash == submitted_hash))
            if session is not None:
                if (session.revoked_at is not None or session.refresh_expires_at <= now
                        or not self.active(db, session, expected_type)):
                    credential_failure(db, session.owner_id, "device_credential_failed", now, session.device_id)
                else:
                    access = secrets.token_urlsafe(32)
                    changed = db.execute(update(DeviceSession).where(
                        DeviceSession.id == session.id, DeviceSession.refresh_hash == submitted_hash,
                        DeviceSession.revoked_at.is_(None), DeviceSession.refresh_expires_at > now
                    ).values(access_hash=digest(access), access_expires_at=now + ACCESS_SECONDS,
                             refresh_expires_at=now + REFRESH_SECONDS))
                    if changed.rowcount == 1:
                        result = {"device_id": session.device_id, "access_token": access,
                                  "refresh_token": payload["refresh_token"],
                                  "access_expires_at": now + ACCESS_SECONDS}
        if result is None:
            raise PermissionError("device renewal unavailable")
        return result
