const assert = require('node:assert/strict');
const {RemoteClient, taskLabel} = require('../cloud_app/static/remote.js');

async function run() {
  const sockets = [], events = [], states = [], timers = new Map(); let nextTimer = 0, nextId = 0;
  const client = new RemoteClient({socketFactory: device => {
    const socket = {device, readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; }};
    sockets.push(socket); return socket;
  }, event: event => events.push(event), state: state => states.push(state), id: () => 'request-' + (++nextId),
    timer: fn => { const key = ++nextTimer; timers.set(key, fn); return key; }, clearTimer: key => timers.delete(key)});
  client.connect('device-one'); const first = sockets[0]; first.onopen();
  const response = client.request('thread/list', {cwd: 'fixture'});
  first.onmessage({data: JSON.stringify({type: 'rpc', payload: {id: 'request-1', result: {data: []}}})});
  assert.deepEqual(await response, {data: []});
  first.onmessage({data: '{"type":"ping"}'}); assert.deepEqual(first.sent.at(-1), {type: 'pong'});
  first.onmessage({data: JSON.stringify({type: 'rpc', payload: {id: 7, method: 'item/fileChange/requestApproval', params: {}}})});
  assert.equal(events.at(-1).id, 7); client.decide(7, {decision: 'decline'});
  assert.deepEqual(first.sent.at(-1).payload, {id: 7, result: {decision: 'decline'}});
  const waiting = client.request('model/list');
  const unavailable = assert.rejects(waiting, /连接断开/);
  first.onmessage({data: '{"type":"state","state":"host_offline"}'}); await unavailable;
  assert.equal(client.pending.size, 0, 'host loss rejects calls even while the browser socket remains open');
  const task = client.request('turn/start', {threadId: 'fixture', input: [{type: 'text', text: 'fixture task'}]});
  const rejection = assert.rejects(task, /连接断开/);
  first.onclose({code: 1006}); await rejection;
  assert.equal(client.pending.size, 0);
  for (const fn of [...timers.values()]) fn(); timers.clear();
  const second = sockets[1]; second.onopen();
  assert.equal(second.sent.length, 0, 'a reconnect never resends a task');
  client.connect('device-two'); assert.equal(second.readyState, 3);
  first.onmessage({data: '{"type":"state","state":"runtime_ready"}'});
  assert.equal(states.at(-1), 'connecting', 'ignore events from an old device');
  const last = sockets.at(-1); last.onclose({code: 4409});
  assert.equal(states.at(-1), 'controller_busy'); assert.equal(timers.size, 0, 'controller conflict does not reconnect forever');
  client.stop(); assert.equal(client.pending.size, 0);
  let nativeSocket;
  const native = new RemoteClient({socketFactory: () => (nativeSocket = {readyState:1, send(raw) { this.last = JSON.parse(raw); }, close(){}}),
    event(){}, state(){}});
  native.connect('native-defaults');
  const nativeResponse = native.request('lanpower/status');
  assert.match(nativeSocket.last.payload.id, /^[0-9a-f-]{36}$/);
  nativeSocket.onmessage({data:JSON.stringify({type:'rpc',payload:{id:nativeSocket.last.payload.id,result:{projects:[]}}})});
  assert.deepEqual(await nativeResponse,{projects:[]}); native.stop();
  assert.equal(taskLabel({id:'desktop',control:'desktop'},'another','turn'), '桌面状态待确认');
  assert.equal(taskLabel({id:'desktop',control:'desktop',live:{state:'running'}},'another','turn'), '运行中');
  assert.equal(taskLabel({id:'desktop',control:'desktop',live:{state:'idle'}},'another','turn'), '桌面已连接');
  assert.equal(taskLabel({id:'current',control:'remote'},'current','turn'),'运行中');
  console.log('Codex Remote client: response routing, approval IDs, reconnect, task deduplication and stale-device isolation passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
