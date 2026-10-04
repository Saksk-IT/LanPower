const assert = require('node:assert/strict');
const {CodexConnection} = require('../mini_program/utils/codex-remote');
const {RpcFragments} = require('../mini_program/utils/codex-fragments');

async function main() {
  const sockets = [], states = [];
  const connection = new CodexConnection({
    cloud: {session: {url: 'https://fixture.example', access_token: 'fixture', access_expires_at: Date.now() / 1000 + 3600}, call: async () => ({})},
    wxApi: {connectSocket: () => {
      const socket = {sent: [], onOpen(fn) {this.open = fn;}, onMessage(fn) {this.receive = fn;}, onClose(fn) {this.lost = fn;}, onError() {},
        send(options) {this.sent.push(JSON.parse(options.data)); options.success();}, close() {}};
      sockets.push(socket); return socket;
    }}, state: state => states.push(state), event: () => {}
  });
  try {
    connection.connect('same-computer'); await new Promise(resolve => setImmediate(resolve));
    const socket = sockets[0]; socket.open();
    const pending = connection.request('thread/read', {threadId: 'shared'}), id = socket.sent[0].payload.id;
    const text = '共享页面完整历史🎨'.repeat(60000), rpcId = 'r-unique-wire-id';
    const body = JSON.stringify({id: rpcId, result: {text}}), parts = body.match(/[\s\S]{1,16000}/g);
    for (let index = 0; index < parts.length; index++) socket.receive({data: JSON.stringify({type: 'rpc_chunk', id, rpcId, index, count: parts.length, data: parts[index]})});
    assert.equal((await pending).text, text); assert.equal(connection.fragments.parts.size, 0);
    socket.lost({code: 4409}); assert.equal(states.at(-1), 'update_required');
    const fragments = new RpcFragments();
    fragments.accept({id: 1, rpcId: 'a', index: 0, count: 2, data: '{"id":"a",'});
    assert.throws(() => fragments.accept({id: 1, rpcId: 'b', index: 1, count: 2, data: '"result":{}}'}), /invalid_chunk/);
    fragments.clear();
    assert.throws(() => fragments.accept({id: 1, rpcId: 'a', index: 0, count: 1, data: '{"id":"b","result":{}}'}), /invalid_chunk/);
    console.log('小程序多页面分段回包、标识校验及旧版 Cloud 提示检查通过。');
  } finally {connection.stop();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
