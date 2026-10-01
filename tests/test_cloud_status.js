const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {renderCard} = require('../cloud_app/static/status');

function fixture() {
  const fields = {};
  for (const name of ['badge', 'name', 'connection', 'control-hint', 'wake-hint', 'cloud', 'gateway', 'seen']) {
    fields[`[data-status-${name}]`] = [{textContent: '', hidden: false, classList: {toggle() {}}}];
  }
  const controls = {};
  fields['form input[name="action"]'] = ['status', 'sleep', 'hibernate', 'restart', 'shutdown', 'wake'].map(value => {
    const button = controls[value] = {disabled: false};
    return {value, form: {querySelector: () => button}};
  });
  return {dataset: {statusId: 'pc'}, controls, querySelectorAll: selector => fields[selector] || [],
    field: name => fields[`[data-status-${name}]`][0]};
}

const online = {device_id: 'pc', device_type: 'windows', state: 'online', cloud_agent: 'online',
  remote_control_available: true, wake_available: true};
const offline = {...online, state: 'offline', cloud_agent: 'offline', remote_control_available: false};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  const card = fixture();
  renderCard(card, online);
  assert.equal(card.field('badge').textContent, '在线');
  assert.equal(card.controls.shutdown.disabled, false);
  assert.equal(card.controls.wake.disabled, false);
  renderCard(card, {...online, cloud_agent: 'offline', remote_control_available: false});
  assert.equal(card.field('badge').textContent, '在线');
  assert.equal(card.controls.shutdown.disabled, true, 'LAN reachability does not imply permission to control');
  renderCard(card, {...online, state: 'transitioning'});
  assert.equal(card.field('badge').textContent, '正在执行电源操作');
  assert.ok(Object.values(card.controls).every(button => button.disabled));
  renderCard(card, offline);
  assert.equal(card.controls.wake.disabled, false);
  for (const state of ['unknown', 'removed']) {
    renderCard(card, {state});
    assert.ok(Object.values(card.controls).every(button => button.disabled));
  }

  const message = {textContent: ''}, summary = {dataset: {statusSummary: 'windows-online'}};
  const documentListeners = {}, windowListeners = {}, timers = new Map(), requests = [];
  let timerId = 0;
  const document = {
    hidden: false,
    querySelector: () => message,
    querySelectorAll: selector => selector === '[data-status-id]' ? [card] : [summary],
    addEventListener: (name, listener) => {documentListeners[name] = listener;}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloud_app/static/status'), 'utf8'), {
    document, window: {addEventListener: (name, listener) => {windowListeners[name] = listener;}},
    AbortController, Date,
    setTimeout: (callback, delay) => {const id = ++timerId; timers.set(id, {callback, delay}); return id;},
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => new Promise((resolve, reject) => {requests.push({url, options, resolve, reject});})
  });
  const respond = (request, status) => request.resolve({ok: true, json: async () => [status]});
  assert.equal(requests[0].url, '/api/v2/devices');
  assert.equal(requests[0].options.cache, 'no-store');
  windowListeners.focus();
  assert.equal(requests[0].options.signal.aborted, true);
  respond(requests[1], offline); await tick();
  respond(requests[0], online); await tick();
  assert.equal(card.field('badge').textContent, '离线', 'Old responses must not overwrite a newer status');
  assert.equal(summary.textContent, 0);

  const refresh = [...timers.values()].find(timer => timer.delay === 5000);
  assert.ok(refresh, 'Successful sync schedules the next update');
  refresh.callback();
  requests[2].reject(new Error('network unavailable')); await tick();
  assert.equal(card.field('badge').textContent, '状态未知');
  assert.ok(Object.values(card.controls).every(button => button.disabled));
  assert.equal(summary.textContent, '—');
  windowListeners.online();
  respond(requests[3], online); await tick();
  assert.equal(card.controls.shutdown.disabled, false);
  assert.equal(summary.textContent, 1);

  windowListeners.focus();
  document.hidden = true;
  documentListeners.visibilitychange();
  respond(requests[4], offline); await tick();
  assert.equal(card.field('badge').textContent, '在线', 'Hidden pages ignore late responses');
  assert.equal(timers.size, 0);
  document.hidden = false;
  documentListeners.visibilitychange();
  respond(requests[5], offline); await tick();
  assert.equal(card.field('badge').textContent, '离线');
  console.log('Cloud live status rendering, polling, network recovery and stale response protection: PASS');
}

main().catch(error => {console.error(error); process.exitCode = 1;});
