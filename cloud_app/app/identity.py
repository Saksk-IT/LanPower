"""Passkey ceremonies and single-use recovery codes for the Cloud administrator."""

from __future__ import annotations

import base64
import hmac
import json
import os
from pathlib import Path
import secrets
import time
import uuid
from urllib.parse import urlsplit

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session, sessionmaker
from webauthn import (
    base64url_to_bytes, generate_authentication_options, generate_registration_options,
    options_to_json, verify_authentication_response, verify_registration_response,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
    ResidentKeyRequirement, UserVerificationRequirement,
)

from cloud_app.app.auth import digest
from cloud_app.app.models import AuditLog, AuthChallenge, Passkey, RecoveryCode, User, WebSession

CHALLENGE_SECONDS = 5 * 60
RECOVERY_COUNT = 10


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class BootstrapCode:
    """Local-only first-run proof; never printed to application logs."""

    def __init__(self, database_url: str, enabled: bool):
        if database_url.startswith("sqlite:///") and database_url != "sqlite:///:memory:":
            root = Path(database_url.removeprefix("sqlite:///")).resolve().parent
        else:
            root = Path("/var/lib/lanpower-cloud")
        self.path = root / "setup-code"
        self.enabled = enabled
        if enabled:
            root.mkdir(parents=True, exist_ok=True)
            try:
                handle = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(handle, "w", encoding="ascii") as file:
                    file.write(secrets.token_urlsafe(32))
                    file.flush()
                    os.fsync(file.fileno())
            if os.name != "nt" and self.path.stat().st_mode & 0o077:
                raise PermissionError("setup code file permissions are too open")

    def verify(self, candidate: str) -> bool:
        if not self.enabled or not 10 <= len(candidate) <= 128:
            return False
        try:
            expected = self.path.read_text(encoding="ascii")
        except FileNotFoundError:
            return False
        return hmac.compare_digest(candidate.encode("utf-8"), expected.encode("ascii"))

    def disable(self) -> None:
        self.enabled = False
        self.path.unlink(missing_ok=True)


