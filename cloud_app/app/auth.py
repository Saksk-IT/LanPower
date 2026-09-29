from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from urllib.parse import parse_qs

from fastapi import HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from cloud_app.app.models import User, WebSession
from cloud_app.password import hash_password, verify_password

SESSION_SECONDS = 8 * 3600


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


async def read_limited(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "request too large")
        body.extend(chunk)
    return bytes(body)


async def parse_form(request: Request) -> dict[str, str]:
    if request.headers.get("content-type", "").split(";", 1)[0] != "application/x-www-form-urlencoded":
        raise HTTPException(415, "unsupported form")
    body = await read_limited(request, 4096)
    try:
        values = parse_qs(body.decode("utf-8"), keep_blank_values=True, strict_parsing=True)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(400, "invalid form") from exc
    if any(len(items) != 1 for items in values.values()):
        raise HTTPException(400, "duplicate form field")
    return {key: items[0] for key, items in values.items()}


def create_session(db: Session, owner: User) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    now = int(time.time())
    db.execute(delete(WebSession).where(WebSession.expires_at < now))
    db.add(WebSession(token_hash=digest(token), owner_id=owner.id, csrf_hash=digest(csrf),
                      created_at=now, expires_at=now + SESSION_SECONDS))
    db.commit()
    return token, csrf


def current_session(request: Request, db: Session) -> WebSession | None:
    token = request.cookies.get("lp_session", "")
    if not token or len(token) > 128:
        return None
    session = db.get(WebSession, digest(token))
    return session if session and session.expires_at > int(time.time()) else None


def require_csrf(request: Request, session: WebSession, form: dict[str, str]) -> None:
    cookie = request.cookies.get("lp_csrf", "")
    supplied = form.get("csrf", "")
    if not cookie or not supplied or not hmac.compare_digest(cookie, supplied) or not hmac.compare_digest(digest(cookie), session.csrf_hash):
        raise HTTPException(403, "invalid request")
