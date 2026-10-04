import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConnection } from '../src/lanpower/connection'

class FakeSocket {
  static OPEN = 1
  static sockets: FakeSocket[] = []
  readyState = 1
  sent: any[] = []
  onopen?: Function; onmessage?: Function; onclose?: Function; onerror?: Function
  constructor(public url: string, public protocol: string) { FakeSocket.sockets.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3 }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
describe('LanPower browser relay lifecycle', () => {
  let client: RemoteConnection
  beforeEach(() => {
    vi.useFakeTimers(); FakeSocket.sockets = []
    vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('location', { protocol: 'https:', host: 'local.example' })
    client = new RemoteConnection()
  })
  afterEach(() => { client.stop(); vi.useRealTimers(); vi.unstubAllGlobals() })
  it('keeps credentials out of the URL and never resends a disconnected mutation', async () => {
    client.connect('computer-one')
    const socket = FakeSocket.sockets[0]!
    expect(socket.url).toBe('wss://local.example/api/v2/remote/client/computer-one')
    expect(socket.protocol).toBe('lanpower.codex.v1')
    const request = client.request('turn/start', { threadId: 'chat' })
    const rejected = expect(request).rejects.toThrow('连接已断开')
    socket.onclose?.({ code: 1006 }); await rejected
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.sockets).toHaveLength(2)
    expect(FakeSocket.sockets[1]!.sent).toEqual([])
  })
  it('ignores responses from a previous computer and cancels its pending requests', async () => {
    client.connect('first'); const old = FakeSocket.sockets[0]!
    const pending = client.request('thread/read', { threadId: 'private-chat' })
    const rejected = expect(pending).rejects.toThrow('连接已断开')
    client.connect('second'); await rejected
    const event = vi.fn(); client.onEvent = event
    old.receive({ type: 'rpc', payload: { method: 'item/agentMessage/delta', params: { delta: 'old-computer' } } })
    expect(event).not.toHaveBeenCalled()
    expect(FakeSocket.sockets[1]!.url).toContain('/second')
  })
  it('preserves approval identifiers and requests a Cloud update for legacy controller rejection', async () => {
    const state = vi.fn(); client.onState = state; client.connect('one')
    const socket = FakeSocket.sockets[0]!
    const decision = client.decide('lp-approval-native', { decision: 'accept' })
    const rejected = expect(decision).rejects.toThrow('审批结果待确认')
    expect(socket.sent[0]).toEqual({ type: 'rpc', payload: { id: 'lp-approval-native', result: { decision: 'accept' } } })
    socket.onclose?.({ code: 4409 }); vi.advanceTimersByTime(60000)
    await rejected
    expect(state).toHaveBeenLastCalledWith('update_required')
    expect(FakeSocket.sockets).toHaveLength(1)
  })
  it('waits for a native approval receipt and prevents repeated decisions', async () => {
    client.connect('one'); const socket = FakeSocket.sockets[0]!
    const first = client.decide('approval', {decision:'accept'})
    await expect(client.decide('approval',{decision:'accept'})).rejects.toThrow('重复点击')
    socket.receive({type:'rpc',payload:{method:'serverRequest/resolved',params:{requestId:'approval'}}})
    await first; expect(socket.sent).toHaveLength(1)
    const second = client.decide('another',{decision:'decline'})
    client.reconcileApprovals([]); await second
  })
  it('retains structured errors and aborts a history read without replaying it', async () => {
    client.connect('one'); const socket = FakeSocket.sockets[0]!, controller = new AbortController()
    const pending = client.request('thread/turns/list',{threadId:'native'},controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({name:'AbortError'})
    controller.abort(); await rejected
    const read = client.request('thread/read',{threadId:'native'})
    socket.receive({type:'rpc',payload:{id:socket.sent[1].payload.id,error:{code:-32000,message:'result_too_large'}}})
    await expect(read).rejects.toMatchObject({code:'result_too_large'})
    expect(socket.sent).toHaveLength(2)
  })
  it('delivers large paginated history only after every fragment arrives',async () => {
    client.connect('one'); const socket = FakeSocket.sockets[0]!
    const pending = client.request('thread/turns/list',{threadId:'native'})
    const id = socket.sent[0].payload.id, text = '完整内容🎨'.repeat(100000)
    const raw = JSON.stringify({id,result:{text}}), parts = raw.match(/[\s\S]{1,16000}/g)!
    parts.forEach((data,index) => socket.receive({type:'rpc_chunk',id,index,count:parts.length,data}))
    expect((await pending).text).toBe(text)
  })
  it('discards a partial reply when the computer changes',async () => {
    client.connect('one'); const old = FakeSocket.sockets[0]!
    const pending = client.request('thread/read',{threadId:'private'}), rejected = expect(pending).rejects.toThrow('连接已断开')
    const id = old.sent[0].payload.id
    old.receive({type:'rpc_chunk',id,index:0,count:2,data:'{"id":'})
    client.connect('two'); await rejected
    old.receive({type:'rpc_chunk',id,index:1,count:2,data:'"old"}'})
    expect(FakeSocket.sockets[1]!.sent).toEqual([])
  })
  it('restores the page request ID from a multiplexed large response',async () => {
    client.connect('one'); const socket = FakeSocket.sockets[0]!
    const pending = client.request('thread/read',{threadId:'shared'})
    const id = socket.sent[0].payload.id, rpcId = 'r-other-page-namespace'
    const raw = JSON.stringify({id:rpcId,result:{text:'中文🎨'.repeat(20000)}})
    const parts = raw.match(/[\s\S]{1,16000}/g)!
    parts.forEach((data,index) => socket.receive({type:'rpc_chunk',id,rpcId,index,count:parts.length,data}))
    expect((await pending).text).toBe('中文🎨'.repeat(20000))
  })
})
