from pathlib import Path
import sqlite3
import time
import uuid

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import pytest

from cloud_app.app.auth import digest
from cloud_app.app.main import create_app
from cloud_app.app.models import ClientEnrollment, ClientSession
from cloud_app.app.platform import ADMIN_ID
from cloud_app.app.settings import Settings
from cloud_app.tests.test_platform import login, make_client


@pytest.fixture
def cloud(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    yield client, app
    client.close()
    app.state.engine.dispose()


def test_client_version_is_displayed_and_code_only_clients_remain_compatible(cloud):
    client, app = cloud
    code = app.state.platform.mobile.create_enrollment(ADMIN_ID, "New phone")
    response = client.post('/api/v2/clients/enroll', json={'code': code, 'version': '2.0.0', 'protocol_version': '2'})
    assert response.status_code == 200
    credentials = response.json()
    with app.state.platform.sessions() as db:
        row = db.get(ClientSession, credentials['client_id'])
        assert row.version == '2.0.0' and row.protocol_version == '2'
    legacy = app.state.platform.mobile.create_enrollment(ADMIN_ID, "Earlier v2 phone")
    assert client.post('/api/v2/clients/enroll', json={'code': legacy}).status_code == 200
    login(client)
    page = client.get('/clients').text
    assert '授权时版本：2.0.0' in page and '尚未上报' in page
    assert credentials['access_token'] not in page and credentials['refresh_token'] not in page
    assert client.get('/healthz').json()['protocol_version'] == '2'


@pytest.mark.parametrize('invalid', [
    {'version': ''}, {'version': '<script>'}, {'version': []}, {'version': '1.0.0+' + 'x' * 64},
    {'protocol_version': '3'}, {'protocol_version': 2}, {'lan_token': 'a' * 64},
])
def test_invalid_metadata_never_consumes_the_enrollment_code(cloud, invalid):
    client, app = cloud
    code = app.state.platform.mobile.create_enrollment(ADMIN_ID, 'Phone')
    payload = {'code': code, 'version': '2.0.0', 'protocol_version': '2', **invalid}
    assert client.post('/api/v2/clients/enroll', json=payload).status_code == 400
    with app.state.platform.sessions() as db:
        assert db.get(ClientEnrollment, digest(code)).used_at is None
    assert client.post('/api/v2/clients/enroll', json={'code': code}).status_code == 200


def test_schema_upgrade_preserves_existing_client_credentials(tmp_path):
    database = tmp_path / 'platform.db'
    url = 'sqlite:///' + database.as_posix()
    config = Config(str(Path(__file__).resolve().parents[1] / 'alembic.ini'))
    config.set_main_option('sqlalchemy.url', url)
    command.upgrade(config, '0006_gateway_commands')
    client_id, now = str(uuid.uuid4()), int(time.time())
    access, refresh = 'a' * 43, 'r' * 43
    with sqlite3.connect(database) as db:
        db.execute('INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)',
                   (ADMIN_ID, 'admin', 'unused', now))
        db.execute('INSERT INTO client_sessions (id,owner_id,name,access_hash,refresh_hash,access_expires_at,'
                   'refresh_expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)',
                   (client_id, ADMIN_ID, 'Existing phone', digest(access), digest(refresh), now + 900,
                    now + 86400, now, now))
    app = create_app(Settings(None, url, None, 'https://power.example.com'))
    try:
        with TestClient(app, base_url='https://power.example.com') as client:
            assert client.get('/api/v2/devices', headers={'Authorization': 'Bearer ' + access}).status_code == 200
        with app.state.platform.sessions() as db:
            row = db.get(ClientSession, client_id)
            assert row.version == '' and row.protocol_version == '2'
            assert row.access_hash == digest(access) and row.refresh_hash == digest(refresh)
    finally:
        app.state.engine.dispose()
