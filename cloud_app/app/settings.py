from __future__ import annotations

from dataclasses import dataclass, field
import ipaddress
import os
from pathlib import Path
from urllib.parse import urlsplit

from cloud_remote.server import Config


def local_http_host(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or (address.version == 4 and any(address in network for network in (
        ipaddress.ip_network("10.0.0.0/8"), ipaddress.ip_network("172.16.0.0/12"),
        ipaddress.ip_network("192.168.0.0/16"))))


@dataclass(frozen=True)
class Settings:
    legacy: Config | None = field(repr=False)
    database_url: str
    admin_password_hash: str | None = field(repr=False)
    public_url: str
    wx_app_id: str = field(default="", repr=False)
    wx_app_secret: str = field(default="", repr=False)
    additional_origins: tuple[str, ...] = ()
    allow_registration: bool = False
    allow_local_http: bool = False

    @property
    def browser_origins(self) -> frozenset[str]:
        return frozenset(value.rstrip("/") for value in (self.public_url, *self.additional_origins))

    def browser_url(self, origin: str) -> str:
        if origin in self.browser_origins:
            return origin
        # HTTPS proxies forward HTTP internally; only use HTTP for an explicit dev origin.
        local_origin = origin.replace("https://", "http://", 1)
        if self.allow_local_http and local_origin in self.browser_origins:
            return local_origin
        return self.public_url

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
                           os.environ.get("LANPOWER_ADDITIONAL_ORIGINS", "").split(",") if value.strip()),
                       allow_registration=os.environ.get("LANPOWER_ALLOW_REGISTRATION", "false").lower() == "true",
                       allow_local_http=os.environ.get("LANPOWER_ALLOW_LOCAL_HTTP", "false").lower() == "true")
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
            local_http = (self.allow_local_http and origin.scheme == "http" and
                          origin.hostname is not None and local_http_host(origin.hostname))
            if ((origin.scheme != "https" and not local_http) or not origin.hostname or origin.username or origin.password or
                    origin.path not in ("", "/") or origin.query or origin.fragment or
                    "*" in origin.netloc or any(char.isspace() for char in value)):
                raise ValueError("origins require HTTPS; explicit local development may use loopback/private IPv4 HTTP")
            # Reject malformed ports before accepting an origin into the allowlist.
            origin.port
