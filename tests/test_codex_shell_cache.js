const test = require('node:test');
const assert = require('node:assert/strict');
const {readShellSnapshot, writeShellSnapshot} = require('../mini_program/utils/codex/shell-cache');
const {retainSession, takeRetainedSession, discardRetainedSession} = require('../mini_program/utils/codex/session-cache');

test('小程序外壳缓存只保存摘要，隔离账号环境与电脑并按时过期', () => {
  const storage = new Map(), wx = {getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value)};
  writeShellSnapshot(wx, 'account-a:cloud-a', {deviceId: 'pc-a', threadId: 'chat-a', archived: false,
    threads: [{id: 'chat-a', name: '示例聊天', cwd: 'D:/Example', turns: [{secret: '正文'}], diff: '代码', live: {body: '输出'},
      credentials: 'secret', messages: ['正文'], status: {type: 'idle', body: '内部数据'}}],
    library: {revision: 2, credentials: 'secret', preferences: {pinned: ['chat-a'], aliases: {'d:/example': '示例'}, content: '正文'}}});
  const snapshot = readShellSnapshot(wx, 'account-a:cloud-a', 'pc-a');
  assert.equal(snapshot.threadId, 'chat-a'); assert.equal(snapshot.threads[0].name, '示例聊天');
  assert.deepEqual(snapshot.threads[0].status, {type: 'idle'}); assert.deepEqual(snapshot.library.preferences.pinned, ['chat-a']);
  const serialized = JSON.stringify([...storage.values()]);
  for (const forbidden of ['正文', '代码', '输出', 'secret', 'credentials', 'turns', 'diff', 'messages']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.equal(readShellSnapshot(wx, 'account-b:cloud-a', 'pc-a'), null);
  assert.equal(readShellSnapshot(wx, 'account-a:cloud-b', 'pc-a'), null);
  assert.equal(readShellSnapshot(wx, 'account-a:cloud-a', 'pc-b'), null);
  [...storage.values()][0].updatedAt -= 31 * 60 * 1000;
  assert.equal(readShellSnapshot(wx, 'account-a:cloud-a', 'pc-a'), null);
});

test('缓存存储被禁用时不阻塞连接流程', () => {
  const wx = {getStorageSync: () => {throw new Error('disabled');}, setStorageSync: () => {throw new Error('full');}};
  assert.doesNotThrow(() => writeShellSnapshot(wx, 'scope', {deviceId: 'pc', threads: []}));
  assert.equal(readShellSnapshot(wx, 'scope', 'pc'), null);
});

test('短期内存会话跨页面复用，切换身份或超时后释放连接', async () => {
  let disposed = 0; const session = {dispose: () => disposed++};
  retainSession('account:cloud:pc', session);
  assert.equal(takeRetainedSession('account:cloud:pc'), session); assert.equal(disposed, 0);
  retainSession('account:cloud:pc', session); assert.equal(takeRetainedSession('another-account:cloud:pc'), null); assert.equal(disposed, 1);
  retainSession('account:cloud:pc', session, 1); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(disposed, 2); assert.equal(takeRetainedSession('account:cloud:pc'), null); discardRetainedSession();
});
