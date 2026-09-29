"""Generate the initial Cloud administrator password hash with Python's standard library."""

from __future__ import annotations

import getpass
import hashlib
import hmac
import secrets


def hash_password(password: str, salt: bytes | None = None) -> str:
    if len(password) < 12:
        raise ValueError("管理员密码至少需要 12 个字符")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = encoded.split("$")
        if scheme != "scrypt" or len(salt_hex) != 32 or len(digest_hex) != 64:
            return False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual, bytes.fromhex(digest_hex))
    except (ValueError, OverflowError):
        return False


def main() -> None:
    password = getpass.getpass("设置管理员密码（至少 12 个字符）: ")
    repeat = getpass.getpass("再次输入: ")
    if password != repeat:
        raise SystemExit("两次密码不一致")
    print(hash_password(password))


if __name__ == "__main__":
    main()
