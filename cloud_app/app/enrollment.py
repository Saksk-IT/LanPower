"""Short human confirmation codes cannot be exchanged for device credentials."""

from __future__ import annotations

import secrets
import time
import uuid

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session, sessionmaker

from cloud_app.app.auth import digest
from cloud_app.app.device_auth import DeviceTokens
from cloud_app.app.models import AuditLog, Device, DeviceAuthorization, User

ENROLL_SECONDS = 600
POLL_SECONDS = 5
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class EnrollmentError(ValueError):
    pass


class Enrollment:
    def __init__(self, sessions: sessionmaker[Session], public_url: str):
        self.sessions, self.public_url = sessions, public_url.rstrip("/")

    def start(self, payload: dict) -> dict:
        if (set(payload) != {"device_type", "name", "version", "protocol_version"} or
                not isinstance(payload["device_type"], str) or payload["device_type"] not in {"windows", "gateway"} or
                not isinstance(payload["name"], str) or not 1 <= len(payload["name"].strip()) <= 100 or
                not isinstance(payload["version"], str) or not 1 <= len(payload["version"]) <= 32 or
                payload["protocol_version"] != "2"):
            raise ValueError("invalid enrollment request")
        now = int(time.time())
        device_code = secrets.token_urlsafe(32)
        raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        user_code = raw[:4] + "-" + raw[4:]
        with self.sessions.begin() as db:
            db.execute(delete(DeviceAuthorization).where(DeviceAuthorization.expires_at < now - 86400))
            db.add(DeviceAuthorization(code_hash=digest(device_code), user_code_hash=digest(raw),
                                       name=payload["name"].strip(), device_type=payload["device_type"],
                                       version=payload["version"], created_at=now, expires_at=now + ENROLL_SECONDS,
                                       next_poll_at=0))
        return {"device_code": device_code, "user_code": user_code,
                "verification_uri": self.public_url + "/enroll", "expires_in": ENROLL_SECONDS,
                "interval": POLL_SECONDS}

    @staticmethod
    def user_hash(code: str) -> str:
        normalized = code.replace("-", "").replace(" ", "").upper()
        if len(normalized) != 8 or any(char not in CODE_ALPHABET for char in normalized):
            raise ValueError("配对码无效或已过期")
        return digest(normalized)

    def lookup(self, code: str) -> dict:
        with self.sessions() as db:
            row = db.scalar(select(DeviceAuthorization).where(
                DeviceAuthorization.user_code_hash == self.user_hash(code),
                DeviceAuthorization.expires_at > int(time.time()), DeviceAuthorization.owner_id.is_(None)))
            if row is None:
                raise ValueError("配对码无效、已处理或已过期")
            return {"name": row.name, "device_type": row.device_type, "version": row.version}

    def decide(self, owner_id: str, code: str, *, approved: bool) -> None:
        now = int(time.time())
        with self.sessions.begin() as db:
            owner = db.get(User, owner_id)
            if owner is None or owner.revoked_at is not None:
                raise ValueError("管理员不可用")
            values = {"owner_id": owner_id, "approved_at" if approved else "denied_at": now}
            changed = db.execute(update(DeviceAuthorization).where(
                DeviceAuthorization.user_code_hash == self.user_hash(code),
                DeviceAuthorization.owner_id.is_(None), DeviceAuthorization.expires_at > now).values(**values))
            if changed.rowcount != 1:
                raise ValueError("配对码无效、已处理或已过期")
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id,
                            event="enrollment_approved" if approved else "enrollment_denied", created_at=now))

    def exchange(self, payload: dict) -> dict:
        if (set(payload) != {"device_code"} or not isinstance(payload["device_code"], str) or
                not 32 <= len(payload["device_code"]) <= 128):
            raise EnrollmentError("invalid_grant")
        now = int(time.time())
        error = None
        result = None
        with self.sessions.begin() as db:
            row = db.get(DeviceAuthorization, digest(payload["device_code"]))
            if row is None or row.redeemed_at is not None:
                raise EnrollmentError("invalid_grant")
            if row.expires_at <= now:
                raise EnrollmentError("expired_token")
            if row.denied_at is not None:
                raise EnrollmentError("access_denied")
            if row.next_poll_at > now:
                raise EnrollmentError("slow_down")
            if row.approved_at is None:
                changed = db.execute(update(DeviceAuthorization).where(
                    DeviceAuthorization.code_hash == row.code_hash,
                    DeviceAuthorization.next_poll_at <= now).values(next_poll_at=now + POLL_SECONDS))
                error = "authorization_pending" if changed.rowcount else "slow_down"
            else:
                changed = db.execute(update(DeviceAuthorization).where(
                    DeviceAuthorization.code_hash == row.code_hash,
                    DeviceAuthorization.redeemed_at.is_(None), DeviceAuthorization.expires_at > now
                ).values(redeemed_at=now))
                if changed.rowcount != 1:
                    raise EnrollmentError("invalid_grant")
                device_id = str(uuid.uuid4())
                db.add(Device(id=device_id, owner_id=row.owner_id, device_type=row.device_type,
                              name=row.name, version=row.version, protocol_version="2", created_at=now, meta={}))
                result = DeviceTokens.issue(db, row.owner_id, device_id, now)
                db.add(AuditLog(id=str(uuid.uuid4()), owner_id=row.owner_id, event="device_enrolled",
                                target_device_id=device_id, created_at=now))
        if error:
            raise EnrollmentError(error)
        return result
