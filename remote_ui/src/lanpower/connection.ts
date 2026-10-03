export type RpcEvent = { id?: string | number; method: string; params?: any }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

const errors: Record<string, string> = {
  desktop_session_busy: '这条会话由原窗口控制，请在电脑的 LanPower 点击「连接原 Codex 窗口」。',
  shared_runtime_required: '请先在电脑的 LanPower 连接原 Codex 窗口。',
  desktop_request_failed: '原窗口未能完成请求，请刷新会话确认状态。',
  workspace_not_allowed: '项目尚未授权，请在电脑的 LanPower 检查项目目录。',
  turn_changed: '任务状态已经变化，请刷新后重试。',
  approval_unavailable: '审批已处理或失效，请刷新会话。',
}

// Credentials stay in the existing HttpOnly session cookie. Task bodies stay in memory.
export class RemoteConnection {
  private socket: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private retry: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private delay = 1000
  private device = ''
  onEvent: (event: RpcEvent) => void = () => {}
  onState: (state: string) => void = () => {}

  connect(device: string): void { this.stop(); this.device = device; if (device) this.open() }
  private open(): void {
    const generation = this.generation
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v2/remote/client/${encodeURIComponent(this.device)}`, 'lanpower.codex.v1')
    this.socket = socket
    this.onState('connecting')
    socket.onopen = () => { if (this.socket === socket) this.delay = 1000 }
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket || typeof data !== 'string' || data.length > 1048576) return
      let frame: any
      try { frame = JSON.parse(data) } catch { socket.close(); return }
      if (frame.type === 'ping') { socket.send('{"type":"pong"}'); return }
      if (frame.type === 'state') {
        if (frame.state !== 'runtime_ready') this.rejectPending()
        this.onState(frame.state)
        return
      }
      if (frame.type === 'error') { this.onEvent({ method: 'lanpower/error', params: { code: frame.code } }); return }
      const payload = frame.payload
      if (frame.type !== 'rpc' || !payload || typeof payload !== 'object') return
      if (typeof payload.method === 'string') { this.onEvent(payload); return }
      const call = this.pending.get(payload.id)
      if (!call) {
        if (payload.error) this.onEvent({ method: 'lanpower/approvalError', params: { id: payload.id } })
        return
      }
      this.pending.delete(payload.id); clearTimeout(call.timer)
      if (payload.error) call.reject(new Error(errors[payload.error.message] || '本机未能完成请求，请检查会话和授权。'))
      else call.resolve(payload.result)
    }
    socket.onerror = () => {}
    socket.onclose = ({ code }) => {
      if (this.socket !== socket || generation !== this.generation) return
      this.socket = null; this.rejectPending()
      this.onState(code === 4409 ? 'controller_busy' : 'disconnected')
      if ([4400, 4403, 4409].includes(code)) return
      this.retry = setTimeout(() => { if (generation === this.generation) this.open() }, this.delay)
      this.delay = Math.min(30000, this.delay * 2)
    }
  }
  request<T = any>(method: string, params: any = {}): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('连接尚未就绪。'))
    const id = crypto.randomUUID()
    const data = JSON.stringify({ type: 'rpc', payload: { id, method, params } })
    if (new TextEncoder().encode(data).byteLength > 1048576) return Promise.reject(new Error('消息或图片过大，请缩小后重试。'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('请求超时，请刷新会话确认结果；任务不会自动重发。')) }, 35000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket!.send(data) } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('连接已断开，请重新连接。')) }
    })
  }
  decide(id: string | number, result: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('连接尚未就绪，请重连后处理审批。')
    this.socket.send(JSON.stringify({ type: 'rpc', payload: { id, result } }))
  }
  private rejectPending(): void {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('连接已断开，请恢复会话确认结果。')) }
    this.pending.clear()
  }
  stop(): void {
    this.generation++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const old = this.socket; this.socket = null; old?.close()
    this.rejectPending(); this.device = ''
  }
}

export const connection = new RemoteConnection()
