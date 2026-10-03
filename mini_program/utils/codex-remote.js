const {RpcFragments} = require('./codex-fragments');
const STATES = {
  idle: ['选择开发电脑', '选择电脑后读取项目和最近会话'],
  connecting: ['正在连接', '正在连接你的开发电脑'],
  cloud_offline: ['电脑未连接', '请检查电脑的 Cloud 连接，上线后会自动恢复'],
  host_offline: ['等待电脑登录', '请登录 Windows，并打开 LanPower'],
  disabled: ['电脑尚未授权', '请在电脑的远程连接中启用 Codex Remote'],
  host_ready: ['正在读取 Codex', '正在连接电脑上的 Codex'],
  runtime_starting: ['正在读取 Codex', '正在读取项目和最近会话'],
  runtime_ready: ['Codex 已连接', '项目与会话来自你的电脑'],
  runtime_error: ['Codex 未就绪', '请在电脑确认 Codex 已登录且能正常运行'],
  disconnected: ['连接已断开', '恢复连接后同步进度，已有任务不会重复发送'],
  controller_busy: ['另一页面正在控制', '关闭另一控制页面后，点击重新连接'],
  forbidden: ['需要开发权限', '在 Cloud → 手机授权 → 修改手机权限中开启 Codex Remote'],
  reauthorize: ['手机授权需要更新', '在连接页重新扫描 Cloud 授权码'],
  update_required: ['需要更新 Cloud', '请将 Cloud 更新至 1.12.0 后再连接']
};
const ERRORS = {
  desktop_session_busy: '桌面仍占用这条会话，释放后才能继续。',
  workspace_not_allowed: '项目尚未授权，请在电脑检查项目设置。',
  task_running: '任务仍在运行，请先暂停或等待完成。',
  turn_changed: '任务状态已变化，请刷新后再操作。',
  approval_unavailable: '审批已处理或失效，请刷新确认。',
  too_many_sessions: '已打开较多会话，请交还不使用的会话。',
  background_running: '会话仍有后台命令在运行，暂时无法交还。',
  session_release_unavailable: '无法确认会话能安全释放，请刷新重试。',
  agent_offline: '电脑连接已断开，请等待恢复。',
  remote_revoked: '开发授权已关闭，请检查手机与电脑授权。'
};
function failure(message, code) { const error = new Error(message); error.code = code; return error; }

