(function () {
  'use strict';
  const STATES = {
    cloud_offline: ['电脑未连接 Relay', '可以先唤醒电脑；电脑上线后会自动连接。'],
    host_offline: ['用户 Host 未运行', '请登录这台 Windows 电脑，并启动或更新 LanPower。'],
    host_ready: ['正在连接 Runtime', '正在启动电脑上的 Codex。'],
    disabled: ['本机尚未授权', '请在电脑的 LanPower 远程连接页面启用 Codex Remote，并选择项目。'],
    runtime_starting: ['Runtime 启动中', '正在读取本机 Codex 环境。'],
    runtime_ready: ['Codex 已连接', '可以创建或恢复会话，任务在这台电脑执行。'],
    runtime_error: ['Runtime 未就绪', '请在电脑确认 Codex 已安装且能够运行，再重新连接。'],
    connecting: ['连接中', '正在安全连接你的电脑。'], disconnected: ['连接已断开', '正在重新连接，已有任务不会重复发送。'],
    controller_busy: ['另一页面正在控制', '请关闭另一控制页面后重新连接。'], idle: ['请选择电脑', '选择电脑后连接 Codex Remote。']
  };
  class RemoteClient {
    constructor({socketFactory, event, state, timer = (fn, delay) => setTimeout(fn, delay), clearTimer = value => clearTimeout(value), id = () => crypto.randomUUID()}) {
      Object.assign(this, {socketFactory, event, state, timer, clearTimer, id});
      this.pending = new Map(); this.device = ''; this.socket = null; this.retry = null; this.delay = 1000; this.generation = 0;
    }
    connect(device) { this.stop(); this.device = device; this.delay = 1000; this.open(); }
    open() {
      const generation = this.generation, socket = this.socketFactory(this.device);
      this.socket = socket; this.state('connecting');
      socket.onopen = () => { if (this.socket === socket) this.delay = 1000; };
      socket.onmessage = ({data}) => {
        if (this.socket !== socket || data.length > 1048576) return;
        let frame; try { frame = JSON.parse(data); } catch { this.state('disconnected'); socket.close(); return; }
        if (frame.type === 'ping') { socket.send('{"type":"pong"}'); return; }
        if (frame.type === 'state') { if (frame.state !== 'runtime_ready') this.rejectPending(); this.state(frame.state); return; }
        if (frame.type === 'error') { this.event({method: 'lanpower/error', params: {code: frame.code}}); return; }
        const payload = frame.payload;
        if (frame.type !== 'rpc' || !payload || typeof payload !== 'object') return;
        if (payload.method) this.event(payload);
        else {
          const call = this.pending.get(payload.id);
          if (!call) { if (payload.error) this.event({method: 'lanpower/approvalError', params: {id: payload.id}}); return; }
          this.pending.delete(payload.id); this.clearTimer(call.timeout);
          if (payload.error) call.reject(new Error('本机未能完成请求，请检查会话和授权。'));
          else call.resolve(payload.result);
        }
      };
      socket.onerror = () => {};
      socket.onclose = ({code}) => {
        if (this.socket !== socket || generation !== this.generation) return;
        this.socket = null; this.rejectPending();
        if ([4400, 4403, 4409].includes(code)) { this.state(code === 4409 ? 'controller_busy' : 'disconnected'); return; }
        this.state('disconnected');
        this.retry = this.timer(() => { if (generation === this.generation) this.open(); }, this.delay);
        this.delay = Math.min(30000, this.delay * 2);
      };
    }
    request(method, params = {}) {
      if (this.socket?.readyState !== 1) return Promise.reject(new Error('连接未就绪。'));
      const id = this.id();
      return new Promise((resolve, reject) => {
        const timeout = this.timer(() => { this.pending.delete(id); reject(new Error('请求超时；请恢复会话确认结果，任务不会自动重发。')); }, 35000);
        this.pending.set(id, {resolve, reject, timeout});
        this.socket.send(JSON.stringify({type: 'rpc', payload: {id, method, params}}));
      });
    }
    decide(id, result) {
      if (this.socket?.readyState !== 1) throw new Error('连接未就绪，请重连后处理审批。');
      this.socket.send(JSON.stringify({type: 'rpc', payload: {id, result}}));
    }
    rejectPending() { for (const call of this.pending.values()) { this.clearTimer(call.timeout); call.reject(new Error('连接断开；请恢复会话确认结果。')); } this.pending.clear(); }
    stop() { this.generation++; if (this.retry) this.clearTimer(this.retry); this.retry = null; const old = this.socket; this.socket = null; if (old) old.close(); this.rejectPending(); this.device = ''; }
  }
  if (typeof module !== 'undefined') module.exports = {RemoteClient, STATES};
  if (typeof document === 'undefined' || !document.getElementById('remote-device')) return;
  const el = name => document.getElementById('remote-' + name);
  const csrf = document.querySelector('meta[name="lp-csrf"]').content;
  let ready = false, threadId = null, activeThread = null, activeTurn = null, sending = false, cursor = null, epoch = 0, aggregateDiff = false;
  const approvals = new Map(), deltas = new Map(), fileChanges = new Map();
  const client = new RemoteClient({
    socketFactory: device => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v2/remote/client/${encodeURIComponent(device)}`, 'lanpower.codex.v1'),
    event: onEvent, state: setState
  });
  function controls() {
    el('new').disabled = !ready || !!activeTurn || sending || !el('workspace').value;
    el('workspace').disabled = !ready || !!activeTurn || sending;
    el('model').disabled = !ready || !!activeTurn || sending;
    el('prompt').disabled = !ready || !threadId || !!activeTurn || sending;
    el('send').disabled = el('prompt').disabled;
    el('interrupt').disabled = !ready || !activeTurn;
    el('task-state').textContent = activeTurn ? '任务正在运行' : threadId ? '会话已就绪' : '尚未选择会话';
  }
  function setState(state) {
    const previous = ready; ready = state === 'runtime_ready';
    const labels = STATES[state] || ['状态更新中', '请稍候。'];
    el('state').textContent = labels[0]; el('hint').textContent = labels[1];
    el('connect').textContent = client.socket ? '断开连接' : '连接';
    el('state').className = 'badge' + (ready ? ' good' : '');
    if (!ready) { if (previous) epoch++; approvals.clear(); el('approvals').replaceChildren(); sending = false; }
    controls();
    if (ready && !previous) initialize().catch(showError);
  }
  function showError(error) { el('hint').textContent = error.message || '请求未完成，请重连后确认。'; }
  function append(text, kind = '') {
    const p = document.createElement('p'); p.textContent = String(text || '').slice(0, 262144); p.className = kind;
    el('transcript').append(p); trim(); return p;
  }
  function trim() {
    const log = el('transcript');
    while ((log.childNodes.length > 150 || log.textContent.length > 262144) && log.childNodes.length > 1) log.firstChild.remove();
    for (const [key, item] of deltas) if (!item.isConnected) deltas.delete(key);
    log.scrollTop = log.scrollHeight;
  }
  function renderDiff(diff) {
    el('diff').replaceChildren();
    const text = String(diff || '暂无修改').slice(0, 262144);
    for (const line of text.split('\n').slice(0, 5000)) {
      const span = document.createElement('span'); span.textContent = line;
      span.className = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-delete' : '';
      el('diff').append(span);
    }
  }
  function itemDiff() {
    return Array.from(fileChanges.values()).flat().map(change => `文件：${change.path || ''}\n${change.diff || ''}`).join('\n').slice(0, 262144);
  }
  async function initialize() {
    const current = epoch;
    const status = await client.request('lanpower/status');
    if (current !== epoch || !ready) return;
    const selected = el('workspace').value;
    el('workspace').replaceChildren();
    for (const path of status.workspaces || []) { const option = document.createElement('option'); option.value = option.textContent = path; el('workspace').append(option); }
    if ((status.workspaces || []).includes(selected)) el('workspace').value = selected;
    activeThread = status.activeThread; activeTurn = status.activeTurn;
    if (!status.loggedIn) el('hint').textContent = '本机 Codex 尚未登录。请在电脑上完成 Codex 登录，Cloud 不代管登录凭据。';
    for (const request of status.pendingApprovals || []) approval(request);
    controls();
    const restore = activeThread || threadId;
    await listThreads(false);
    if (current !== epoch || !ready) return;
    if (restore) await resume(restore);
    if (current !== epoch || !ready) return;
    if (restore === status.activeThread && status.diff) renderDiff(status.diff);
    const models = await client.request('model/list', {limit: 50});
    if (current !== epoch || !ready) return;
    el('model').replaceChildren();
    const def = document.createElement('option'); def.value = ''; def.textContent = '本机默认模型'; el('model').append(def);
    for (const model of models.data || []) { const option = document.createElement('option'); option.value = model.model || model.id; option.textContent = model.displayName || model.model || model.id; el('model').append(option); }
  }
  async function listThreads(more) {
    if (!el('workspace').value) return;
    const current = epoch;
    const params = {limit: 30, cwd: el('workspace').value}; if (more && cursor) params.cursor = cursor;
    const result = await client.request('thread/list', params);
    if (current !== epoch || !ready) return;
    if (!more) el('threads').replaceChildren();
    for (const thread of result.data || []) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary'; button.textContent = thread.name || thread.preview || '未命名会话';
      button.onclick = () => resume(thread.id).catch(showError); item.append(button); el('threads').append(item);
    }
    cursor = result.nextCursor || null; el('more').hidden = !cursor;
  }
  function history(thread) {
    el('transcript').replaceChildren(); deltas.clear(); fileChanges.clear(); aggregateDiff = false;
    for (const turn of (thread.turns || []).slice(-30)) {
      const changes = (turn.items || []).filter(item => item.type === 'fileChange' && item.status === 'completed');
      if (changes.length) fileChanges.clear();
      for (const item of turn.items || []) {
        if (item.type === 'agentMessage') append(item.text || '');
        if (item.type === 'userMessage') append((item.content || []).map(c => c.text || '').join('\n'), 'remote-user');
        if (item.type === 'commandExecution') append(`工具：${item.command || ''}\n${item.aggregatedOutput || ''}`);
        if (item.type === 'fileChange' && item.status === 'completed') fileChanges.set(item.id, item.changes || []);
      }
      if (turn.status === 'inProgress') { activeThread = thread.id; activeTurn = turn.id; }
    }
    if (fileChanges.size) renderDiff(itemDiff());
  }
  async function resume(id) {
    const current = epoch;
    const result = await client.request('thread/resume', {threadId: id});
    if (current !== epoch || !ready) return;
    if (id !== threadId) renderDiff('');
    threadId = result.thread.id; el('title').textContent = result.thread.name || '开发会话';
    history(result.thread); controls();
  }
  function onEvent(message) {
    const p = message.params || {}, method = message.method;
    if (message.id !== undefined) { approval(message); return; }
    if (method === 'lanpower/error') { showError(new Error(p.code === 'approval_unavailable' ? '审批已处理或失效，请重连确认。' : '连接请求被拒绝，请确认本机状态或重新连接。')); return; }
    if (method === 'lanpower/approvalError') {
      const card = approvals.get(JSON.stringify(p.id));
      if (card) { card.querySelector('h3').textContent = '本机拒绝该决定，请重新处理'; card.querySelectorAll('button').forEach(button => button.disabled = false); }
      return;
    }
    if (method === 'serverRequest/resolved') { const card = approvals.get(JSON.stringify(p.requestId)); card?.remove(); approvals.delete(JSON.stringify(p.requestId)); return; }
    if (method === 'turn/started') { activeThread = p.threadId; activeTurn = p.turn?.id; fileChanges.clear(); aggregateDiff = false; controls(); }
    if (method === 'turn/completed') {
      if (p.threadId === activeThread) { activeTurn = null; activeThread = null; sending = false; controls(); }
      const labels = {completed: '任务已完成', failed: '任务执行失败', interrupted: '任务已中断'};
      append(labels[p.turn?.status] || '任务状态已更新');
      approvals.clear(); el('approvals').replaceChildren();
    }
    if (p.threadId && threadId && p.threadId !== threadId) return;
    if (method === 'turn/diff/updated') { aggregateDiff = true; renderDiff(p.diff); }
    if (['item/started', 'item/completed'].includes(method) && p.item?.type === 'fileChange') {
      if (fileChanges.size >= 32) fileChanges.delete(fileChanges.keys().next().value);
      fileChanges.set(p.item.id, p.item.changes || []);
      if (method === 'item/completed' && p.item.status === 'completed' && !aggregateDiff) renderDiff(itemDiff());
    }
    if (method.endsWith('/delta') || method.endsWith('/outputDelta')) {
      const key = `${p.threadId}:${p.itemId}:${method}`;
      let target = deltas.get(key); if (!target) { target = append(''); deltas.set(key, target); }
      target.textContent = (target.textContent + (p.delta || '')).slice(-262144); trim();
    }
    if (method === 'turn/plan/updated') append((p.plan || []).map(step => `${step.status}: ${step.step}`).join('\n'));
    if (method === 'error') append('本机 Runtime 报告错误，请检查电脑上的 Codex 状态。');
  }
  function approval(request) {
    const key = JSON.stringify(request.id); if (approvals.has(key)) return;
    const p = request.params || {}, method = request.method;
    const card = document.createElement('div'); card.className = 'remote-approval';
    const heading = document.createElement('h3');
    heading.textContent = method.includes('fileChange') ? '审核文件修改' : method.includes('permissions') ? '审核权限请求' : method.includes('requestUserInput') ? 'Codex 需要你的回答' : method.includes('elicitation') ? '工具需要本机确认' : '审核命令执行';
    card.append(heading);
    const preview = document.createElement('pre');
    preview.textContent = [p.reason, p.cwd, p.command, p.grantRoot ? `额外目录：${p.grantRoot}` : '', p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext) : '',
      method.includes('fileChange') ? JSON.stringify(fileChanges.get(p.itemId) || {grantRoot: p.grantRoot || '查看上方 Diff'}, null, 2) : '',
      method.includes('permissions') ? JSON.stringify(p.permissions, null, 2) : '', p.message].filter(Boolean).join('\n').slice(0, 65536);
    card.append(preview);
    function button(label, result) {
      const b = document.createElement('button'); b.type = 'button'; b.className = label === '批准一次' || label === '提交回答' || label === '仅允许本次网络访问' ? 'primary' : 'secondary'; b.textContent = label;
      b.onclick = () => { try { client.decide(request.id, typeof result === 'function' ? result() : result); card.querySelectorAll('button').forEach(button => button.disabled = true); heading.textContent = '已提交，等待本机确认'; } catch (error) { showError(error); } };
      card.append(b);
    }
    if (method.includes('requestUserInput')) {
      const fields = [];
      for (const question of p.questions || []) {
        const label = document.createElement('label'); label.textContent = question.question || question.header;
        const input = document.createElement('input'); input.type = question.isSecret ? 'password' : 'text'; input.maxLength = 4000;
        input.placeholder = (question.options || []).map(o => o.label).join(' / '); label.append(input); card.append(label); fields.push([question.id, input]);
      }
      button('提交回答', () => ({answers: Object.fromEntries(fields.map(([id, input]) => [id, {answers: [input.value]}]))}));
    } else if (method.includes('permissions')) {
      if (p.permissions?.network?.enabled && !p.permissions?.fileSystem) button('仅允许本次网络访问', {permissions: {network: {enabled: true}}, scope: 'turn'});
      button('拒绝额外权限', {permissions: {}, scope: 'turn'});
    } else if (method.includes('elicitation')) button('拒绝并在本机处理', {action: 'decline', content: null});
    else { button('拒绝', {decision: 'decline'}); button('批准一次', {decision: 'accept'}); }
    approvals.set(key, card); el('approvals').append(card);
  }
  function reset() {
    epoch++; threadId = activeThread = activeTurn = null; sending = ready = false; cursor = null;
    approvals.clear(); deltas.clear(); fileChanges.clear(); el('approvals').replaceChildren(); el('threads').replaceChildren();
    el('transcript').replaceChildren(); el('workspace').replaceChildren(); renderDiff(''); controls();
  }
  el('connect').onclick = () => {
    if (!el('device').value) return;
    if (client.socket) { client.stop(); setState('idle'); return; }
    reset(); client.connect(el('device').value);
  };
  el('device').onchange = () => { client.stop(); reset(); setState('idle'); el('wake').disabled = true; el('power-state').textContent = '正在检查电脑状态'; updatePower().catch(showError); };
  el('workspace').onchange = () => { threadId = null; controls(); listThreads(false).catch(showError); };
  el('more').onclick = () => listThreads(true).catch(showError);
  el('new').onclick = async () => {
    try { const params = {cwd: el('workspace').value}; if (el('model').value) params.model = el('model').value;
      const current = epoch; const result = await client.request('thread/start', params); if (current !== epoch) return;
      threadId = result.thread.id; el('title').textContent = '新的开发会话'; el('transcript').replaceChildren(); renderDiff(''); controls(); await listThreads(false);
    } catch (error) { showError(error); }
  };
  el('task').onsubmit = async event => {
    event.preventDefault(); const text = el('prompt').value.trim();
    if (!text || !ready || !threadId || activeTurn || sending) return;
    const current = epoch; sending = true; controls();
    try {
      const params = {threadId, input: [{type: 'text', text}]}; if (el('model').value) params.model = el('model').value;
      const result = await client.request('turn/start', params);
      if (current !== epoch) return;
      activeThread = threadId; activeTurn = result.turn?.status === 'inProgress' ? result.turn.id : activeTurn;
      append(text, 'remote-user'); el('prompt').value = ''; renderDiff('');
    } catch (error) { showError(error); }
    finally { if (current === epoch) { sending = false; controls(); } }
  };
  el('interrupt').onclick = async () => {
    if (!activeTurn) return;
    try { await client.request('turn/interrupt', {threadId: activeThread || threadId, turnId: activeTurn}); el('hint').textContent = '中断请求已发送，等待本机确认。'; }
    catch (error) { showError(error); }
  };
  let powerUpdating = false;
  async function updatePower() {
    if (!el('device').value) { el('wake').disabled = true; el('power-state').textContent = '请选择电脑查看 Windows 状态'; return; }
    if (powerUpdating) return;
    const chosen = el('device').value; powerUpdating = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(`/api/v2/devices/${encodeURIComponent(chosen)}`, {cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error('status_unavailable');
      const status = await response.json(); if (el('device').value !== chosen) return;
      el('wake').disabled = !status.wake_available;
      const labels = {online: 'Windows 在线', offline: 'Windows 离线', transitioning: '正在执行电源操作', unknown: '电脑状态未知'};
      el('power-state').textContent = `${labels[status.state] || labels.unknown} · ${status.wake_available ? '可通过网关唤醒' : '远程唤醒暂不可用'}`;
    } catch {
      if (el('device').value === chosen) { el('wake').disabled = true; el('power-state').textContent = '电脑状态未知，请检查 Cloud 连接'; }
    } finally { clearTimeout(timeout); powerUpdating = false; }
  }
  el('wake').onclick = async () => {
    el('wake').disabled = true;
    try {
      const response = await fetch(`/api/v2/devices/${encodeURIComponent(el('device').value)}/commands`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'x-csrf-token': csrf}, body: '{"action":"wake"}', cache: 'no-store'});
      if (!response.ok) throw new Error('唤醒未被接收，请检查网关在线状态。');
      el('hint').textContent = '唤醒请求已发送。电脑上线并登录 Windows 后，点击连接即可继续开发。';
    } catch (error) { showError(error); }
  };
  window.addEventListener('beforeunload', () => client.stop());
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  const computer = new URLSearchParams(location.search).get('computer');
  if (computer && Array.from(el('device').options).some(option => option.value === computer)) el('device').value = computer;
  updatePower().catch(() => {}); setState('idle');
  setInterval(() => { if (document.visibilityState === 'visible') updatePower(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updatePower(); });
})();
