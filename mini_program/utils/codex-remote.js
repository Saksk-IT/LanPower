const {RpcFragments} = require('./codex-fragments');
const {requestFrames} = require('./codex-request-frames');
const STATES = {
  idle: ['选择开发电脑', '选择电脑后读取项目和最近会话'],
  connecting: ['正在连接', '正在连接你的开发电脑'],
  cloud_offline: ['电脑未连接', '请检查电脑的 Cloud 连接，上线后会自动恢复'],
  host_offline: ['等待电脑登录', '登录 Windows 后后台自动启动，正在等待恢复'],
  disabled: ['电脑尚未授权', '请在电脑的远程连接中启用 Codex Remote'],
  host_ready: ['正在读取 Codex', '正在连接电脑上的 Codex'],
  runtime_starting: ['正在读取 Codex', '正在读取项目和最近会话'],
  runtime_ready: ['Codex 已连接', '项目与会话来自你的电脑'],
  runtime_error: ['Codex 未就绪', '请确认 Codex 已打开并登录，后台会自动重新连接'],
  disconnected: ['连接已断开', '恢复连接后同步进度，已有任务不会重复发送'],
  forbidden: ['需要开发权限', '在 Cloud → 手机授权 → 修改手机权限中开启 Codex Remote'],
  reauthorize: ['手机授权需要更新', '在连接页重新扫描 Cloud 授权码'],
  revoked: ['开发授权已变化', '重新确认手机与电脑的开发权限后再连接'],
  update_required: ['需要更新 Cloud', '请将 Cloud 更新至 1.16.2，以支持多个页面同时连接']
};
const ERRORS = {
  capability_cursor_expired: '能力目录快照已过期或变化，请刷新后继续翻页。',
  invalid_params: '内容或参数不符合限制，未发送，请修改后重试。',
  params_not_allowed: '当前组件不支持这些参数，未发送。',
  method_not_allowed: '当前组件不支持此操作，未发送。',
  history_changed: '原窗口历史已变化，操作未执行，请刷新后重试。',
  history_reference_changed: '这项历史内容已变化，请重新读取。',
  history_cache_busy: '电脑端历史引用正在使用，请稍后重试。',
  library_cursor_changed: '聊天库已更新，请刷新后继续读取。',
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
Object.assign(ERRORS, {
  shared_runtime_required: '请在电脑的 LanPower 连接原 Codex 窗口。',
  result_too_large: '这一页内容较大，正在缩小读取范围。',
  history_reference_expired: '内容引用已更新，请重新读取这一轮。',
  history_item_too_large: '此内容超过电脑端读取上限，请在原窗口查看。',
  submission_mismatch: '提交标识不一致，请查询发送回执。',
  submission_store_unavailable: '电脑端发送回执暂不可用。',
  submission_store_full: '请先确认已有提交的发送结果。',
  unsupported_method: '当前电脑版本暂不支持此功能。',
  image_not_referenced: '此图片不属于当前聊天。', image_too_large: '图片超过 8 MB。',
  unsupported_image: '当前图片格式无法预览。'
});
function failure(message, code, uncertain = false) { const error = new Error(message); error.code = code; error.uncertain = uncertain; return error; }

// A native SocketTask connection. No prompts, responses or approvals are persisted.
class CodexConnection {
  constructor({wxApi, cloud, event, state, timer = setTimeout, clearTimer = clearTimeout}) {
    Object.assign(this, {wx: wxApi, cloud, event, state, timer, clearTimer});
    this.pending = new Map(); this.generation = 0; this.sequence = 0; this.delay = 1000;
    this.fragments = new RpcFragments();
    this.decisions = new Map(); this.nextHistoryRead = 0;
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
      if (frame.code === 'approval_unavailable') for (const id of this.decisions.keys()) this.finishDecision(id, failure(ERRORS[frame.code], frame.code));
      this.event({method: 'lanpower/error', params: {code: frame.code, message: ERRORS[frame.code]}}); return;
    }
    let payload = frame.payload;
    if (frame.type === 'rpc_chunk') {
      if (!this.pending.has(frame.id)) return;
      try { payload = this.fragments.accept(frame); } catch (_) { this.lost(socket, this.generation, 1006); return; }
      if (!payload) return;
    } else if (frame.type !== 'rpc') return;
    if (!payload || typeof payload !== 'object') return;
    if (payload.method) {
      if (payload.method === 'serverRequest/resolved') this.finishDecision(payload.params && payload.params.requestId);
      this.event(payload); return;
    }
    const call = this.pending.get(payload.id);
    if (!call) {
      if (payload.error) {
        this.finishDecision(payload.id, failure(ERRORS[payload.error.message] || '审批未完成，请刷新确认。', payload.error.message));
        this.event({method: 'lanpower/approvalError', params: {id: payload.id}});
      }
      return;
    }
    this.pending.delete(payload.id); this.fragments.drop(payload.id); this.clearTimer(call.timeout); call.cleanup();
    if (payload.error) {
      const code = payload.error.code === -32601 ? 'unsupported_method' : payload.error.message;
      call.reject(failure(ERRORS[code] || (['account/rateLimits/read','skills/list','plugin/list','app/list','mcpServerStatus/list'].includes(call.method) ? '原生接口读取失败：' + String(code).slice(0,1000).replace(/(?:Bearer\s+|sk-)[\w-]+/g,'[已隐藏凭据]') : '本机未能完成请求，请检查会话与授权。'), code,
        !(payload.error.data && payload.error.data.notSent) && ![-32601, -32602].includes(payload.error.code) && !['turn_changed', 'task_running', 'workspace_not_allowed', 'submission_store_full', 'submission_store_unavailable','history_changed'].includes(code)));
    }
    else call.resolve(payload.result || {});
  }
  lost(socket, generation, code) {
    if (this.socket !== socket || generation !== this.generation) return;
    this.socket = null; this.opened = false;
    this.clearTimer(this.openTimeout); this.clearTimer(this.renewal); this.rejectPending();
    try { socket.close({}); } catch (_) {}
    if (code === 4409) { this.state('update_required'); return; }
    if (code === 4400) { this.state('update_required'); return; }
    if (code === 4403) { this.state('revoked'); return; }
    this.state('disconnected'); this.retryLater(generation);
  }
  retryLater(generation) {
    this.clearTimer(this.retry);
    this.retry = this.timer(() => { if (generation === this.generation) this.open(); }, this.delay);
    this.delay = Math.min(30000, this.delay * 2);
  }
  async sendFrame(frame) {
    const socket = this.socket;
    if (!socket || !this.opened) throw failure('连接未就绪，请等待恢复。', 'not_sent');
    const data = JSON.stringify(frame);
    const id = frame.payload && frame.payload.id;
    for (const part of requestFrames(data, id)) {
      if (this.socket !== socket || !this.opened || frame.payload && frame.payload.method && !this.pending.has(id)) throw failure('连接已变化，草稿保留。', 'not_sent');
      await new Promise((resolve, reject) => {
        try { socket.send({data: part, success: resolve,
          fail: () => reject(failure('发送结果待确认，请查询回执。', 'CONNECTION', true))}); }
        catch (_) { reject(failure('连接已断开，请等待恢复。', 'not_sent')); }
      });
    }
  }
  request(method, params = {}, scope) {
    if (scope && scope.cancelled) return Promise.reject(failure('已取消读取。', 'CANCELLED'));
    if (!this.socket || !this.opened) return Promise.reject(failure('连接未就绪，请等待恢复。', 'not_sent'));
    const id = 'm-' + this.generation + '-' + (++this.sequence);
    return new Promise((resolve, reject) => {
      let cleanup = () => {};
      const remove = () => { this.pending.delete(id); this.fragments.drop(id); this.clearTimer(timeout); cleanup(); };
      const timeout = this.timer(() => { remove(); reject(failure('请求超时，请查询回执；任务不会自动重发。', 'TIMEOUT', true)); }, 300000);
      if (scope) cleanup = scope.subscribe(() => { remove(); reject(failure('已取消读取。', 'CANCELLED')); });
      this.pending.set(id, {method, resolve, reject, timeout, cleanup});
      this.sendFrame({type: 'rpc', payload: {id, method, params}}).catch(error => {
        const call = this.pending.get(id); if (!call) return;
        remove(); reject(error);
      });
    });
  }
  async paceHistory(scope) {
    if (scope) scope.check();
    const delay = Math.max(0, this.nextHistoryRead - Date.now()); this.nextHistoryRead = Date.now() + delay + 125;
    if (!delay) return;
    await new Promise((resolve, reject) => {
      let cleanup = () => {};
      const timer = this.timer(() => { cleanup(); resolve(); }, delay);
      if (scope) cleanup = scope.subscribe(() => { this.clearTimer(timer); cleanup(); reject(failure('已取消读取。', 'CANCELLED')); });
    });
  }
  decide(id, result) {
    if (this.decisions.has(id)) return Promise.reject(failure('审批正在确认，请勿重复点击。', 'approval_pending'));
    return new Promise((resolve, reject) => {
      const timeout = this.timer(() => this.finishDecision(id, failure('审批结果待确认，请刷新会话。', 'TIMEOUT', true)), 300000);
      this.decisions.set(id, {resolve, reject, timeout});
      this.sendFrame({type: 'rpc', payload: {id, result}}).catch(error => this.finishDecision(id, error));
    });
  }
  finishDecision(id, error) {
    const call = this.decisions.get(id); if (!call) return;
    this.decisions.delete(id); this.clearTimer(call.timeout); if (error) call.reject(error); else call.resolve();
  }
  reconcileApprovals(ids) { for (const id of this.decisions.keys()) if (!ids.includes(id)) this.finishDecision(id); }
  rejectPending() {
    for (const call of this.pending.values()) {
      this.clearTimer(call.timeout); call.cleanup(); call.reject(failure('连接断开；恢复后请确认会话进度。', 'CONNECTION', true));
    }
    this.pending.clear();
    this.fragments.clear();
    for (const id of this.decisions.keys()) this.finishDecision(id, failure('审批结果待确认，请恢复后查询。', 'CONNECTION', true));
  }
  reconnect() { const device = this.device; this.connect(device); }
  stop() {
    this.generation++; this.clearTimer(this.retry); this.clearTimer(this.renewal); this.clearTimer(this.openTimeout);
    const socket = this.socket; this.socket = null; this.opened = false; this.device = '';
    if (socket) { try { socket.close({}); } catch (_) {} }
    this.rejectPending(); this.nextHistoryRead = 0;
  }
}
module.exports = {CodexConnection, STATES, ERRORS};
