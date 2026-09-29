from concurrent.futures import ThreadPoolExecutor
import time

import pytest
from sqlalchemy import select

from cloud_app.app.auth import digest
from cloud_app.app.models import AuditLog, ClientEnrollment, ClientSession, Device, User
from cloud_app.app.platform import ADMIN_ID
from cloud_app.tests.test_platform import login, make_client


@pytest.fixture
def cloud(tmp_path):
    client, app = make_client(tmp_path, no_gateway=True)
    yield client, app
    client.close()
    app.state.engine.dispose()


def mobile(client, app, owner=ADMIN_ID):
    code = app.state.platform.mobile.create_enrollment(owner, "Test phone")
    response = client.post('/api/v2/clients/enroll', json={'code': code})
    assert response.status_code == 200, response.text
    return response.json(), code


def test_single_use_qr_and_independent_client_control(cloud):
    client, app = cloud
    csrf = login(client)
    assert client.post('/clients/enroll', data={'name': 'Phone'}).status_code == 403
    page = client.post('/clients/enroll', data={'name': 'Phone', 'csrf': csrf})
    assert page.status_code == 200 and '<svg' in page.text
    assert page.headers['cache-control'] == 'no-store'
    credentials, code = mobile(client, app)
    assert client.post('/api/v2/clients/enroll', json={'code': code}).status_code == 400
    headers = {'Authorization': 'Bearer ' + credentials['access_token']}
    device = app.state.platform.windows.enroll({'code': app.state.platform.windows.create_enrollment(ADMIN_ID),
        'name': 'PC', 'version': '1.4.0', 'protocol_version': '2'})
    app.state.platform.windows.heartbeat(device['device_id'], {'device_id': device['device_id'], 'state': 'online',
        'version': '1.4.0', 'uptime': 1, 'lan_ip': '192.168.1.8', 'wol_capable': False})
    # Mobile control uses its own identity, without browser cookies or a router.
    client.cookies.clear()
    assert client.get('/api/v2/devices').status_code == 401
    listing = client.get('/api/v2/devices', headers=headers).json()
    assert listing[0]['device_id'] == device['device_id']
    assert listing[0]['wake_available'] is False
    issued = client.post(f'/api/v2/devices/{device["device_id"]}/commands', headers=headers, json={'action': 'status'}).json()
    assert issued['route'] == 'windows_direct'
    delivered = app.state.platform.windows.poll(device['device_id'], timeout=0)
    app.state.platform.windows.result(device['device_id'], {'command_id': delivered['command_id'], 'ok': True, 'state': 'online', 'error': ''})
    assert client.get(f'/api/v2/commands/{issued["command_id"]}', headers=headers).json()['state'] == 'completed'
    assert client.get('/api/v2/windows/commands', headers=headers).status_code == 401
    assert client.get('/api/v2/devices', headers={'Authorization': 'Bearer ' + device['access_token']}).status_code == 401
    with app.state.platform.sessions() as db:
        row = db.get(ClientSession, credentials['client_id'])
        assert row.access_hash == digest(credentials['access_token'])
        assert row.refresh_hash == digest(credentials['refresh_token'])
        assert db.get(ClientEnrollment, digest(code)).used_at is not None
    csrf = login(client)
    assert 'Test phone' in client.get('/clients').text
    assert client.post(f'/clients/{credentials["client_id"]}/revoke', data={'csrf': csrf}, follow_redirects=False).status_code == 303
    # A supplied invalid bearer must not silently fall back to the browser cookie.
    assert client.get('/api/v2/devices', headers=headers).status_code == 401


def test_expiry_replacement_and_owner_isolation(cloud):
    client, app = cloud
    service = app.state.platform.mobile
    old = service.create_enrollment(ADMIN_ID, 'Old')
    newer = service.create_enrollment(ADMIN_ID, 'New')
    assert client.post('/api/v2/clients/enroll', json={'code': old}).status_code == 400
    with app.state.platform.sessions.begin() as db:
        db.get(ClientEnrollment, digest(newer)).expires_at = 0
        db.add(User(id='other', username='other', password_hash='unused', created_at=1))
        db.flush()
        db.add(Device(id='other-pc', owner_id='other', device_type='windows', name='Other', created_at=1, meta={}))
    assert client.post('/api/v2/clients/enroll', json={'code': newer}).status_code == 400
    credentials, _ = mobile(client, app)
    other, _ = mobile(client, app, 'other')
    headers = {'Authorization': 'Bearer ' + credentials['access_token']}
    assert client.get('/api/v2/devices/other-pc', headers=headers).status_code == 404
    assert client.get('/api/v2/devices', headers=headers).json() == []
    assert client.post('/api/v2/devices/other-pc/commands', headers=headers, json={'action': 'shutdown'}).status_code != 200
    with pytest.raises(ValueError):
        service.revoke(ADMIN_ID, other['client_id'])
    with app.state.platform.sessions.begin() as db:
        db.get(User, ADMIN_ID).revoked_at = int(time.time())
    assert client.get('/api/v2/devices', headers=headers).status_code == 401
    assert client.post('/api/v2/clients/token', json={'client_id': credentials['client_id'], 'refresh_token': credentials['refresh_token']}).status_code == 401


def test_atomic_exchange_refresh_reuse_and_client_isolation(cloud):
    client, app = cloud
    service = app.state.platform.mobile
    code = service.create_enrollment(ADMIN_ID, 'Concurrent')
    def exchange(_):
        try: return service.enroll({'code': code})
        except ValueError: return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(exchange, range(2)))
    assert sum(result is not None for result in responses) == 1
    credentials = next(result for result in responses if result)
    other, _ = mobile(client, app)
    refresh = {'client_id': credentials['client_id'], 'refresh_token': credentials['refresh_token']}
    def rotate(_):
        try: return service.refresh(refresh)
        except PermissionError: return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(rotate, range(2)))
    assert sum(result is not None for result in responses) == 1
    rotated = next(result for result in responses if result)
    with pytest.raises(PermissionError): service.authorize(rotated['access_token'])
    assert service.authorize(other['access_token'])[1] == other['client_id']
    with app.state.platform.sessions() as db:
        assert 'client_refresh_reuse' in set(db.scalars(select(AuditLog.event)))


def test_rotation_expiration_and_self_revoke(cloud):
    client, app = cloud
    credentials, _ = mobile(client, app)
    with app.state.platform.sessions.begin() as db:
        db.get(ClientSession, credentials['client_id']).access_expires_at = 0
    assert client.get('/api/v2/devices', headers={'Authorization': 'Bearer ' + credentials['access_token']}).status_code == 401
    response = client.post('/api/v2/clients/token', json={'client_id': credentials['client_id'], 'refresh_token': credentials['refresh_token']})
    assert response.status_code == 200
    rotated = response.json()
    headers = {'Authorization': 'Bearer ' + rotated['access_token']}
    assert client.get('/api/v2/devices', headers=headers).status_code == 200
    assert client.post('/api/v2/clients/revoke', headers=headers).status_code == 200
    assert client.get('/api/v2/devices', headers=headers).status_code == 401
