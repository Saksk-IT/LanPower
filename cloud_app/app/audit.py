"""Record known credential failures without storing submitted credentials."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from cloud_app.app.models import AuditLog

FAILURE_AUDIT_SECONDS = 300


def credential_failure(db: Session, owner_id: str, event: str, now: int,
                       device_id: str | None = None) -> None:
    # Database identities are trusted; never attribute guessed tokens or IDs.
    # A disconnected agent can retry often, so coalesce recent failures.
    recent = db.scalar(select(AuditLog.id).where(
        AuditLog.owner_id == owner_id, AuditLog.event == event,
        AuditLog.target_device_id == device_id,
        AuditLog.created_at > now - FAILURE_AUDIT_SECONDS).limit(1))
    if recent is None:
        db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id, event=event,
                        target_device_id=device_id, created_at=now))