class Identity:
    def __init__(self, sessions: sessionmaker[Session], public_url: str):
        self.sessions = sessions
        self.origin = public_url.rstrip("/")
        self.rp_id = urlsplit(public_url).hostname

    def initialized(self, owner_id: str) -> bool:
        with self.sessions() as db:
            owner = db.get(User, owner_id)
            return owner is not None and owner.identity_initialized_at is not None

    def has_passkey(self, owner_id: str) -> bool:
        with self.sessions() as db:
            return db.scalar(select(func.count()).select_from(Passkey).where(Passkey.owner_id == owner_id)) > 0

    def passkeys(self, owner_id: str) -> list[Passkey]:
        with self.sessions() as db:
            return list(db.scalars(select(Passkey).where(Passkey.owner_id == owner_id).order_by(Passkey.created_at)))

    def recovery_count(self, owner_id: str) -> tuple[int, int]:
        """Return total and unused recovery-code counts without exposing hashes."""
        with self.sessions() as db:
            total = db.scalar(select(func.count()).select_from(RecoveryCode).where(RecoveryCode.owner_id == owner_id)) or 0
            unused = db.scalar(select(func.count()).select_from(RecoveryCode).where(
                RecoveryCode.owner_id == owner_id, RecoveryCode.used_at.is_(None))) or 0
        return int(total), int(unused)

    def _challenge(self, owner_id: str, purpose: str, binding: str) -> tuple[str, bytes]:
        now = int(time.time())
        challenge_id = str(uuid.uuid4())
        challenge = secrets.token_bytes(32)
        with self.sessions.begin() as db:
            db.execute(delete(AuthChallenge).where(AuthChallenge.expires_at < now - 86400))
            db.add(AuthChallenge(id=challenge_id, owner_id=owner_id, challenge=encode(challenge),
                                 purpose=purpose, binding_hash=digest(binding),
                                 created_at=now, expires_at=now + CHALLENGE_SECONDS))
        return challenge_id, challenge

    def _consume(self, owner_id: str, challenge_id: str, purpose: str, binding: str) -> bytes:
        now = int(time.time())
        with self.sessions.begin() as db:
            row = db.get(AuthChallenge, challenge_id)
            if (row is None or row.owner_id != owner_id or row.purpose != purpose or
                    not hmac.compare_digest(row.binding_hash, digest(binding))):
                raise ValueError("验证已失效，请重试")
            changed = db.execute(update(AuthChallenge).where(
                AuthChallenge.id == challenge_id, AuthChallenge.used_at.is_(None),
                AuthChallenge.expires_at > now).values(used_at=now))
            if changed.rowcount != 1:
                raise ValueError("验证已失效，请重试")
            return base64url_to_bytes(row.challenge)

    def registration_options(self, owner_id: str, binding: str, *, setup: bool = False) -> dict:
        with self.sessions() as db:
            owner = db.get(User, owner_id)
            if owner is None or owner.revoked_at is not None:
                raise ValueError("管理员不可用")
            existing = list(db.scalars(select(Passkey).where(Passkey.owner_id == owner_id)))
        challenge_id, challenge = self._challenge(owner_id, "setup" if setup else "register", binding)
        options = generate_registration_options(
            rp_id=self.rp_id, rp_name="LanPower Cloud", user_id=uuid.UUID(owner_id).bytes,
            user_name=owner.username, user_display_name=owner.username,
            challenge=challenge, timeout=60000,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.REQUIRED),
            exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(key.credential_id))
                                 for key in existing],
        )
        return {"challenge_id": challenge_id, "options": json.loads(options_to_json(options))}

    def finish_registration(self, owner_id: str, challenge_id: str, credential: dict,
                            binding: str, *, setup: bool = False) -> list[str]:
        challenge = self._consume(owner_id, challenge_id, "setup" if setup else "register", binding)
        verified = verify_registration_response(
            credential=credential, expected_challenge=challenge,
            expected_rp_id=self.rp_id, expected_origin=self.origin,
            require_user_verification=True,
        )
        now = int(time.time())
        codes: list[str] = []
        with self.sessions.begin() as db:
            # The conditional update elects exactly one first registration, including
            # requests handled by different workers. Losing setup requests roll back.
            first = db.execute(update(User).where(
                User.id == owner_id, User.revoked_at.is_(None), User.identity_initialized_at.is_(None)
            ).values(identity_initialized_at=now)).rowcount == 1
            owner = db.get(User, owner_id)
            if owner is None or owner.revoked_at is not None or (setup and not first):
                raise ValueError("初始化已完成或管理员不可用")
            if db.get(Passkey, encode(verified.credential_id)) is not None:
                raise ValueError("Passkey 已存在")
            db.add(Passkey(credential_id=encode(verified.credential_id), owner_id=owner_id,
                           public_key=encode(verified.credential_public_key),
                           sign_count=verified.sign_count, name="Passkey", created_at=now,
                           backed_up=verified.credential_backed_up))
            if first:
                for _ in range(RECOVERY_COUNT):
                    raw = base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")
                    codes.append("-".join(raw[index:index + 4] for index in range(0, len(raw), 4)))
                    db.add(RecoveryCode(code_hash=digest(raw), owner_id=owner_id, created_at=now))
                db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id,
                                event="recovery_created", created_at=now))
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id,
                            event="passkey_registered", created_at=now))
            if setup:
                db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id,
                                event="setup_completed", created_at=now))
        return codes

    def authentication_options(self, owner_id: str, binding: str) -> dict:
        with self.sessions() as db:
            owner = db.get(User, owner_id)
            if owner is None or owner.revoked_at is not None:
                raise ValueError("管理员不可用")
        keys = self.passkeys(owner_id)
        if not keys:
            raise ValueError("尚未设置 Passkey")
        challenge_id, challenge = self._challenge(owner_id, "login", binding)
        options = generate_authentication_options(
            rp_id=self.rp_id, challenge=challenge, timeout=60000,
            allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(key.credential_id))
                               for key in keys],
            user_verification=UserVerificationRequirement.REQUIRED,
        )
        return {"challenge_id": challenge_id, "options": json.loads(options_to_json(options))}

    def finish_authentication(self, owner_id: str, challenge_id: str, credential: dict, binding: str) -> str:
        challenge = self._consume(owner_id, challenge_id, "login", binding)
        credential_id = credential.get("id")
        if not isinstance(credential_id, str) or len(credential_id) > 2048:
            raise ValueError("Passkey 无效")
        with self.sessions() as db:
            key = db.get(Passkey, credential_id)
            if key is None or key.owner_id != owner_id:
                raise ValueError("Passkey 无效")
            public_key, sign_count = base64url_to_bytes(key.public_key), key.sign_count
        verified = verify_authentication_response(
            credential=credential, expected_challenge=challenge,
            expected_rp_id=self.rp_id, expected_origin=self.origin,
            credential_public_key=public_key, credential_current_sign_count=sign_count,
            require_user_verification=True,
        )
        now = int(time.time())
        with self.sessions.begin() as db:
            owner = db.get(User, owner_id)
            if owner is None or owner.revoked_at is not None:
                raise ValueError("管理员不可用")
            changed = db.execute(update(Passkey).where(
                Passkey.credential_id == credential_id, Passkey.owner_id == owner_id,
                Passkey.sign_count == sign_count).values(
                    sign_count=verified.new_sign_count, last_used_at=now,
                    backed_up=verified.credential_backed_up))
            if changed.rowcount != 1:
                raise ValueError("Passkey 状态已变化")
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id,
                            event="passkey_login", created_at=now))
        return owner_id

    def use_recovery_code(self, owner_id: str, code: str) -> bool:
        normalized = code.replace("-", "").replace(" ", "").upper()
        if len(normalized) != 32 or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" for char in normalized):
            return False
        now = int(time.time())
        with self.sessions.begin() as db:
            owner = db.get(User, owner_id)
            if owner is None or owner.revoked_at is not None:
                return False
            changed = db.execute(update(RecoveryCode).where(
                RecoveryCode.code_hash == digest(normalized), RecoveryCode.owner_id == owner_id,
                RecoveryCode.used_at.is_(None)).values(used_at=now))
            if changed.rowcount != 1:
                return False
            db.execute(delete(WebSession).where(WebSession.owner_id == owner_id))
            db.add(AuditLog(id=str(uuid.uuid4()), owner_id=owner_id,
                            event="recovery_used", created_at=now))
        return True
