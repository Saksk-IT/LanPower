const assert = require('node:assert/strict');
const {makeMagicPacket, broadcastWake} = require('../mini_program/utils/wol');
const {parsePairingLink} = require('../mini_program/utils/pairing');

const token = 'a'.repeat(64);
const pairing = parsePairingLink(`http://192.168.1.100:48211/#access=${token}`);
assert.deepEqual(pairing, {host: '192.168.1.100', token});
assert.throws(() => parsePairingLink(`http://8.8.8.8:48211/#access=${token}`));

const packet = new Uint8Array(makeMagicPacket('02-11-22-33-44-55'));
const mac = [0x30, 0x56, 0x0f, 0xa1, 0xdf, 0x96];
assert.equal(packet.length, 102);
assert.ok(packet.slice(0, 6).every((byte) => byte === 0xff));
for (let repeat = 0; repeat < 16; repeat += 1) {
  assert.deepEqual([...packet.slice(6 + repeat * 6, 12 + repeat * 6)], mac);
}

const scheduled = [];
const originalTimeout = global.setTimeout;
const originalInterval = global.setInterval;
global.setTimeout = (fn, delay) => { scheduled.push({fn, delay}); return scheduled.length; };
global.setInterval = () => 1;
try {
  const datagrams = [];
  let closed = false;
  const socket = {
    onError() {},
    bind() { return 12345; },
    send(options) { datagrams.push(options); },
    close() { closed = true; }
  };
  broadcastWake({createUDPSocket: () => socket}, () => {});
  scheduled.sort((left, right) => left.delay - right.delay).forEach(({fn}) => fn());
  assert.equal(datagrams.length, 6);
  assert.deepEqual(new Set(datagrams.map(({address}) => address)), new Set(['255.255.255.255', '192.168.1.255']));
  assert.ok(datagrams.every(({port, setBroadcast, message}) =>
    port === 9 && setBroadcast === true && message.byteLength === 102));
  assert.equal(closed, true);

  const calls = [];
  global.wx = {
    getStorageSync: () => pairing,
    request(options) {
      calls.push(options);
      if (options.method === 'POST') {
        options.success({statusCode: 202});
      } else {
        options.success({statusCode: 200, data: {state: 'online', device: 'Test PC'}});
      }
    },
    showModal(options) { options.success({confirm: true}); }
  };
  global.Page = (definition) => { global.testPage = definition; };
  require('../mini_program/pages/index/index');
  const page = global.testPage;
  page.setData = (changes) => Object.assign(page.data, changes);
  page.onLoad();
  page.refresh();
  assert.equal(page.data.state, 'online');
  assert.equal(page.data.canControl, true);
  page.sendAction({currentTarget: {dataset: {action: 'sleep'}}});
  const action = calls.find(({method}) => method === 'POST');
  assert.equal(action.url, 'http://192.168.1.100:48211/api/power');
  assert.equal(action.header.Authorization, `Bearer ${token}`);
  assert.deepEqual(action.data, {action: 'sleep'});
  assert.equal(page.data.feedback, '睡眠指令已送达。');
} finally {
  global.setTimeout = originalTimeout;
  global.setInterval = originalInterval;
}

console.log('mini program packet, pairing, and power flow: PASS');
