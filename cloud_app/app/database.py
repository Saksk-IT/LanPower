from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker


def make_engine(database_url: str) -> Engine:
    url = make_url(database_url)
    sqlite = url.get_backend_name() == "sqlite"
    if sqlite and url.database and url.database != ":memory:":
        Path(url.database).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, connect_args={"check_same_thread": False} if sqlite else {}, pool_pre_ping=True)
    if sqlite:
        @event.listens_for(engine, "connect")
        def set_sqlite_options(connection, _record):
            cursor = connection.cursor()
            try:
                cursor.execute("PRAGMA busy_timeout=10000")
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA synchronous=NORMAL")
                cursor.execute("PRAGMA foreign_keys=ON")
            finally:
                cursor.close()
    return engine


def migrate(database_url: str) -> None:
    config = AlembicConfig(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(config, "head")


def session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)
