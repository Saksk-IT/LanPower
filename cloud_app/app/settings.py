from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
from urllib.parse import urlsplit

from cloud_remote.server import Config


@dataclass(frozen=True)
class Settings:
    legacy: Config | None = field(repr=False)
    database_url: str
    admin_password_hash: str | None = field(repr=False)
    public_url: str
    wx_app_id: str = field(default="", repr=False)
    wx_app_secret: str = field(default="", repr=False)
    additional_origins: tuple[str, ...] = ()

    @property
    def browser_origins(self) -> frozenset[str]:
        return frozenset(value.rstrip("/") for value in (self.public_url, *self.additional_origins))

    def browser_url(self, origin: str) -> str:
        return origin if origin in self.browser_origins else self.public_url

    @classmethod
    def from_environment(cls) -> "Settings":
        config_path = os.environ.get("LANPOWER_LEGACY_CONFIG", "")
        legacy = Config.load(Path(config_path)) if config_path else None
        database_url = os.environ.get("LANPOWER_DATABASE_URL", "sqlite:////var/lib/lanpower-cloud/platform.db")
        admin_password_hash = os.environ.get("LANPOWER_ADMIN_PASSWORD_HASH") or None
        public_url = os.environ["LANPOWER_PUBLIC_URL"].rstrip("/")
        settings = cls(legacy, database_url, admin_password_hash, public_url,
                       wx_app_id=os.environ.get("WX_APP_ID", ""),
                       wx_app_secret=os.environ.get("WX_APP_SECRET", ""),
                       additional_origins=tuple(value.strip().rstrip("/") for value in
                           os.environ.get("LANPOWER_ADDITIONAL_ORIGINS", "").split(",") if value.strip()))
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.legacy is not None:
            self.legacy.validate()
        if not (self.database_url.startswith("sqlite:///") or self.database_url.startswith("postgresql+psycopg://")):
            raise ValueError("unsupported database URL")
        if (self.admin_password_hash is not None and
                (not self.admin_password_hash.startswith("scrypt$") or len(self.admin_password_hash.split("$")) != 3)):
            raise ValueError("invalid admin password hash")
        for value in (self.public_url, *self.additional_origins):
            origin = urlsplit(value)
            if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password or
                    origin.path not in ("", "/") or origin.query or origin.fragment or
                    "*" in origin.netloc or any(char.isspace() for char in value)):
                raise ValueError("public URL and additional origins must be explicit HTTPS origins")
            # Reject malformed ports before accepting an origin into the allowlist.
            origin.port
