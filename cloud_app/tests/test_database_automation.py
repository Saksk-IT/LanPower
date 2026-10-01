from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
from unittest.mock import Mock

from alembic import command
from alembic.config import Config
import pytest

from cloud_app.app.database import make_engine, migrate


def test_sqlite_connection_options_and_cross_thread_reads(tmp_path):
    engine = make_engine('sqlite:///' + (tmp_path / 'wal.db').as_posix())
    try:
        with engine.connect() as db:
            assert {key: db.exec_driver_sql('PRAGMA ' + key).scalar() for key in
                ('journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout')} == {
                    'journal_mode': 'wal', 'synchronous': 1, 'foreign_keys': 1, 'busy_timeout': 10000}
            db.exec_driver_sql('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
            db.exec_driver_sql('CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))')
            with pytest.raises(Exception, match='FOREIGN KEY'):
                db.exec_driver_sql('INSERT INTO child VALUES (999)')
            # The same DBAPI connection may be reused by another request thread.
            with ThreadPoolExecutor(max_workers=1) as pool:
                assert pool.submit(lambda: db.exec_driver_sql('SELECT 42').scalar()).result() == 42
    finally:
        engine.dispose()


def test_non_sqlite_does_not_install_pragmas_or_thread_options(monkeypatch):
    create, listen = Mock(), Mock()
    monkeypatch.setattr('cloud_app.app.database.create_engine', create)
    monkeypatch.setattr('cloud_app.app.database.event.listens_for', listen)
    assert make_engine('postgresql+psycopg://localhost/test') is create.return_value
    assert create.call_args.kwargs['connect_args'] == {}
    listen.assert_not_called()


def test_0009_upgrade_and_downgrade_preserve_existing_rows(tmp_path):
    path = tmp_path / 'migration.db'
    url = 'sqlite:///' + path.as_posix()
    config = Config(str(Path(__file__).resolve().parents[1] / 'alembic.ini'))
    config.set_main_option('sqlalchemy.url', url)
    command.upgrade(config, '0008_persistent_clients')
    with closing(sqlite3.connect(path)) as db:
        db.execute("INSERT INTO users (id,username,password_hash,created_at) VALUES ('owner','admin','hash',1)")
        db.execute("INSERT INTO devices (id,owner_id,device_type,name,version,protocol_version,created_at,metadata) "
                   "VALUES ('pc','owner','windows','Existing PC','1.6.1','2',1,'{}')")
        db.execute("INSERT INTO client_sessions (id,owner_id,name,access_hash,refresh_hash,access_expires_at,"
                   "created_at,last_seen_at) VALUES ('phone','owner','Existing phone','access','refresh',9999999999,1,2)")
        db.execute("INSERT INTO client_enrollments (code_hash,owner_id,name,expires_at) VALUES ('code','owner','Pending phone',9999999999)")
        db.commit()
        tables = ('users', 'devices', 'client_sessions', 'client_enrollments')
        originals = {table: db.execute('SELECT * FROM ' + table).fetchall() for table in tables}
    migrate(url)
    migrate(url)
    with closing(sqlite3.connect(path)) as db:
        for table in tables:
            rows = db.execute('SELECT * FROM ' + table).fetchall()
            assert [row[:len(originals[table][0])] for row in rows] == originals[table]
        assert db.execute('SELECT allowed_actions FROM client_sessions').fetchone() == ('',)
        assert db.execute('SELECT allowed_actions FROM client_enrollments').fetchone() == ('',)
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    command.downgrade(config, '0008_persistent_clients')
    with closing(sqlite3.connect(path)) as db:
        for table in tables:
            assert db.execute('SELECT * FROM ' + table).fetchall() == originals[table]
    migrate(url)
