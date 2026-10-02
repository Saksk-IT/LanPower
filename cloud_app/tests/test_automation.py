"""Automation tests use isolated databases and never dispatch real power or messages."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime
import threading
import time
from unittest.mock import Mock

import pytest
from sqlalchemy import select

from cloud_app.app.auth import digest
from cloud_app.app.events import device_events
from cloud_app.app.models import AuditLog, ClientEnrollment, ClientSession, Device, NotificationConfig, ScheduledTask, User
from cloud_app.app.notify import Notifier
from cloud_app.app.platform import ADMIN_ID
from cloud_app.app.scheduled import SCHEDULE_ZONE, Scheduler, next_run
from cloud_app.tests.test_clients import cloud
from cloud_app.tests.test_platform import login


@pytest.fixture
def setup(cloud, monkeypatch):
    client, app = cloud
    csrf = login(client)
    platform = app.state.platform
    with platform.sessions.begin() as db:
        db.add(User(id='other', username='other', password_hash='unused', created_at=1))
        db.flush()
        for device_id, owner in [('pc-a', ADMIN_ID), ('pc-b', ADMIN_ID), ('foreign', 'other')]:
            db.add(Device(id=device_id, owner_id=owner, device_type='windows', name='电脑 ' + device_id,
                version='1.7.0', protocol_version='2', created_at=1, last_seen_at=int(time.time()),
                meta={'lan_ip': '192.168.1.8', 'presence_state': 'online'}))
    issue = Mock(return_value={'accepted': True, 'route': 'windows_direct'})
    monkeypatch.setattr(platform, 'issue_command', issue)
    return client, app, csrf, issue


def schedule_form(csrf, **values):
    return {'csrf': csrf, 'device_id': 'pc-a', 'action': 'sleep', 'hour': '22',
            'minute': '0', 'weekday': '-1', 'label': '晚间睡眠', **values}


def test_schedule_management_and_csrf(setup):
    client, app, csrf, issue = setup
    assert client.post('/schedules', data=schedule_form('wrong')).status_code == 403
    response = client.post('/schedules', data=schedule_form(csrf))
    assert response.status_code == 200 and '每天 22:00' in response.text and '电脑 pc-a' in response.text
    with app.state.platform.sessions() as db:
        task = db.scalar(select(ScheduledTask))
        assert task.owner_id == ADMIN_ID and task.next_run_at > int(time.time())
    for expected in (False, True):
        assert client.post(f'/schedules/{task.id}/toggle', data={'csrf': csrf}).status_code == 200
        with app.state.platform.sessions() as db:
            assert db.get(ScheduledTask, task.id).enabled == expected
    assert client.post(f'/schedules/{task.id}/delete', data={'csrf': csrf}).status_code == 200
    with app.state.platform.sessions() as db:
        assert db.get(ScheduledTask, task.id) is None
        assert {'schedule_created', 'schedule_toggled', 'schedule_deleted'} <= set(db.scalars(select(AuditLog.event)))
    issue.assert_not_called()


@pytest.mark.parametrize('values,status', [({'device_id': 'foreign'}, 404), ({'hour': '24'}, 400),
    ({'minute': '-1'}, 400), ({'weekday': '7'}, 400), ({'hour': 'abc'}, 400),
    ({'action': 'format'}, 400), ({'label': 'x' * 101}, 400)])
def test_schedule_rejects_invalid_targets_and_rules(setup, values, status):
    client, app, csrf, issue = setup
    assert client.post('/schedules', data=schedule_form(csrf, **values)).status_code == status
    with app.state.platform.sessions() as db:
        assert db.scalar(select(ScheduledTask)) is None
    issue.assert_not_called()


def timestamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=SCHEDULE_ZONE).timestamp())


@pytest.mark.parametrize('now,hour,minute,weekday,expected', [
    ('2026-10-01T21:59:59', 22, 0, -1, '2026-10-01T22:00:00'),
    ('2026-10-01T22:00:00', 22, 0, -1, '2026-10-02T22:00:00'),
    ('2026-10-03T23:59:59', 0, 0, 0, '2026-10-04T00:00:00'),
    ('2026-10-04T00:00:00', 0, 0, 0, '2026-10-11T00:00:00'),
    ('2026-12-31T23:59:59', 0, 0, -1, '2027-01-01T00:00:00')])
def test_next_run_beijing_boundaries(now, hour, minute, weekday, expected):
    assert next_run(hour, minute, weekday, timestamp(now)) == timestamp(expected)


def add_task(platform, task_id, now, **values):
    with platform.sessions.begin() as db:
        db.add(ScheduledTask(**{'id': task_id, 'owner_id': ADMIN_ID, 'device_id': 'pc-a',
            'action': 'sleep', 'hour': 22, 'minute': 0, 'weekday': -1, 'enabled': True,
            'created_at': now - 100, 'next_run_at': now - 1, **values}))


def test_concurrent_schedulers_dispatch_each_occurrence_once(setup):
    _, app, _, issue = setup
    platform, now = app.state.platform, int(time.time())
    add_task(platform, 'due', now)
    barrier = threading.Barrier(2)
    def tick(_):
        barrier.wait(timeout=5)
        Scheduler(platform).tick(now)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(tick, range(2)))
    issue.assert_called_once_with(ADMIN_ID, 'pc-a', 'sleep')
    Scheduler(platform).tick(now)
    assert issue.call_count == 1
    with platform.sessions() as db:
        task = db.get(ScheduledTask, 'due')
        assert task.last_run_at == now and task.next_run_at > now
        assert list(db.scalars(select(AuditLog.event).where(AuditLog.event == 'schedule_fired'))) == ['schedule_fired']


def test_scheduler_failure_revocation_and_shutdown(setup):
    client, app, _, issue = setup
    platform, now = app.state.platform, int(time.time())
    add_task(platform, 'a-fail', now)
    add_task(platform, 'b-pass', now, device_id='pc-b')
    add_task(platform, 'c-disabled', now, enabled=False)
    add_task(platform, 'd-foreign', now, device_id='foreign')
    issue.side_effect = [ConnectionError('offline'), {'accepted': True}]
    Scheduler(platform).tick(now)
    assert issue.call_count == 2
    with platform.sessions() as db:
        assert {'schedule_failed', 'schedule_fired'} <= set(db.scalars(select(AuditLog.event)))
        assert db.get(ScheduledTask, 'a-fail').next_run_at > now
    add_task(platform, 'e-revoked', now)
    with platform.sessions.begin() as db:
        db.get(Device, 'pc-a').revoked_at = now
    Scheduler(platform).tick(now)
    assert issue.call_count == 2
    with client:
        assert app.state.scheduler._thread.is_alive()
    assert app.state.scheduler._thread is None


def test_action_scopes_survive_enrollment_and_renewal(setup):
    client, app, csrf, issue = setup
    form = {'csrf': csrf, 'name': '受限手机', 'scopes_present': '1', 'allow_sleep': 'on'}
    assert client.post('/clients/enroll', data=form).status_code == 200
    with app.state.platform.sessions() as db:
        assert db.scalar(select(ClientEnrollment)).allowed_actions == 'sleep'
    assert client.post('/clients/enroll', data={**form, 'allow_sleep': ''}).status_code == 400
    mobile = app.state.platform.mobile
    code = mobile.create_enrollment(ADMIN_ID, 'Test', ['sleep'])
    credentials = mobile.enroll({'code': code})
    token = mobile.renew({key: credentials[key] for key in ('client_id', 'refresh_token')})['access_token']
    headers = {'Authorization': 'Bearer ' + token}
    path = '/api/v2/devices/pc-a/commands'
    forbidden = client.post(path, headers=headers, json={'action': 'shutdown'})
    assert forbidden.status_code == 403 and '关机' in forbidden.text
    assert client.post(path, headers=headers, json={'action': 'sleep'}).status_code == 200
    assert client.post('/api/v2/devices/batch-command', headers={**headers, 'X-CSRF-Token': csrf},
        json={'device_ids': ['pc-a'], 'action': 'shutdown'}).status_code == 405
    assert client.post(path, headers={'X-CSRF-Token': csrf}, json={'action': 'shutdown'}).status_code == 200
    assert issue.call_count == 2
    with app.state.platform.sessions.begin() as db:
        db.get(ClientSession, credentials['client_id']).allowed_actions = ''
    assert client.post(path, headers=headers, json={'action': 'shutdown'}).status_code == 200
    client.cookies.clear()
    assert client.get('/api/v2/devices/pc-a/online', headers=headers).json()['online'] is True
    assert client.get('/api/v2/devices/foreign/online', headers=headers).status_code == 404


def test_removed_groups_and_batch_do_not_change_devices_or_dispatch_commands(setup):
    client, app, csrf, issue = setup
    headers = {'X-CSRF-Token': csrf}
    with app.state.platform.sessions.begin() as db:
        device = db.get(Device, 'pc-a')
        previous = {**device.meta, 'group': '旧分组'}
        device.meta = previous
    assert client.post('/api/v2/devices/pc-a/group', headers=headers, json={'group': '办公室'}).status_code == 404
    assert client.post('/api/v2/devices/batch-command', headers=headers,
        json={'device_ids': ['pc-a', 'pc-b'], 'action': 'sleep'}).status_code == 405
    with app.state.platform.sessions() as db:
        assert db.get(Device, 'pc-a').meta == previous
    page = client.get('/dashboard')
    assert page.status_code == 200
    assert '旧分组' not in page.text and '批量操作' not in page.text
    assert 'data-device-id="pc-a"' in page.text and 'data-device-id="pc-b"' in page.text
    issue.assert_not_called()


def test_history_filters_paginates_and_joins_device_names(setup):
    client, app, _, _ = setup
    with app.state.platform.sessions.begin() as db:
        for i in range(55):
            db.add(AuditLog(id=f'history-{i:02}', owner_id=ADMIN_ID, event='schedule_fired',
                target_device_id='pc-a', created_at=timestamp('2026-10-01T08:30:00') + i))
        db.add(AuditLog(id='private-event', owner_id='other', event='schedule_fired', created_at=1))
    first = client.get('/activity?event=schedule_fired').text
    second = client.get('/activity?event=schedule_fired&page=2').text
    assert first.count('<small class="block muted">') == 50
    assert second.count('<small class="block muted">') == 5
    assert '第 2 / 2 页' in second and '电脑 pc-a' in second and '2026-10-01 08:30' in second
    assert '计划任务已执行' in first and '共 55 条' in first
    assert first.index('事件类型<select') < first.index('远程操作</h2>')


def test_notification_management_ownership_and_multiple_recipients(setup):
    client, app, csrf, _ = setup
    form = {'csrf': csrf, 'device_id': 'pc-a', 'openid': 'person-a', 'template_id': 'template',
            'offline_minutes': '5', 'enabled': 'on'}
    assert client.post('/settings/notifications', data={**form, 'csrf': ''}).status_code == 403
    assert client.post('/settings/notifications', data={**form, 'device_id': 'foreign'}).status_code == 404
    assert client.post('/settings/notifications', data={**form, 'offline_minutes': '0'}).status_code == 400
    for values in (form, {**form, 'offline_minutes': '10'}, {**form, 'openid': 'person-b'}):
        assert client.post('/settings/notifications', data=values).status_code == 200
    with app.state.platform.sessions() as db:
        rows = list(db.scalars(select(NotificationConfig).order_by(NotificationConfig.openid)))
        assert len(rows) == 2 and rows[0].offline_minutes == 10
    assert client.post(f'/settings/notifications/{rows[0].id}/toggle', data={'csrf': csrf}).status_code == 200
    assert client.post(f'/settings/notifications/{rows[1].id}/delete', data={'csrf': csrf}).status_code == 200
    with app.state.platform.sessions() as db:
        assert not db.get(NotificationConfig, rows[0].id).enabled
        assert db.get(NotificationConfig, rows[1].id) is None


def test_notifications_threshold_cooldown_failure_isolation_and_claim(setup, monkeypatch):
    _, app, _, _ = setup
    platform, now = app.state.platform, int(time.time())
    platform.settings = replace(platform.settings, wx_app_id='test-app', wx_app_secret='test-secret')
    with platform.sessions.begin() as db:
        db.get(Device, 'pc-a').last_seen_at = now - 600
        for name, minutes, last in [('a-fail', 5, None), ('b-send', 5, None), ('c-recent', 5, now - 60), ('d-wait', 30, None)]:
            db.add(NotificationConfig(id=name, owner_id=ADMIN_ID, device_id='pc-a', openid=name,
                template_id='template', offline_minutes=minutes, last_sent_at=last, enabled=True))
    send = Mock(side_effect=[ValueError('simulated network failure'), None])
    notifier = Notifier(platform)
    monkeypatch.setattr(notifier, 'send', send)
    notifier.check(now, threading.Event())
    assert [call.args[0].id for call in send.call_args_list] == ['a-fail', 'b-send']
    with platform.sessions() as db:
        assert db.get(NotificationConfig, 'a-fail').last_sent_at is None
        assert db.get(NotificationConfig, 'b-send').last_sent_at == now
    send.reset_mock(side_effect=True)
    barrier = threading.Barrier(2)
    def tick(_):
        barrier.wait(timeout=5)
        notifier.check(now, threading.Event())
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(tick, range(2)))
    send.assert_called_once()
    notifier.check(now + 60, threading.Event())
    assert send.call_count == 1


def test_wechat_disabled_token_cache_and_expiry_retry(setup, monkeypatch):
    _, app, _, _ = setup
    platform = app.state.platform
    request = Mock()
    monkeypatch.setattr('cloud_app.app.notify.wechat_request', request)
    Notifier(platform).check(int(time.time()), threading.Event())
    request.assert_not_called()
    platform.settings = replace(platform.settings, wx_app_id='test-app', wx_app_secret='test-secret')
    request.side_effect = [{'access_token': 'fake-one', 'expires_in': 7200}, {'errcode': 40001},
                          {'access_token': 'fake-two', 'expires_in': 7200}, {'errcode': 0}, {'errcode': 0}]
    notifier = Notifier(platform)
    assert notifier.access_token() == notifier.access_token() == 'fake-one'
    assert request.call_count == 1
    config = NotificationConfig(openid='test-openid', template_id='test-template')
    device = Device(name='测试电脑')
    notifier.send(config, device, timestamp('2026-10-01T08:30:00'))
    notifier.send(config, device, timestamp('2026-10-01T08:30:00'))
    assert request.call_count == 5
    payload = request.call_args.args[1]
    assert payload['data'] == {'thing1': {'value': '测试电脑'}, 'time2': {'value': '2026-10-01 08:30'}}
    assert 6900 < notifier._expires_at - time.monotonic() <= 7000


def test_sse_changes_keepalive_reauthentication_and_disconnect():
    class Request:
        disconnected = False
        async def is_disconnected(self): return self.disconnected
    async def check():
        request = Request()
        state, authorized = {'online': False}, True
        stream = device_events(request, lambda: state.copy(), lambda: authorized, interval=0)
        assert '"online":false' in await anext(stream)
        assert await anext(stream) == ': keep-alive\n\n'
        state['online'] = True
        assert '"online":true' in await anext(stream)
        authorized = False
        with pytest.raises(StopAsyncIteration): await anext(stream)
        request.disconnected = True
        stream = device_events(request, lambda: pytest.fail('disconnected client queried'), lambda: True, interval=0)
        with pytest.raises(StopAsyncIteration): await anext(stream)
    asyncio.run(check())


def test_sse_endpoint_requires_session_and_disables_proxy_buffering(setup, monkeypatch):
    client, _, _, _ = setup
    async def finite_events(*args):
        yield 'event: devices\ndata: []\n\n'
    monkeypatch.setattr('cloud_app.app.main.device_events', finite_events)
    response = client.get('/api/v2/events/devices')
    assert response.headers['x-accel-buffering'] == 'no'
    assert response.headers['content-type'].startswith('text/event-stream')
    client.cookies.clear()
    assert client.get('/api/v2/events/devices').status_code == 401