// A native SocketTask connection. No prompts, responses or approvals are persisted.
class CodexConnection {
  constructor({wxApi, cloud, event, state, timer = setTimeout, clearTimer = clearTimeout}) {
    Object.assign(this, {wx: wxApi, cloud, event, state, timer, clearTimer});
    this.pending = new Map(); this.generation = 0; this.sequence = 0; this.delay = 1000;
    this.fragments = new RpcFragments();
    this.socket = null; this.device = ''; this.opened = false;
  }
  connect(device) { this.stop(); this.device = device; this.open(); }
  async open() {
    const generation = this.generation;
    if (!this.device) return;
    this.state('connecting');
    try {
      await this.cloud.call('/api/v2/remote/status/' + encodeURIComponent(this.device));
      if (generation !== this.generation || !this.device) return;
      const socket = this.wx.connectSocket({
        url: this.cloud.session.url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/api/v2/remote/mobile/' + encodeURIComponent(this.device),
        header: {Authorization: 'Bearer ' + this.cloud.session.access_token},
        protocols: ['lanpower.codex.v1'], timeout: 10000,
        success: () => {}, fail: () => this.lost(socket, generation, 1006)
      });
      this.socket = socket;
      this.openTimeout = this.timer(() => this.lost(socket, generation, 1006), 12000);
      socket.onOpen(() => {
        if (this.socket !== socket) { socket.close({}); return; }
        this.clearTimer(this.openTimeout); this.opened = true; this.delay = 1000;
        const remaining = Math.max(1000, this.cloud.session.access_expires_at * 1000 - Date.now() - 60000);
        this.renewal = this.timer(() => {
          if (this.socket !== socket) return;
          // Reconnect before token expiry; only state is restored, never a command.
          this.reconnect();
        }, remaining);
      });
      socket.onMessage(({data}) => this.message(socket, data));
      socket.onClose(({code}) => this.lost(socket, generation, code));
      socket.onError(() => this.lost(socket, generation, 1006));
    } catch (error) {
      if (generation !== this.generation) return;
      const terminal = {FORBIDDEN: 'forbidden', REAUTHORIZE: 'reauthorize', UPDATE_REQUIRED: 'update_required'}[error.code];
      this.state(terminal || 'disconnected');
      if (!terminal) this.retryLater(generation);
    }
  }
  message(socket, data) {
    if (this.socket !== socket || typeof data !== 'string' || data.length > 1048576) return;
    let frame;
    try { frame = JSON.parse(data); } catch (_) { this.lost(socket, this.generation, 1006); return; }
    if (frame.type === 'ping') { this.sendFrame({type: 'pong'}).catch(() => {}); return; }
    if (frame.type === 'state') {
      if (frame.state !== 'runtime_ready') this.rejectPending();
      this.state(frame.state); return;
    }
    if (frame.type === 'error') {
      this.event({method: 'lanpower/error', params: {code: frame.code}}); return;
    }
    let payload = frame.payload;
    if (frame.type === 'rpc_chunk') {
      if (!this.pending.has(frame.id)) return;
      try { payload = this.fragments.accept(frame); } catch (_) { this.lost(socket, this.generation, 1006); return; }
      if (!payload) return;
    } else if (frame.type !== 'rpc') return;
    if (!payload || typeof payload !== 'object') return;
    if (payload.method) { this.event(payload); return; }
    const call = this.pending.get(payload.id);
    if (!call) {
      if (payload.error) this.event({method: 'lanpower/approvalError', params: {id: payload.id}});
      return;
    }
    this.pending.delete(payload.id); this.fragments.drop(payload.id); this.clearTimer(call.timeout);
    if (payload.error) call.reject(failure(ERRORS[payload.error.message] || '本机未能完成请求，请检查会话与授权。', 'REJECTED'));
    else call.resolve(payload.result || {});
  }
  lost(socket, generation, code) {
    if (this.socket !== socket || generation !== this.generation) return;
    this.socket = null; this.opened = false;
    this.clearTimer(this.openTimeout); this.clearTimer(this.renewal); this.rejectPending();
    try { socket.close({}); } catch (_) {}
    if (code === 4409) { this.state('controller_busy'); return; }
    if (code === 4400) { this.state('update_required'); return; }
    this.state('disconnected'); this.retryLater(generation);
  }
  retryLater(generation) {
    this.clearTimer(this.retry);
    this.retry = this.timer(() => { if (generation === this.generation) this.open(); }, this.delay);
    this.delay = Math.min(30000, this.delay * 2);
  }
  async sendFrame(frame) {
    const socket = this.socket;
    if (!socket || !this.opened) throw failure('连接未就绪，请等待恢复。', 'CONNECTION');
    return new Promise((resolve, reject) => socket.send({data: JSON.stringify(frame), success: resolve,
      fail: () => reject(failure('连接断开；请刷新会话确认结果，任务不会自动重发。', 'CONNECTION'))}));
  }
  request(method, params = {}) {
    if (this.pending.size >= 64) return Promise.reject(failure('正在处理较多请求，请稍候。', 'BUSY'));
    const id = 'm-' + this.generation + '-' + (++this.sequence);
    return new Promise((resolve, reject) => {
      const timeout = this.timer(() => {
        this.pending.delete(id); this.fragments.drop(id); reject(failure('请求超时；请刷新会话确认结果，任务不会自动重发。', 'TIMEOUT'));
      }, 35000);
      this.pending.set(id, {resolve, reject, timeout});
      this.sendFrame({type: 'rpc', payload: {id, method, params}}).catch(error => {
        const call = this.pending.get(id); if (!call) return;
        this.pending.delete(id); this.clearTimer(timeout); reject(error);
      });
    });
  }
  decide(id, result) { return this.sendFrame({type: 'rpc', payload: {id, result}}); }
  rejectPending() {
    for (const call of this.pending.values()) {
      this.clearTimer(call.timeout); call.reject(failure('连接断开；恢复后请确认会话进度。', 'CONNECTION'));
    }
    this.pending.clear();
    this.fragments.clear();
  }
  reconnect() { const device = this.device; this.connect(device); }
  stop() {
    this.generation++; this.clearTimer(this.retry); this.clearTimer(this.renewal); this.clearTimer(this.openTimeout);
    const socket = this.socket; this.socket = null; this.opened = false; this.device = '';
    if (socket) { try { socket.close({}); } catch (_) {} }
    this.rejectPending();
  }
}
module.exports = {CodexConnection, STATES, ERRORS};
