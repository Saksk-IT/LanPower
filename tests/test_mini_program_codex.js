const assert = require('node:assert/strict');
const {CodexConnection} = require('../mini_program/utils/codex-remote');
const {markdown, diffSummary} = require('../mini_program/utils/codex-format');
const {CLIENT_KEY} = require('../mini_program/utils/cloud');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('页面未到达预期状态');
}
class Socket {
  constructor(send) { this.transport = send; this.frames = []; }
  onOpen(fn) { this.openHandler = fn; }
  onMessage(fn) { this.messageHandler = fn; }
  onClose(fn) { this.closeHandler = fn; }
  onError(fn) { this.errorHandler = fn; }
  frame(value) { this.messageHandler({data: JSON.stringify(value)}); }
  send(options) { this.frames.push(JSON.parse(options.data)); options.success(); if (this.transport) this.transport(this, this.frames.at(-1)); }
  close() { this.closed = true; }
}
function timerHarness() { const jobs = new Map(); let sequence = 0; return {
  jobs, timer: (fn, delay) => { const id = ++sequence; jobs.set(id, {fn, delay}); return id; }, clearTimer: id => jobs.delete(id)
}; }

async function main() {
  const timers = timerHarness(), sockets = [], states = [], events = [], cloud = {
    session: {url: 'https://power.example.com', access_token: 'fixture-only', access_expires_at: Date.now() / 1000 + 3600}, call: async () => ({})};
  let handshake;
  const connection = new CodexConnection({cloud, wxApi: {connectSocket: options => {
    handshake = options; const socket = new Socket(); sockets.push(socket); return socket;
  }}, state: state => states.push(state), event: event => events.push(event), ...timers});
  connection.connect('pc-a'); await tick(); const socket = sockets[0]; socket.openHandler();
  assert.equal(handshake.url, 'wss://power.example.com/api/v2/remote/mobile/pc-a');
  assert.deepEqual(handshake.protocols, ['lanpower.codex.v1']); assert.equal(handshake.header.Authorization, 'Bearer fixture-only');
  const request = connection.request('thread/list'); const rpc = socket.frames.at(-1).payload;
  socket.frame({type: 'rpc', payload: {id: rpc.id, result: {data: []}}}); assert.deepEqual(await request, {data: []});
  const large = connection.request('thread/turns/list', {threadId: 'native'}), largeId = socket.frames.at(-1).payload.id;
  const fullText = '完整历史🎨'.repeat(90000), body = JSON.stringify({id: largeId, result: {text: fullText}}), chunks = body.match(/[\s\S]{1,16000}/g);
  chunks.forEach((data, index) => socket.frame({type: 'rpc_chunk', id: largeId, index, count: chunks.length, data}));
  assert.equal((await large).text, fullText); assert.equal(connection.fragments.parts.size, 0);
  socket.frame({type: 'ping'}); assert.deepEqual(socket.frames.at(-1), {type: 'pong'});
  const lostTask = connection.request('turn/start', {threadId: 'chat', input: [{type: 'text', text: 'change'}]});
  socket.closeHandler({code: 1006}); await assert.rejects(lostTask, {code: 'CONNECTION'});
  assert.equal(connection.pending.size, 0);
  const retry = Array.from(timers.jobs.values()).find(job => job.delay === 1000); retry.fn(); await tick();
  const second = sockets[1]; second.openHandler();
  socket.frame({type: 'state', state: 'runtime_ready'}); assert.notEqual(states.at(-1), 'runtime_ready');
  assert.equal(second.frames.filter(f => f.payload?.method === 'turn/start').length, 0, 'lost task must never replay');
  connection.stop(); assert.equal(timers.jobs.size, 0);
  const forbidden = new CodexConnection({cloud: {...cloud, call: async () => { const error = new Error(); error.code = 'FORBIDDEN'; throw error; }},
    wxApi: {connectSocket: () => assert.fail('forbidden client opened a socket')}, event: () => {}, state: s => states.push(s), ...timers});
  forbidden.connect('pc-a'); await tick(); assert.equal(states.at(-1), 'forbidden'); forbidden.stop();
  const lateCloud = {...cloud, call: () => new Promise(resolve => {lateCloud.resolve = resolve;})};
  const late = new CodexConnection({cloud: lateCloud, wxApi: {connectSocket: () => assert.fail('hidden page opened a socket')},
    event: () => {}, state: () => {}, ...timers});
  late.connect('pc-a'); late.stop(); lateCloud.resolve({}); await tick();

  const unsafe = markdown('**正常** <img src=x onerror=alert(1)> [链接](javascript:alert(1))\n```\n<div>代码</div>\n```');
  const validate = nodes => { for (const node of nodes) {
    assert.ok(['text', undefined].includes(node.type)); assert.ok([undefined, 'div', 'pre', 'strong', 'code'].includes(node.name));
    assert.ok(!node.attrs?.href && !node.attrs?.src); if (node.children) validate(node.children);
  }}; validate(unsafe);
  assert.deepEqual(diffSummary('--- a/a.js\n+++ b/a.js\n-old\n+new\n+next'), {files: [{path: 'a.js', added: 2, removed: 1}], added: 2, removed: 1});

  global.Page = definition => {global.definition = definition;};
  require('../mini_program/pages/codex/codex');
  const session = {url: 'https://power.example.com', client_id: '12345678-1234-1234-1234-123456789012',
    access_token: 'a'.repeat(43), refresh_token: 'b'.repeat(43), access_expires_at: Math.floor(Date.now() / 1000) + 3600};
  const storage = {[CLIENT_KEY]: session}, calls = [], pageSockets = [], root = 'C:\\Fixture\\LanPower';
  let active = null, latestSocket, readDelay;
  const threads = [{id: 'a', name: '优化小程序布局', projectName: 'LanPower', cwd: root, projectPath: root, control: 'available', updatedAt: Date.now() / 1000},
    {id: 'b', name: '桌面进度', projectName: 'LanPower', cwd: root, control: 'desktop', live: {state: 'running', startedAt: Date.now() / 1000 - 45}, updatedAt: Date.now() / 1000 - 600}];
  global.wx = {getStorageSync: key => storage[key], setStorageSync: (key, value) => {storage[key] = value;}, removeStorageSync: key => delete storage[key],
    getAppBaseInfo: () => ({theme: 'light'}), setNavigationBarColor: () => {},
    request: options => options.success({statusCode: 200, data: options.url.endsWith('/devices') ?
      [{device_id: 'pc-a', device_type: 'windows', name: '开发电脑'}, {device_id: 'pc-b', device_type: 'windows', name: '另一台电脑'}] : {}}),
    connectSocket: () => {
      const socket = new Socket((s, frame) => {
        if (frame.type !== 'rpc' || !frame.payload.method) return;
        const {id, method, params} = frame.payload; calls.push({method, params}); let result = {};
        if (method === 'lanpower/status') result = {loggedIn: true, sessionHandoff: true, projects: [{name: 'LanPower', path: root}], activeTurns: active ? [{threadId: 'a', turnId: active}] : []};
        if (method === 'thread/list') result = {data: threads, nextCursor: null};
        if (method === 'model/list') result = {data: [{id: 'model-a', displayName: '测试模型'}]};
        if (method === 'thread/read') {
          result = {thread: {...threads.find(t => t.id === params.threadId), turns: [{id: 'old', status: 'completed', items: [
            {id: 'user-old', type: 'userMessage', content: [{type: 'text', text: '检查布局'}]}, {id: 'assistant-old', type: 'agentMessage', text: '**已检查** 页面布局。'}]}]}};
          if (readDelay) {readDelay(s, {type: 'rpc', payload: {id, result}}); return;}
        }
        if (method === 'thread/resume') threads.find(t => t.id === params.threadId).control = 'remote';
        if (method === 'turn/start') {active = 'active'; result = {turn: {id: active, status: 'inProgress'}};}
        if (method === 'turn/steer') result = {turnId: active};
        if (method === 'turn/interrupt') {active = null;}
        setImmediate(() => {
          if (method === 'turn/steer') s.frame({type: 'rpc', payload: {method: 'item/completed', params: {
            threadId: params.threadId, turnId: active, item: {id: 'echo-' + id, type: 'userMessage', content: params.input}}}});
          s.frame({type: 'rpc', payload: {id, result}});
          if (method === 'turn/start') s.frame({type: 'rpc', payload: {method: 'turn/started', params: {threadId: 'a', turn: {id: 'active'}}}});
          if (method === 'turn/interrupt') s.frame({type: 'rpc', payload: {method: 'turn/completed', params: {threadId: 'a', turn: {id: 'active', status: 'interrupted'}}}});
        });
      }); pageSockets.push(socket); latestSocket = socket;
      setImmediate(() => {socket.openHandler(); socket.frame({type: 'state', state: 'runtime_ready'});}); return socket;
    }};
  const page = {...global.definition, data: JSON.parse(JSON.stringify(global.definition.data))};
  page.setData = changes => { assert.ok(Buffer.byteLength(JSON.stringify(changes)) <= 1048576, 'native setData payload exceeds 1 MiB'); for (const [key, value] of Object.entries(changes)) {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let object = page.data;
    for (const part of parts.slice(0, -1)) object = object[part]; object[parts.at(-1)] = value;
  }};
  try {
    page.onLoad(); page.onShow(); await until(() => page.data.sessions.length === 2 && page.data.models.length === 2);
    assert.equal(page.data.deviceName, '开发电脑'); assert.equal(page.data.ready, true);
    await page.readThread('b'); assert.equal(page.data.desktop, true); assert.equal(page.data.canInterrupt, false);
    page.input({detail: {value: '不能接管'}}); assert.equal(page.data.canSend, false);
    await page.readThread('a'); page.input({detail: {value: '请优化布局'}}); await page.send(); await tick();
    assert.equal(calls.filter(c => c.method === 'thread/resume').length, 1);
    assert.equal(calls.filter(c => c.method === 'turn/start').length, 1); assert.equal(page.data.canInterrupt, true);
    page.onEvent({method: 'item/completed', params: {threadId: 'a', turnId: 'active', item: {
      id: 'actual-user', type: 'userMessage', content: [{type: 'text', text: '请优化布局'}]}}});
    assert.equal(page.items.filter(i => i.kind === 'user' && i.text === '请优化布局').length, 1, 'late native echo replaces the temporary bubble');
    page.input({detail: {value: '只改输入栏'}}); await page.send();
    assert.equal(calls.find(c => c.method === 'turn/steer').params.expectedTurnId, 'active');
    assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(page.items.filter(i => i.kind === 'user' && i.text === '只改输入栏').length, 1, 'early native echo must not create a duplicate bubble');
    page.input({detail: {value: '只改输入栏'}}); await page.send();
    assert.equal(page.items.filter(i => i.kind === 'user' && i.text === '只改输入栏').length, 2, 'sending identical text twice still creates two distinct messages');
    page.onEvent({method: 'item/agentMessage/delta', params: {threadId: 'b', itemId: 'foreign', delta: '其他会话'}});
    assert.ok(!page.items.some(i => i.id === 'foreign'));
    page.onEvent({method: 'item/agentMessage/delta', params: {threadId: 'a', itemId: 'reply', delta: '已开始'}});
    await new Promise(resolve => setTimeout(resolve, 140)); assert.ok(page.data.messages.some(i => i.text === '已开始'));
    page.onEvent({id: 'approve', method: 'item/fileChange/requestApproval', params: {threadId: 'a'}});
    page.openApproval({currentTarget: {dataset: {key: JSON.stringify('approve')}}});
    await page.decide({currentTarget: {dataset: {allow: 'yes'}}}); await page.decide({currentTarget: {dataset: {allow: 'yes'}}});
    assert.equal(latestSocket.frames.filter(f => f.payload?.id === 'approve' && f.payload?.result).length, 1);
    page.onEvent({method: 'serverRequest/resolved', params: {requestId: 'approve'}}); assert.equal(page.data.sheet, '');
    await page.interrupt(); await tick(); assert.equal(page.data.running, false);
    page.changeTheme({currentTarget: {dataset: {value: 'dark'}}}); assert.equal(page.data.theme, 'dark');
    assert.equal(storage.lanpower_codex_theme_v1, 'dark');
    page.items = Array.from({length: 80}, (_, i) => ({id: 'large-' + i, kind: 'assistant', text: '中文🙂'.repeat(3000)}));
    page.aggregateDiff = '+中文🙂\n'.repeat(10000); page.paint();
    assert.equal(page.data.historyNotice, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page.data)) < 1048576, 'Chinese and emoji history must stay within the native data limit');
    const starts = calls.filter(c => c.method === 'turn/start').length;
    page.onHide(); page.onShow(); await until(() => pageSockets.length === 2 && page.data.ready && !page.listing);
    assert.equal(calls.filter(c => c.method === 'turn/start').length, starts, 'returning to page must not resend');
    await page.readThread('a');
    let stale; readDelay = (s, frame) => {stale = () => s.frame(frame);};
    const staleRead = page.readThread('a', false), staleRejected = assert.rejects(staleRead, {code: 'CONNECTION'}); await tick();
    page.chooseDevice(page.data.devices[1]); stale(); await staleRejected; readDelay = null;
    assert.equal(page.thread, null); assert.equal(page.data.messages.length, 0, 'old computer response must not leak into new selection');
    assert.equal(Object.keys(storage).filter(k => k.includes('thread') || k.includes('prompt')).length, 0);
  } finally {page.onUnload();}
  console.log('小程序 Codex Remote：授权、重连不重发、会话隔离、引导暂停、单次审批、主题与内容安全检查通过');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
