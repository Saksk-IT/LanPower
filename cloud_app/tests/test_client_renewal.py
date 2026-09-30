from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import time
import uuid

from alembic import command
from alembic.config import Config
from sqlalchemy import select

from cloud_app.app.auth import digest
from cloud_app.app.clients import Clients
from cloud_app.app.database import make_engine, migrate, session_factory
from cloud_app.app.models import AuditLog, ClientSession, UsedClientRefreshToken
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_clients import cloud, mobile


def test_lost_response_can_be_retried_after_restart_and_long_absence(cloud, monkeypatch):
    client, app = cloud
    credentials, _ = mobile(client, app)
    payload = {key: credentials[key] for key in ('client_id', 'refresh_token')}
    # The server commits, but the phone never receives the response.
    lost = client.post('/api/v2/clients/renew', json=payload)
    assert lost.status_code == 200
    assert lost.headers['cache-control'] == 'no-store'
    now = int(time.time())
    monkeypatch.setattr(time, 'time', lambda: now + 365 * 86400)
    # The retry uses only persisted credentials, with no process-local cache.
    restarted = Clients(app.state.platform.sessions)
    recovered = restarted.renew(payload)
    assert recovered['refresh_token'] == credentials['refresh_token']
    assert recovered['access_token'] != lost.json()['access_token']
    assert recovered['access_expires_at'] == int(time.time()) + 900
    assert client.get('/api/v2/devices', headers={
        'Authorization': 'Bearer ' + recovered['access_token']}).status_code == 200
    with app.state.platform.sessions() as db:
        row = db.get(ClientSession, credentials['client_id'])
        assert row.refresh_expires_at is None and row.revoked_at is None
        assert row.refresh_hash == digest(credentials['refresh_token'])
        assert db.scalar(select(UsedClientRefreshToken)) is None
        assert 'client_refresh_reuse' not in set(db.scalars(select(AuditLog.event)))


def test_concurrent_renewals_keep_the_authorization_valid(cloud):
    client, app = cloud
    credentials, _ = mobile(client, app)
    payload = {key: credentials[key] for key in ('client_id', 'refresh_token')}
    service = app.state.platform.mobile
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: service.renew(payload), range(2)))
    assert all(result['refresh_token'] == credentials['refresh_token'] for result in results)
    # The latest access token wins; either caller can renew the same grant again.
    current = service.renew(payload)
    assert service.authorize(current['access_token'])[1] == credentials['client_id']
    with app.state.platform.sessions() as db:
        assert db.get(ClientSession, credentials['client_id']).revoked_at is None


def test_renewal_preserves_owner_isolation_and_explicit_revocation(cloud):
    client, app = cloud
    credentials, _ = mobile(client, app)
    other, _ = mobile(client, app)
    payload = {key: credentials[key] for key in ('client_id', 'refresh_token')}
    assert client.post('/api/v2/clients/renew', json={
        **payload, 'refresh_token': other['refresh_token']}).status_code == 401
    current = client.post('/api/v2/clients/renew', json=payload).json()
    headers = {'Authorization': 'Bearer ' + current['access_token']}
    assert client.post('/api/v2/clients/revoke', headers=headers).status_code == 200
    assert client.post('/api/v2/clients/renew', json=payload).status_code == 401
    assert client.get('/api/v2/devices', headers=headers).status_code == 401
    assert app.state.platform.mobile.authorize(other['access_token'])[1] == other['client_id']


def test_legacy_consumed_token_is_not_restored_or_reused_to_revoke(cloud):
    client, app = cloud
    credentials, _ = mobile(client, app)
    original = {key: credentials[key] for key in ('client_id', 'refresh_token')}
    rotated = client.post('/api/v2/clients/token', json=original).json()
    assert client.post('/api/v2/clients/renew', json=original).status_code == 401
    # A stale phone cannot revoke another holder of the current authorization.
    assert client.post('/api/v2/clients/renew', json={
        key: rotated[key] for key in ('client_id', 'refresh_token')}).status_code == 200


def test_invalid_renewal_never_consumes_authorization(cloud):
    client, app = cloud
    credentials, _ = mobile(client, app)
    payload = {key: credentials[key] for key in ('client_id', 'refresh_token')}
    for invalid in ({}, {**payload, 'refresh_token': []}, {**payload, 'refresh_token': ''},
                    {**payload, 'client_id': 'x' * 65}, {**payload, 'owner_id': ADMIN_ID}):
        assert client.post('/api/v2/clients/renew', json=invalid).status_code == 400
    assert client.post('/api/v2/clients/renew', json=payload).status_code == 200


def test_upgrade_preserves_credentials_history_and_revocations(tmp_path):
    database = tmp_path / 'platform.db'
    url = 'sqlite:///' + database.as_posix()
    config = Config(str(Path(__file__).resolve().parents[1] / 'alembic.ini'))
    config.set_main_option('sqlalchemy.url', url)
    command.upgrade(config, '0007_client_versions')
    now = int(time.time())
    active, revoked = str(uuid.uuid4()), str(uuid.uuid4())
    with sqlite3.connect(database) as db:
        db.execute('INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)',
                   (ADMIN_ID, 'admin', 'unused', now))
        for client_id, access, refresh, revoked_at in (
                (active, 'a' * 43, 'r' * 43, None), (revoked, 'b' * 43, 's' * 43, now)):
            db.execute('INSERT INTO client_sessions (id,owner_id,name,access_hash,refresh_hash,'
                       'access_expires_at,refresh_expires_at,created_at,last_seen_at,revoked_at) '
                       'VALUES (?,?,?,?,?,?,?,?,?,?)',
                       (client_id, ADMIN_ID, 'Existing phone', digest(access), digest(refresh),
                        now - 86400, now - 86400, now - 60 * 86400, now - 31 * 86400, revoked_at))
        db.execute('INSERT INTO used_client_refresh_tokens (token_hash,session_id,used_at) VALUES (?,?,?)',
                   (digest('old' * 16), active, now - 86400))
    migrate(url)
    migrate(url)  # Startup migrations must not reset a later explicit revocation.
    engine = make_engine(url)
    sessions = session_factory(engine)
    try:
        with sessions() as db:
            row = db.get(ClientSession, active)
            assert row.refresh_expires_at is None and row.revoked_at is None
            assert row.access_hash == digest('a' * 43) and row.refresh_hash == digest('r' * 43)
            assert db.get(ClientSession, revoked).revoked_at == now
            assert db.get(UsedClientRefreshToken, digest('old' * 16)).session_id == active
        current = Clients(sessions).renew({'client_id': active, 'refresh_token': 'r' * 43})
        assert current['refresh_token'] == 'r' * 43
        with sqlite3.connect(database) as db:
            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    finally:
        engine.dispose()
