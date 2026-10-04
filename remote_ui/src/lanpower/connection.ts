import { RpcFragments } from './fragments'
export type RpcEvent = { id?: string | number; method: string; params?: any }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup?: () => void }

export class RemoteError extends Error {
  constructor(public code: string, message: string, public uncertain = false) { super(message) }
}

const errors: Record<string, string> = {
  desktop_session_busy: '这条会话由原窗口控制，请在电脑的 LanPower 点击「连接原 Codex 窗口」。',
  shared_runtime_required: '请先在电脑的 LanPower 连接原 Codex 窗口。',
  desktop_request_failed: '原窗口未能完成请求，请刷新会话确认状态。',
  workspace_not_allowed: '项目尚未授权，请在电脑的 LanPower 检查项目目录。',
  turn_changed: '任务状态已经变化，请刷新后重试。',
  approval_unavailable: '审批已处理或失效，请刷新会话。',
  result_too_large: '这一页内容超过传输上限，正在尝试缩小读取范围。',
  task_running: '原窗口已有正在运行的任务，请刷新后选择引导或排队。',
  submission_mismatch: '提交标识与原请求不一致，请查询发送回执。',
  submission_store_unavailable: '电脑端发送回执暂不可用，请检查本机状态。',
  submission_store_full: '电脑端有过多待确认提交，请先确认发送结果。',
  history_reference_expired: '内容引用已过期，正在重新读取对应历史。',
  history_item_too_large: '此内容超过电脑端临时缓存上限，请在原窗口取回。',
  controller_busy: '请将 Cloud 更新至 1.16.2，以支持多个页面同时连接。',
  remote_revoked: '开发权限已变化，请重新确认授权。',
  image_not_referenced: '此图片不属于当前聊天。', image_too_large: '图片超过 8 MB，请在电脑查看原图。', unsupported_image: '当前图片格式无法预览。',
}

// Credentials stay in the existing HttpOnly session cookie. Task bodies stay in memory.
export class RemoteConnection {
  private socket: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private decisions = new Map<string | number, Pending>()
  private fragments = new RpcFragments()
  private retry: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private delay = 1000
  private device = ''
  private nextHistoryRead = 0
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
      if (frame.type === 'error') {
        if (frame.code === 'approval_unavailable') this.rejectDecisions(new RemoteError(frame.code, errors[frame.code]))
        this.onEvent({ method: 'lanpower/error', params: { code: frame.code, message: errors[frame.code] } }); return
      }
      let payload = frame.payload
      if (frame.type === 'rpc_chunk') {
        if (!this.pending.has(frame.id)) return
        try { payload = this.fragments.accept(frame) } catch { socket.close(); this.rejectPending(); return }
        if (!payload) return
      } else if (frame.type !== 'rpc') return
      if (!payload || typeof payload !== 'object') return
      if (typeof payload.method === 'string') {
        if (payload.method === 'serverRequest/resolved') this.finishDecision(payload.params?.requestId)
        this.onEvent(payload); return
      }
      const call = this.pending.get(payload.id)
      if (!call) {
        if (payload.error) {
          this.finishDecision(payload.id, new RemoteError(payload.error.message, errors[payload.error.message] || '审批未完成，请刷新确认。'))
          this.onEvent({ method: 'lanpower/approvalError', params: { id: payload.id, code: payload.error.message } })
        }
        return
      }
      this.pending.delete(payload.id); this.fragments.drop(payload.id); clearTimeout(call.timer); call.cleanup?.()
      if (payload.error) call.reject(new RemoteError(payload.error.code === -32601 ? 'unsupported_method' : payload.error.message, payload.error.code === -32601 ? '当前 Codex 版本暂不支持此功能。' : errors[payload.error.message] || '本机未能完成请求，请检查会话和授权。', ![-32601,-32602].includes(payload.error.code) && !['turn_changed','task_running','workspace_not_allowed','submission_store_full','submission_store_unavailable'].includes(payload.error.message)))
      else call.resolve(payload.result)
    }
    socket.onerror = () => {}
    socket.onclose = ({ code }) => {
      if (this.socket !== socket || generation !== this.generation) return
      this.socket = null; this.rejectPending()
      this.onState(code === 4409 ? 'update_required' : code === 4403 ? 'revoked' : 'disconnected')
      if ([4400, 4403, 4409].includes(code)) return
      this.retry = setTimeout(() => { if (generation === this.generation) this.open() }, this.delay)
      this.delay = Math.min(30000, this.delay * 2)
    }
  }
  request<T = any>(method: string, params: any = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('已取消读取。', 'AbortError'))
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new RemoteError('not_sent', '连接尚未就绪。'))
    const id = crypto.randomUUID()
    const data = JSON.stringify({ type: 'rpc', payload: { id, method, params } })
    if (new TextEncoder().encode(data).byteLength > 1048576) return Promise.reject(new RemoteError('not_sent', '消息或图片过大，请缩小后重试。'))
    return new Promise((resolve, reject) => {
      const remove = () => { this.pending.delete(id); this.fragments.drop(id); clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      const abort = () => { remove(); reject(new DOMException('已取消读取。', 'AbortError')) }
      const timer = setTimeout(() => { remove(); reject(new RemoteError('timeout', '请求超时，请查询发送回执；任务不会自动重发。', true)) }, 35000)
      this.pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) })
      signal?.addEventListener('abort', abort, {once:true})
      try { this.socket!.send(data) } catch { remove(); reject(new RemoteError('not_sent', '连接已断开，请重新连接。')) }
    })
  }
  async paceHistory(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('已取消读取。','AbortError')
    const delay = Math.max(0,this.nextHistoryRead - Date.now()); this.nextHistoryRead = Date.now() + delay + 125
    if (!delay) return
    await new Promise<void>((resolve,reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); reject(new DOMException('已取消读取。','AbortError')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve() },delay)
      signal?.addEventListener('abort',abort,{once:true})
    })
  }
  decide(id: string | number, result: unknown): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new RemoteError('not_sent', '连接尚未就绪，请重连后处理审批。'))
    if (this.decisions.has(id)) return Promise.reject(new RemoteError('approval_pending', '此审批正在确认，请勿重复点击。'))
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => this.finishDecision(id,new RemoteError('timeout','审批结果待确认，请刷新读取原窗口状态。',true)),35000)
      this.decisions.set(id,{resolve,reject,timer})
      try { this.socket!.send(JSON.stringify({ type:'rpc',payload:{id,result} })) }
      catch { this.finishDecision(id,new RemoteError('not_sent','连接已断开，请重新连接。')) }
    })
  }
  reconcileApprovals(ids: Array<string | number>): void {
    for (const id of this.decisions.keys()) if (!ids.includes(id)) this.finishDecision(id)
  }
  private finishDecision(id: string | number, error?: Error): void {
    const pending = this.decisions.get(id); if (!pending) return
    this.decisions.delete(id); clearTimeout(pending.timer)
    if (error) pending.reject(error); else pending.resolve(undefined)
  }
  private rejectDecisions(error: Error): void {
    for (const id of this.decisions.keys()) this.finishDecision(id,error)
  }
  private rejectPending(): void {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.cleanup?.(); call.reject(new RemoteError('disconnected','连接已断开，请恢复会话确认结果。',true)) }
    this.pending.clear()
    this.rejectDecisions(new RemoteError('disconnected','连接已断开，审批结果待确认。',true))
    this.fragments.clear()
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
