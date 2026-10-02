import time

import pytest

from cloud_app.app.models import Device
from cloud_app.tests.test_automation import setup
from cloud_app.tests.test_clients import cloud


@pytest.mark.parametrize('address,host', [
    ('192.168.1.8', '192.168.1.8'), ('2001:db8::8', '[2001:db8::8]')])
def test_remote_desktop_download_uses_latest_address_without_credentials(setup, address, host):
    client, app, _, issue = setup
    with app.state.platform.sessions.begin() as db:
        device = db.get(Device, 'pc-a')
        device.meta = {**device.meta, 'lan_ip': address}
    response = client.get('/api/v2/devices/pc-a/remote-desktop')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/x-rdp'
    assert response.headers['content-disposition'] == 'attachment; filename="LanPower.rdp"'
    assert response.headers['cache-control'] == 'no-store'
    content = response.content.decode('utf-16')
    assert f'full address:s:{host}:3389\r\n' in content
    assert 'prompt for credentials:i:1\r\n' in content
    assert 'authentication level:i:2\r\n' in content
    assert 'password' not in content and 'token' not in content and 'username' not in content
    issue.assert_not_called()


@pytest.mark.parametrize('address', [None, '', 1234, 'invalid',
    '192.168.1.8\r\nremoteapplicationprogram:s:cmd', 'fe80::1%eth0\nsetting:i:1'])
def test_remote_desktop_rejects_missing_or_unsafe_addresses(setup, address):
    client, app, _, issue = setup
    with app.state.platform.sessions.begin() as db:
        device = db.get(Device, 'pc-a')
        device.meta = {**device.meta, 'lan_ip': address}
    response = client.get('/api/v2/devices/pc-a/remote-desktop')
    assert response.status_code == 409 and '局域网 IP' in response.json()['error']
    assert 'content-disposition' not in response.headers
    issue.assert_not_called()


@pytest.mark.parametrize('state', ['offline', 'transitioning'])
def test_remote_desktop_rechecks_device_availability(setup, state):
    client, app, _, issue = setup
    with app.state.platform.sessions.begin() as db:
        device = db.get(Device, 'pc-a')
        device.last_seen_at = 1
        device.meta = {**device.meta, 'presence_state': state,
                       'transition_until': int(time.time()) + 120 if state == 'transitioning' else 0}
    assert client.get('/api/v2/devices/pc-a/remote-desktop').status_code == 409
    issue.assert_not_called()


def test_remote_desktop_requires_login_and_owned_active_windows_device(setup):
    client, app, _, issue = setup
    for device_id in ('foreign', 'missing'):
        assert client.get(f'/api/v2/devices/{device_id}/remote-desktop').status_code == 404
    with app.state.platform.sessions.begin() as db:
        db.get(Device, 'pc-a').revoked_at = int(time.time())
        db.get(Device, 'pc-b').device_type = 'gateway'
    for device_id in ('pc-a', 'pc-b'):
        assert client.get(f'/api/v2/devices/{device_id}/remote-desktop').status_code == 404
    client.cookies.clear()
    assert client.get('/api/v2/devices/pc-a/remote-desktop').status_code == 401
    issue.assert_not_called()
