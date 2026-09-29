"""Cloud maintenance commands."""

from __future__ import annotations

import argparse
from contextlib import closing
from pathlib import Path
import sqlite3

from cloud_app.app.database import make_engine, migrate, session_factory
from cloud_app.app.platform import seed_legacy
from cloud_app.app.settings import Settings


def migrate_v1(settings: Settings) -> tuple[str, str]:
    if settings.legacy is None:
        raise ValueError("legacy gateway not configured")
    source = settings.legacy.database.resolve()
    if not source.is_file():
        raise ValueError("legacy relay.db does not exist")
    if settings.database_url.startswith("sqlite:///"):
        target = Path(settings.database_url.removeprefix("sqlite:///")).resolve()
        if target == source:
            raise ValueError("platform database must differ from legacy relay.db")
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"commands", "heartbeat"}.issubset(tables):
        raise ValueError("legacy relay.db schema is incomplete")
    migrate(settings.database_url)
    engine = make_engine(settings.database_url)
    try:
        return seed_legacy(settings, session_factory(engine))
    finally:
        engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="LanPower Cloud maintenance")
    parser.add_argument("command", choices=["migrate-v1"])
    args = parser.parse_args()
    settings = Settings.from_environment()
    if args.command == "migrate-v1":
        gateway_id, windows_id = migrate_v1(settings)
        print(f"Legacy Gateway: {gateway_id}")
        print(f"Legacy Windows: {windows_id}")


if __name__ == "__main__":
    main()
