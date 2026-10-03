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
  it('preserves approval identifiers and does not retry a controller rejection', () => {
    const state = vi.fn(); client.onState = state; client.connect('one')
    const socket = FakeSocket.sockets[0]!
    client.decide('lp-approval-native', { decision: 'accept' })
    expect(socket.sent[0]).toEqual({ type: 'rpc', payload: { id: 'lp-approval-native', result: { decision: 'accept' } } })
    socket.onclose?.({ code: 4409 }); vi.advanceTimersByTime(60000)
    expect(state).toHaveBeenLastCalledWith('controller_busy')
    expect(FakeSocket.sockets).toHaveLength(1)
  })
})
