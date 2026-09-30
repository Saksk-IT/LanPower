const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {makeMagicPacket, broadcastWake} = require('../mini_program/utils/wol');
const {parsePairingLink} = require('../mini_program/utils/pairing');
const {parseRemotePairing} = require('../mini_program/utils/remote');

const token = 'a'.repeat(64);
const pairing = parsePairingLink(`http://192.168.1.100:48211/#access=${token}`);
const remote = parseRemotePairing(`https://power.example.com/#lanpower-remote=home-router.${'b'.repeat(64)}`);

function createPage(stored, request, extra = {}) {
  global.wx = {
    getStorageSync: (key) => stored[key] || null,
    removeStorageSync: (key) => delete stored[key],
    request,
    showModal: (options) => options.success({confirm: true}),
    showToast: () => {},
    ...extra
  };
  const page = Object.assign({}, global.pageDefinition, {data: {...global.pageDefinition.data}});
  page.setData = (changes) => Object.assign(page.data, changes);
  page.onLoad();
  return page;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  assert.deepEqual(pairing, {host: '192.168.1.100', token});
  assert.throws(() => parsePairingLink(`http://8.8.8.8:48211/#access=${token}`));
  assert.deepEqual(remote, {url: 'https://power.example.com', gatewayId: 'home-router', token: 'b'.repeat(64)});
  assert.throws(() => parseRemotePairing(`http://power.example.com/#lanpower-remote=home-router.${token}`));
  for (const invalidPort of ['0', '65536', '99999']) {
    assert.throws(() => parseRemotePairing(`https://power.example.com:${invalidPort}/#lanpower-remote=home-router.${token}`));
  }
  for (const validPort of ['1', '65535']) {
    assert.equal(parseRemotePairing(`https://power.example.com:${validPort}/#lanpower-remote=home-router.${token}`).url,
      `https://power.example.com:${validPort}`);
  }

  const packet = new Uint8Array(makeMagicPacket('02-11-22-33-44-55'));
  const mac = [0x02, 0x11, 0x22, 0x33, 0x44, 0x55];
  assert.equal(packet.length, 102);
  assert.ok(packet.slice(0, 6).every((byte) => byte === 0xff));
  for (let repeat = 0; repeat < 16; repeat += 1) {
    assert.deepEqual([...packet.slice(6 + repeat * 6, 12 + repeat * 6)], mac);
  }

  const scheduled = [];
  const intervals = [];
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  global.setTimeout = (fn, delay) => { scheduled.push({fn, delay}); return scheduled.length; };
  global.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  try {
    const datagrams = [];
    let closed = false;
    const socket = {
      onError() {}, bind() { return 12345; },
      send(options) { datagrams.push(options); }, close() { closed = true; }
    };
    broadcastWake({createUDPSocket: () => socket}, () => {});
    scheduled.splice(0).sort((left, right) => left.delay - right.delay).forEach(({fn}) => fn());
    assert.equal(datagrams.length, 6);
    assert.deepEqual(new Set(datagrams.map(({address}) => address)),
      new Set(['255.255.255.255', '192.168.1.255']));
    assert.ok(datagrams.every(({port, setBroadcast, message}) =>
      port === 9 && setBroadcast === true && message.byteLength === 102));
    assert.equal(closed, true);

    global.Page = (definition) => { global.pageDefinition = definition; };
    require('../mini_program/pages/index/index');

    // A reachable Windows API always wins, even when remote pairing exists.
    const localCalls = [];
    const localPage = createPage({lanpower_pairing_v1: pairing, lanpower_remote_v1: remote}, (options) => {
      localCalls.push(options);
      if (options.method === 'POST') options.success({statusCode: 202});
      else options.success({statusCode: 200, data: {state: 'online', device: 'Test PC'}});
    });
    await localPage.refresh();
    assert.equal(localPage.data.mode, 'local');
    assert.equal(localPage.data.canControl, true);
    assert.ok(localCalls.every(({url}) => url.startsWith('http://')));
    localPage.sendAction({currentTarget: {dataset: {action: 'sleep'}}});
    const localAction = localCalls.find(({method}) => method === 'POST');
    assert.equal(localAction.url, 'http://192.168.1.100:48211/api/power');
    assert.equal(localAction.header.Authorization, `Bearer ${token}`);
    assert.deepEqual(localAction.data, {action: 'sleep'});

    // Local status failure can select the Cloud relay for an online PC.
    const remoteCalls = [];
    let remotePCOnline = true;
    const remotePage = createPage({lanpower_pairing_v1: pairing, lanpower_remote_v1: remote}, (options) => {
      remoteCalls.push(options);
      if (options.url.startsWith('http://')) options.fail({errMsg: 'PC is offline'});
      else if (options.method === 'POST') options.success({statusCode: 200, data: {ok: true, state: 'transitioning'}});
      else options.success({statusCode: 200, data: {gateway: 'online', pc: remotePCOnline ? 'online' : 'offline'}});
    });
    await remotePage.refresh();
    assert.equal(remotePage.data.mode, 'remote');
    remotePage.sendAction({currentTarget: {dataset: {action: 'shutdown'}}});
    const remoteAction = remoteCalls.find(({method}) => method === 'POST');
    assert.equal(remoteAction.url, 'https://power.example.com/api/v1/client/commands');
    assert.equal(remoteAction.header.Authorization, `Bearer ${remote.token}`);
    assert.notEqual(remoteAction.header.Authorization, `Bearer ${token}`);
    remotePCOnline = false;
    await remotePage.refresh();
    assert.equal(remotePage.data.wakeRoute, 'remote');
    remotePage.wake();
    assert.deepEqual(remoteCalls.at(-1).data, {gateway_id: 'home-router', action: 'wake'});

    // Regression: a powered-off PC and failed LAN + Cloud checks still permit LAN WOL.
    const unavailableCalls = [];
    const localWakePackets = [];
    const offlinePage = createPage({lanpower_pairing_v1: pairing, lanpower_remote_v1: remote}, (options) => {
      unavailableCalls.push(options);
      options.fail({errMsg: 'network unreachable'});
    }, {createUDPSocket: () => ({
      onError() {}, bind() { return 12345; },
      send(options) { localWakePackets.push(options); }, close() {}
    })});
    await offlinePage.refresh();
    assert.equal(offlinePage.data.state, 'offline');
    assert.equal(offlinePage.data.mode, 'none');
    assert.equal(offlinePage.data.wakeRoute, 'local');
    assert.equal(offlinePage.data.canWake, true);
    assert.match(offlinePage.data.detail, /远程服务暂时不可用.*局域网唤醒/);
    assert.match(fs.readFileSync(path.join(__dirname, '../mini_program/pages/index/index.wxml'), 'utf8'),
      /disabled="{{!canWake \|\| state === 'waking'}}"/);
    offlinePage.wake();
    assert.equal(offlinePage.data.state, 'waking');
    assert.equal(localWakePackets.length, 2);
    assert.equal(unavailableCalls.filter(({method}) => method === 'POST').length, 0);

    // Wake polling coalesces calls while one LAN request is still pending.
    const pending = [];
    const pollingPage = createPage({lanpower_pairing_v1: pairing}, (options) => pending.push(options));
    pollingPage.startWakeWait('local');
    const poll = intervals.at(-1);
    poll(); poll(); poll();
    await tick();
    assert.equal(pending.length, 1);
    pending[0].fail({errMsg: 'PC is offline'});
    await tick();
    assert.equal(pending.length, 2);
    pending[1].fail({errMsg: 'PC is offline'});
    await tick();
  } finally {
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
  }
  console.log('mini program LAN, remote, WOL fallback and polling: PASS');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
