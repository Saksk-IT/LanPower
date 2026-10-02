(function () {
  'use strict';
  const STATES = {
    cloud_offline: ['电脑未连接', '请检查电脑的 Cloud 连接；上线后会自动重连。'],
    host_offline: ['等待电脑登录', '请登录这台 Windows 电脑，并打开 LanPower。'],
    host_ready: ['正在读取 Codex', '正在连接电脑上的 Codex。'],
    disabled: ['本机尚未授权', '请在电脑的「远程连接」启用 Codex Remote 并保存授权。'],
    runtime_starting: ['正在读取 Codex', '正在识别本机项目和最近会话。'],
    runtime_ready: ['Codex 已连接', '项目和会话已从这台电脑读取。'],
    runtime_error: ['Codex 未就绪', '请在电脑确认 Codex 能正常运行，再重新连接。'],
    connecting: ['连接中', '正在连接你选择的电脑。'],
    disconnected: ['连接已断开', '正在重新连接，已有任务不会重复发送。'],
    controller_busy: ['另一页面正在控制', '关闭另一控制页面后，点击重新连接。'],
    idle: ['请选择电脑', '选择电脑后自动读取项目和最近会话。']
  };
  const ERRORS = {
    desktop_session_busy: '这条会话仍由桌面 Codex 占用。可以同步查看，桌面释放后再继续。',
    task_running: '电脑上已有远程任务正在运行，请先等待完成或暂停。',
    workspace_not_allowed: '项目不可用或尚未授权，请在电脑检查项目目录。',
    turn_changed: '任务状态已变化，请刷新会话后再操作。',
    approval_unavailable: '审批已处理或失效，请刷新会话确认。'
  };
  class RemoteClient {
    constructor({socketFactory, event, state, timer = (fn, delay) => globalThis.setTimeout(fn, delay),
      clearTimer = value => globalThis.clearTimeout(value), id = () => globalThis.crypto.randomUUID()}) {
      Object.assign(this, {socketFactory, event, state, timer, clearTimer, id});
      this.pending = new Map(); this.device = ''; this.socket = null; this.retry = null; this.delay = 1000; this.generation = 0;
    }
    connect(device) { this.stop(); this.device = device; this.delay = 1000; this.open(); }
    open() {
      const generation = this.generation, socket = this.socketFactory(this.device);
      this.socket = socket; this.state('connecting');
      socket.onopen = () => { if (this.socket === socket) this.delay = 1000; };
      socket.onmessage = ({data}) => {
        if (this.socket !== socket || typeof data !== 'string' || data.length > 1048576) return;
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
          if (payload.error) call.reject(new Error(ERRORS[payload.error.message] || '本机未能完成请求，请检查会话和授权。'));
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
      // Keep browser-native methods inside wrappers so they always retain their receiver.
      const id = this.id();
      return new Promise((resolve, reject) => {
        const timeout = this.timer(() => { this.pending.delete(id); reject(new Error('请求超时；请恢复会话确认结果，任务不会自动重发。')); }, 35000);
        this.pending.set(id, {resolve, reject, timeout});
        try { this.socket.send(JSON.stringify({type: 'rpc', payload: {id, method, params}})); }
        catch { this.pending.delete(id); this.clearTimer(timeout); reject(new Error('连接断开，请重新连接。')); }
      });
    }
    decide(id, result) {
      if (this.socket?.readyState !== 1) throw new Error('连接未就绪，请重连后处理审批。');
      this.socket.send(JSON.stringify({type: 'rpc', payload: {id, result}}));
    }
    rejectPending() { for (const call of this.pending.values()) { this.clearTimer(call.timeout); call.reject(new Error('连接断开；请恢复会话确认结果。')); } this.pending.clear(); }
    stop() { this.generation++; if (this.retry) this.clearTimer(this.retry); this.retry = null; const old = this.socket; this.socket = null; if (old) old.close(); this.rejectPending(); this.device = ''; }
  }
  function projectName(path) { return String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || '本机项目'; }
  function taskLabel(thread, activeThread, activeTurn) {
    if (thread.id === activeThread && activeTurn) return '运行中';
    if (thread.live?.state === 'running') return '运行中';
    if (thread.control === 'desktop') return thread.live?.state === 'idle' ? '桌面已连接' : '桌面状态待确认';
    const status = thread.status?.type;
    return status === 'active' ? '运行中' : status === 'systemError' ? '需要处理' : '可继续';
  }
  if (typeof module !== 'undefined') module.exports = {RemoteClient, STATES, taskLabel, projectName};
  if (typeof document === 'undefined' || !document.getElementById('remote-device')) return;
  const el = name => document.getElementById('remote-' + name);
  const csrf = document.querySelector('meta[name="lp-csrf"]').content;
  let ready = false, currentState = 'idle', threadId = null, selectedThread = null, activeThread = null, activeTurn = null, sending = false;
  let cursor = null, epoch = 0, selection = 0, turnRevision = 0, aggregateDiff = false, catalog = [], sessions = [], startedAt = 0, listing = false, refreshing = false;
  const approvals = new Map(), deltas = new Map(), fileChanges = new Map(), messageItems = new Map(), turnGroups = new Map();
  let renderTurn = null, synchronizedAt = 0, lastCompletion = null, catalogPolledAt = 0;
  const rawMessages = new WeakMap();
  const client = new RemoteClient({
    socketFactory: device => new WebSocket(
      (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/api/v2/remote/client/' + encodeURIComponent(device),
      'lanpower.codex.v1'),
    event: onEvent, state: setState
  });
  function remember(value) { try { sessionStorage.setItem('lanpower-remote-' + el('device').value, value); } catch {} }
  function remembered() { try { return sessionStorage.getItem('lanpower-remote-' + el('device').value); } catch { return null; } }
  function feedback(text, error = false) {
    el('feedback').textContent = text; el('feedback').hidden = !text; el('feedback').classList.toggle('error', error);
  }
  function showError(error) {
    const text = error.message || '请求未完成，请重连后确认。'; el('hint').textContent = text; feedback(text, true);
  }
  function paintMessage(target, text) {
    rawMessages.set(target, text);
    if (target.tagName === 'PRE' || target.classList.contains('remote-user') || target.classList.contains('remote-notice')) { target.textContent = text; return; }
    // Render a small Markdown subset using DOM nodes only. Raw HTML is always plain text.
    function inline(parent, value) {
      const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
      let start = 0;
      for (const match of value.matchAll(pattern)) {
        parent.append(document.createTextNode(value.slice(start, match.index)));
        const node = document.createElement(match[1] ? 'strong' : match[2] ? 'code' : 'a');
        node.textContent = match[1] || match[2] || match[3];
        if (match[4]) {
          let url; try { url = new URL(match[4], location.origin); } catch {}
          if (!url || !['http:', 'https:'].includes(url.protocol)) node.textContent = match[0];
          else { node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
        }
        parent.append(node); start = match.index + match[0].length;
      }
      parent.append(document.createTextNode(value.slice(start)));
    }
    const fragment = document.createDocumentFragment(), lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.startsWith('```')) {
        const code = []; while (++index < lines.length && !lines[index].startsWith('```')) code.push(lines[index]);
        const pre = document.createElement('pre'), child = document.createElement('code'); child.textContent = code.join('\n'); pre.append(child); fragment.append(pre); continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/), bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (bullet) {
        const ordered = /^\s*\d+\./.test(line), tag = ordered ? 'OL' : 'UL';
        let list = fragment.lastChild;
        if (list?.tagName !== tag) { list = document.createElement(tag.toLowerCase()); fragment.append(list); }
        const li = document.createElement('li'); inline(li,bullet[1]); list.append(li); continue;
      }
      if (!line.trim()) continue;
      const quote = line.match(/^>\s?(.*)$/), paragraph = document.createElement(heading ? 'h' + (heading[1].length + 2) : quote ? 'blockquote' : 'p');
      inline(paragraph, heading ? heading[2] : quote ? quote[1] : line); fragment.append(paragraph);
    }
    target.replaceChildren(fragment);
  }
  function viewThread(show) {
    el('shell').dataset.view = show ? 'thread' : 'library';
    document.body.classList.toggle('remote-in-thread', show);
  }
  function observedActive() { return selectedThread?.live?.state === 'running'; }
  function svg(name, size = 22) {
    if (name === 'compose') return el('compose').querySelector('svg').cloneNode(true);
    const node = document.createElementNS('http://www.w3.org/2000/svg','svg');
    for (const [key,value] of Object.entries({width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'icon'})) node.setAttribute(key,value);
    const paths = {folder:'M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v2M3 7h18l-3 13H3Z',computer:'M3 4h18v13H3ZM8 21h8m-4-4v4',copy:'M8 8h12v13H8ZM16 8V3H3v13h5'};
    const path = document.createElementNS(node.namespaceURI,'path'); path.setAttribute('d',paths[name] || paths.copy); node.append(path); return node;
  }
  function elapsedLabel(seconds) { seconds = Math.max(0,Math.floor(seconds)); return (seconds >= 60 ? Math.floor(seconds/60) + ' 分 ' : '') + seconds%60 + ' 秒'; }
  function activityTitle(text) {
    const labels = {'functions.exec':'本机工具','exec_command':'本机命令','functions.exec_command':'本机命令','functions.apply_patch':'文件修改','apply_patch':'文件修改','web.run':'网页检索','functions.web__run':'网页检索','functions.wait':'等待操作结果'};
    return String(text || '').replace(/ · ([A-Za-z0-9_.-]+)$/,(_,name)=>' · ' + (labels[name] || '本机工具'));
  }
  function group(id = renderTurn || (selectedActive() ? activeTurn : 'conversation')) {
    if (turnGroups.has(id)) return turnGroups.get(id);
    const root = document.createElement('section'); root.className = 'remote-turn'; root.dataset.turn = id;
    const users = document.createElement('div'), activity = document.createElement('details'), summary = document.createElement('summary'), tools = document.createElement('div'), replies = document.createElement('div');
    activity.className = 'remote-turn-activity'; activity.hidden = true; tools.className = 'remote-turn-tools'; summary.textContent = '执行过程'; activity.append(summary,tools); root.append(users,activity,replies);
    el('transcript').querySelector('.remote-empty')?.remove(); el('transcript').append(root);
    const result = {root,users,activity,summary,tools,replies}; turnGroups.set(id,result); return result;
  }
  function computerTabs() {
    const tabs = el('computer-tabs'); tabs.replaceChildren();
    const all = document.createElement('button'); all.type = 'button'; all.textContent = '全部'; all.title = '当前电脑的全部项目'; all.setAttribute('aria-pressed',String(!el('workspace').value));
    all.onclick = () => { el('workspace').value = ''; el('search').value = ''; renderLibrary(); computerTabs(); }; tabs.append(all);
    for (const option of Array.from(el('device').options).filter(o => o.value)) {
      const button = document.createElement('button'), dot = document.createElement('span'); button.type = 'button'; dot.className = 'remote-computer-dot' + (option.selected && ready ? ' online' : '');
      button.dataset.computer = option.value; button.setAttribute('aria-pressed',String(option.selected)); button.append(dot,svg('computer',18),document.createTextNode(option.textContent));
      button.onclick = () => { if (el('device').value !== option.value) { el('device').value = option.value; chooseComputer(); } }; tabs.append(button);
    }
  }
  function selectedActive() { return !!activeTurn && activeThread === threadId; }
  function controls() {
    const desktop = selectedThread?.control === 'desktop', active = selectedActive(), observed = observedActive();
    el('new').disabled = !ready || sending || !catalog.length;
    el('workspace').disabled = !ready;
    el('model').disabled = !ready || !!activeTurn || desktop || sending;
    el('prompt').disabled = !ready || !threadId || desktop || sending || !!activeTurn && !active;
    el('send').disabled = el('prompt').disabled || !el('prompt').value.trim();
    el('send').querySelector('span').textContent = active ? '引导' : '发送';
    el('send').setAttribute('aria-label', active ? '引导当前任务' : '发送消息');
    el('send').hidden = (active || observed) && !el('prompt').value.trim();
    el('interrupt').hidden = !(active || observed) || !!el('prompt').value.trim();
    el('prompt').placeholder = desktop ? '桌面会话 · 当前仅支持查看' : active ? '跟进' : '向 Codex 提问';
    el('interrupt').disabled = !ready || !active || sending || desktop;
    el('compose').disabled = !ready || sending || !catalog.length;
    el('task-state').textContent = !ready ? (STATES[currentState]?.[0] || '连接已断开') : !threadId ? '尚未选择会话' : desktop ? (observed ? '桌面正在运行 · 同步查看' : selectedThread.live?.state === 'idle' ? '桌面已连接 · 本轮已结束' : '桌面已连接 · 状态待确认') : active ? '正在运行' : sending ? '正在发送' : '可以继续';
    el('task-state').className = active || observed ? 'running' : '';
    el('control-hint').textContent = !ready ? (STATES[currentState]?.[1] || '正在重新连接电脑。') : desktop
      ? '每 2 秒同步桌面已保存的进度；当前连接无法向桌面任务发送引导或暂停。'
      : active ? '输入消息可引导当前任务，点击方块可暂停。' : '';
    el('progress').hidden = !(active || observed);
    if (observed && !active) { el('progress-label').textContent = '正在运行'; el('live-action').textContent = activityTitle(selectedThread.live?.action) || '等待桌面保存下一条进度'; }
    else if (!active) el('live-action').textContent = '';
    if (observed && selectedThread.live?.startedAt) startedAt = selectedThread.live.startedAt * 1000;
    el('sync-state').textContent = synchronizedAt && ready ? '已同步 ' + new Date(synchronizedAt).toLocaleTimeString('zh-CN',{hour12:false}) : '';
  }
  function setState(state) {
    currentState = state;
    const previous = ready; ready = state === 'runtime_ready';
    const labels = STATES[state] || ['状态更新中', '请稍候。'];
    el('state').textContent = labels[0]; el('hint').textContent = labels[1];
    el('library-state').textContent = ready ? '' : labels[1]; computerTabs();
    el('connect').textContent = client.socket ? '断开连接' : '重新连接';
    el('state').className = 'badge' + (ready ? ' good' : '');
    if (!ready) {
      if (previous) epoch++;
      approvals.clear(); el('approvals').replaceChildren(); sending = false;
    }
    controls();
    if (ready && !previous) initialize().catch(showError);
  }
  function append(text, kind = '', id = null, phase = null) {
    el('transcript').querySelector('.remote-empty')?.remove();
    const p = document.createElement('div'); p.className = 'remote-message ' + kind; paintMessage(p, String(text || '').slice(-262144));
    const turn = group(); (kind === 'remote-user' ? turn.users : phase === 'commentary' ? turn.tools : turn.replies).append(p);
    if (phase === 'commentary') turn.activity.hidden = false;
    if (id) messageItems.set(id, p); trim(); return p;
  }
  function trim(scroll = false) {
    const log = el('transcript'), scrollBox = el('chat-scroll'), atEnd = scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 100;
    while ((log.childNodes.length > 180 || log.textContent.length > 262144) && log.childNodes.length > 1) log.firstChild.remove();
    for (const [key, item] of deltas) if (!item.isConnected) deltas.delete(key);
    for (const [key, item] of messageItems) if (!item.isConnected) messageItems.delete(key);
    for (const [key, item] of turnGroups) if (!item.root.isConnected) turnGroups.delete(key);
    if (scroll || atEnd) scrollBox.scrollTop = scrollBox.scrollHeight;
    el('jump').hidden = scroll || atEnd;
  }
  function tool(item) {
    let target = messageItems.get(item.id);
    if (!target) {
      target = document.createElement('details'); target.className = 'remote-message remote-tool';
      target.append(document.createElement('summary'), document.createElement('pre'));
      const turn = group(); turn.activity.hidden = false; turn.tools.append(target); messageItems.set(item.id, target);
    }
    target.querySelector('summary').textContent = item.type === 'toolActivity' ? (item.status === 'inProgress' ? '正在' : '已') + activityTitle(item.text) : (item.status === 'inProgress' ? '正在执行 · ' : '工具 · ') + String(item.command || '本机操作').slice(0, 100);
    target.querySelector('pre').textContent = String(item.aggregatedOutput || '').slice(-32000); trim();
    return target.querySelector('pre');
  }
  function renderItem(item) {
    if (['commandExecution','toolActivity'].includes(item.type)) { tool(item); return; }
    if (item.type === 'fileChange') {
      if (fileChanges.size >= 32) fileChanges.delete(fileChanges.keys().next().value);
      fileChanges.set(item.id, item.changes || []); if (!aggregateDiff) renderDiff(itemDiff()); return;
    }
    if (!['agentMessage', 'userMessage', 'plan'].includes(item.type)) return;
    const text = item.type === 'userMessage' ? cleanUserMessage((item.content || []).map(c => c.text || '').join('\n')) : item.text || '';
    const target = messageItems.get(item.id);
    if (target) { paintMessage(target, text); trim(); }
    else append(text, item.type === 'userMessage' ? 'remote-user' : '', item.id, item.type === 'plan' ? 'commentary' : item.phase);
  }
  function cleanUserMessage(text) {
    const marker = text.indexOf('## My request:');
    if (marker < 0 || !text.slice(0,marker).includes('Files mentioned by the user')) return text;
    const attachments = [...text.slice(0,marker).matchAll(/^## ([^\n:]+\.(?:png|jpe?g|webp|pdf|txt|docx|xlsx|html)):/gmi)].map(m => '附件：' + m[1]);
    return attachments.join('\n') + (attachments.length ? '\n\n' : '') + text.slice(marker + '## My request:'.length).trim();
  }
  function renderDiff(diff) {
    el('diff').replaceChildren();
    const text = String(diff || '暂无修改').slice(0, 262144), lines = text.split('\n').slice(0, 5000);
    let add = 0, remove = 0;
    for (const line of lines) {
      const span = document.createElement('span'); span.textContent = line;
      span.className = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-delete' : '';
      if (line.startsWith('+') && !line.startsWith('+++')) add++;
      if (line.startsWith('-') && !line.startsWith('---')) remove++;
      el('diff').append(span);
    }
    el('diff-summary').textContent = add || remove ? '+' + add + ' −' + remove : '暂无修改';
    el('diff-card').hidden = !add && !remove && !fileChanges.size;
    const files = Array.from(fileChanges.values()).flat(), byPath = new Map();
    for (const file of files) byPath.set(file.path,file.diff || '');
    if (!byPath.size) for (const match of text.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (match[1] !== '/dev/null') byPath.set(match[1],'');
    el('diff-count').textContent = '已更改 ' + byPath.size + ' 个文件'; el('diff-files').replaceChildren();
    for (const [path,patch] of byPath) {
      const row = document.createElement('div'), name = document.createElement('span'), count = document.createElement('span'); row.className = 'remote-diff-file'; name.textContent = path;
      const additions = patch.split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length, deletions = patch.split('\n').filter(l=>l.startsWith('-')&&!l.startsWith('---')).length;
      count.textContent = '+' + additions + ' −' + deletions; row.append(name,count); el('diff-files').append(row);
    }
  }
  function itemDiff() {
    return Array.from(fileChanges.values()).flat().map(change => '文件：' + (change.path || '') + '\n' + (change.diff || '')).join('\n').slice(0, 262144);
  }
  function threadButton(thread) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'remote-thread' + (thread.id === threadId ? ' selected' : '');
    button.dataset.thread = thread.id; if (thread.id === threadId) button.setAttribute('aria-current', 'true');
    const label = taskLabel(thread, activeThread, activeTurn), dot = document.createElement('span');
    dot.className = 'remote-thread-dot' + (label === '运行中' ? ' running' : label === '需要处理' ? ' error' : '');
    button.title = (thread.name || thread.preview || '未命名会话') + ' · ' + label;
    const copy = document.createElement('span'); copy.className = 'remote-thread-copy';
    const title = document.createElement('span'); title.className = 'remote-thread-title'; title.textContent = thread.name || thread.preview || '未命名会话';
    const meta = document.createElement('span'); meta.className = 'remote-thread-meta';
    const date = thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleDateString('zh-CN', {month:'numeric',day:'numeric'}) + ' · ' : '';
    meta.textContent = date + (thread.projectName || projectName(thread.cwd)) + ' · ' + label;
    copy.append(title, meta); button.append(dot, copy); button.onclick = () => readSelection(thread.id).catch(showError); return button;
  }
  function threadList(threads) {
    const list = document.createElement('ul'); list.className = 'remote-thread-list';
    for (const thread of threads) { const li = document.createElement('li'); li.append(threadButton(thread)); list.append(li); }
    return list;
  }
  function renderLibrary() {
    const container = el('threads'), query = el('search').value.trim().toLowerCase(), filter = el('workspace').value;
    const scrollBox = container.parentElement, oldScroll = scrollBox.scrollTop;
    const expanded = new Map(Array.from(container.querySelectorAll('.remote-project-group')).map(g => [g.dataset.project,g.open]));
    const visible = sessions.filter(t => (!filter || t.projectPath === filter || t.cwd === filter) &&
      (!query || (t.name + ' ' + t.preview + ' ' + (t.projectName || '')).toLowerCase().includes(query)));
    container.replaceChildren();
    const heading = document.createElement('div'); heading.className = 'remote-list-heading';
    const title = document.createElement('h3'); title.textContent = query ? '搜索结果' : '最近'; heading.append(title);
    const compose = document.createElement('button'); compose.type = 'button'; compose.setAttribute('aria-label','新会话'); compose.append(svg('compose')); compose.disabled = !ready || sending; compose.onclick = () => el('new').click(); heading.append(compose); container.append(heading);
    if (visible.length) container.append(threadList(visible.slice(0, query || filter ? 50 : 12)));
    else { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = !ready ? '等待电脑连接。' : query ? '已加载的会话中没有匹配项。' : '暂无会话，可在项目中开始新会话。'; container.append(empty); }
    if (!query) {
      const h = document.createElement('div'); h.className = 'remote-list-heading'; const text = document.createElement('h3'); text.textContent = '项目'; h.append(text); container.append(h);
      for (const project of catalog.filter(p => !filter || p.path === filter)) {
        const threads = visible.filter(t => (t.projectPath || t.cwd) === project.path), group = document.createElement('details');
        group.className = 'remote-project-group'; group.dataset.project = project.path; group.open = expanded.get(project.path) ?? true;
        const summary = document.createElement('summary'), name = document.createElement('span'), start = document.createElement('button');
        name.textContent = project.name; start.type = 'button'; start.setAttribute('aria-label','在 ' + project.name + ' 新建会话'); start.append(svg('compose')); start.disabled = !ready || sending;
        start.onclick = event => { event.preventDefault(); event.stopPropagation(); createThread(project.path).catch(showError); };
        summary.append(svg('folder'),name,start); group.append(summary);
        if (threads.length) group.append(threadList(threads));
        container.append(group);
      }
    }
    el('more').hidden = !cursor; el('library-hint').textContent = sessions.length ? '已读取 ' + sessions.length + ' 条本机会话' : '项目和会话来自这台电脑上的 Codex。';
    scrollBox.scrollTop = oldScroll;
  }
  function installCatalog(status) {
    const selected = el('workspace').value;
    catalog = status.projects || (status.workspaces || []).map(path => ({path, name:projectName(path)}));
    el('workspace').replaceChildren(); el('new-workspace').replaceChildren();
    const all = document.createElement('option'); all.value = ''; all.textContent = '全部项目'; el('workspace').append(all);
    for (const project of catalog) {
      const option = document.createElement('option'); option.value = project.path; option.textContent = project.name || projectName(project.path);
      el('workspace').append(option); el('new-workspace').append(option.cloneNode(true));
    }
    if (catalog.some(p => p.path === selected)) el('workspace').value = selected;
  }
  async function initialize() {
    const current = epoch, status = await client.request('lanpower/status');
    if (current !== epoch || !ready) return;
    if (!Array.isArray(status.projects)) {
      ready = false; currentState = 'runtime_error'; controls(); el('state').textContent = '请更新 Windows 应用';
      showError(new Error('请将这台电脑的 LanPower 更新至 1.10.0 后重新连接。')); return;
    }
    installCatalog(status); catalogPolledAt = Date.now(); activeThread = status.activeThread; activeTurn = status.activeTurn;
    if (activeTurn && !startedAt) startedAt = Date.now();
    if (!status.loggedIn) el('hint').textContent = '本机 Codex 尚未登录，请在电脑完成登录。';
    for (const request of status.pendingApprovals || []) approval(request);
    controls(); await listThreads(false);
    if (current !== epoch || !ready) return;
    const restore = threadId || remembered() || activeThread;
    if (restore) { try { await readSelection(restore, false); } catch { remember(''); } }
    if (current !== epoch || !ready) return;
    if (restore === status.activeThread && status.diff) renderDiff(status.diff);
    const models = await client.request('model/list', {limit:50});
    if (current !== epoch || !ready) return;
    el('model').replaceChildren(); const def = document.createElement('option'); def.value = ''; def.textContent = '本机默认模型'; el('model').append(def);
    for (const model of models.data || []) { const option = document.createElement('option'); option.value = model.model || model.id; option.textContent = model.displayName || model.model || model.id; el('model').append(option); }
  }
  async function listThreads(more) {
    if (!ready || listing) return;
    const current = epoch, filter = el('workspace').value; listing = true;
    try {
      if (!more && Date.now()-catalogPolledAt>30000) {
        const revision = turnRevision, status = await client.request('lanpower/status');
        if (current!==epoch || !ready) return;
        installCatalog(status); catalogPolledAt = Date.now();
        if (revision===turnRevision) { activeThread = status.activeThread; activeTurn = status.activeTurn; }
        for (const request of status.pendingApprovals || []) approval(request); controls();
      }
      const params = {limit:50}; if (more && cursor) params.cursor = cursor;
      const result = await client.request('thread/list', params);
      if (current !== epoch || !ready) return;
      const data = new Map((more ? sessions : []).map(t => [t.id,t]));
      for (const thread of result.data || []) data.set(thread.id,thread);
      sessions = [...data.values()].sort((a,b)=>(b.updatedAt || 0)-(a.updatedAt || 0));
      cursor = result.nextCursor || null;
      if (filter === el('workspace').value) renderLibrary();
    } finally { listing = false; }
  }
  function history(thread, preserve = false) {
    const log = el('transcript'), scrollBox = el('chat-scroll'), oldScroll = scrollBox.scrollTop, atEnd = scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 100;
    const expanded = new Map(Array.from(log.querySelectorAll('.remote-turn')).map(t=>[t.dataset.turn,t.querySelector('details')?.open]));
    log.replaceChildren(); deltas.clear(); messageItems.clear(); turnGroups.clear(); fileChanges.clear(); aggregateDiff = false; el('plan').replaceChildren();
    if (thread.historyTruncated) append('显示最近消息；完整历史保留在电脑上的 Codex。', 'remote-notice');
    for (const turn of thread.turns || []) {
      renderTurn = turn.id; fileChanges.clear();
      for (const item of turn.items || []) renderItem(item);
      const activity = group(turn.id); activity.activity.open = expanded.get(turn.id) || false;
      const duration = turn.durationMs != null ? turn.durationMs/1000 : turn.startedAt && turn.completedAt ? turn.completedAt-turn.startedAt : null;
      activity.summary.textContent = turn.status === 'inProgress' ? '正在运行' : turn.status === 'interrupted' ? '该轮已暂停' : turn.status === 'failed' ? '该轮执行失败' : duration !== null ? '用时 ' + elapsedLabel(duration) : '执行过程';
      activity.activity.hidden = duration === null && !activity.tools.childNodes.length && !['interrupted','failed'].includes(turn.status);
      const reply = activity.replies.querySelector('.remote-message');
      if (reply) {
        const actions = document.createElement('div'), copy = document.createElement('button'); actions.className = 'remote-reply-actions'; copy.type = 'button'; copy.setAttribute('aria-label','复制此回复'); copy.append(svg('copy',18));
        copy.onclick = () => copyText(rawMessages.get(reply) || reply.textContent); actions.append(copy);
        if (turn.completedAt) actions.append(document.createTextNode(new Date(turn.completedAt*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})));
        activity.replies.append(actions);
      }
    }
    renderTurn = null;
    if (!log.childNodes.length) append('会话已就绪。发送第一条消息开始。', 'remote-notice');
    renderDiff(fileChanges.size ? itemDiff() : '');
    if (preserve && !atEnd) scrollBox.scrollTop = oldScroll;
    else scrollBox.scrollTop = scrollBox.scrollHeight;
    el('jump').hidden = !preserve || atEnd;
  }
  async function readSelection(id, navigate = true) {
    const current = epoch, chosen = ++selection;
    const result = await client.request('thread/read', {threadId:id,includeTurns:true});
    if (current !== epoch || chosen !== selection || !ready) return;
    const changed = id !== threadId; if (changed) { renderDiff(''); el('prompt').value = ''; feedback(''); }
    threadId = id; selectedThread = result.thread;
    synchronizedAt = Date.now();
    el('title').textContent = selectedThread.name || selectedThread.preview || '开发会话';
    el('project-name').textContent = (selectedThread.projectName || projectName(selectedThread.cwd)) + ' · ' + el('device').selectedOptions[0].textContent;
    history(selectedThread, !changed);
    const index = sessions.findIndex(t => t.id === id); if (index >= 0) sessions[index] = {...sessions[index],...selectedThread,turns:undefined};
    remember(id); controls(); renderLibrary(); if (navigate) { viewThread(true); window.scrollTo({top:0}); }
  }
  async function createThread(path) {
    if (!ready || sending) return;
    const current = epoch; sending = true; controls();
    try {
      const params = {cwd:path}; if (el('model').value) params.model = el('model').value;
      const result = await client.request('thread/start',params); if (current !== epoch || !ready) return;
      el('project-picker').close(); sessions.unshift(result.thread); await readSelection(result.thread.id); await listThreads(false);
    } finally { if (current === epoch) { sending = false; controls(); } }
  }
  function onEvent(message) {
    const p = message.params || {}, method = message.method;
    if (message.id !== undefined) { approval(message); return; }
    if (method === 'lanpower/error') { showError(new Error(ERRORS[p.code] || '连接请求被拒绝，请检查本机状态或重新连接。')); return; }
    if (method === 'lanpower/approvalError') {
      const card = approvals.get(JSON.stringify(p.id));
      if (card) { card.querySelector('h3').textContent = '本机未接收该决定，请重新处理'; card.querySelectorAll('button').forEach(b => b.disabled = false); }
      return;
    }
    if (method === 'serverRequest/resolved') { approvals.get(JSON.stringify(p.requestId))?.remove(); approvals.delete(JSON.stringify(p.requestId)); return; }
    if (method === 'turn/started') {
      turnRevision++;
      activeThread = p.threadId; activeTurn = p.turn?.id; startedAt = Date.now();
      if (p.threadId === threadId) { fileChanges.clear(); aggregateDiff = false; renderDiff(''); el('plan').replaceChildren(); el('progress-label').textContent = '正在工作'; }
      controls(); renderLibrary();
    }
    if (method === 'turn/completed') {
      turnRevision++;
      lastCompletion = {thread:p.threadId,turn:p.turn?.id,status:p.turn?.status};
      const duration = p.turn?.durationMs != null ? p.turn.durationMs/1000 : startedAt ? (Date.now()-startedAt)/1000 : null;
      if (p.threadId === activeThread && p.turn?.id === activeTurn) { activeTurn = null; activeThread = null; sending = false; startedAt = 0; }
      if (p.threadId === threadId) {
        const labels = {completed:'任务已完成',failed:'任务执行失败',interrupted:'本轮任务已暂停，可继续发送消息。'};
        renderTurn = p.turn?.id;
        const activity = group(); activity.activity.hidden = false; activity.summary.textContent = p.turn?.status === 'interrupted' ? '该轮已暂停' : duration !== null ? '用时 ' + elapsedLabel(duration) : '执行过程'; renderTurn = null;
        feedback(labels[p.turn?.status] || '任务状态已更新', p.turn?.status === 'failed');
      }
      for (const [key,card] of approvals) if (card.dataset.thread === p.threadId) { card.remove(); approvals.delete(key); }
      controls(); renderLibrary(); return;
    }
    if (p.threadId && p.threadId !== threadId) return;
    if (!threadId) return;
    if (method === 'turn/diff/updated') { aggregateDiff = true; renderDiff(p.diff); }
    if (['item/started','item/completed'].includes(method) && p.item) {
      renderItem(p.item);
      if (method === 'item/started' && p.item.type === 'commandExecution') el('progress-label').textContent = '正在执行本机操作';
    }
    if (method.endsWith('/delta') || method.endsWith('/outputDelta')) {
      let target = messageItems.get(p.itemId) || deltas.get(p.itemId);
      if (target?.tagName === 'DETAILS') target = target.querySelector('pre');
      if (!target) { target = append('', '', p.itemId); deltas.set(p.itemId,target); }
      paintMessage(target, ((rawMessages.get(target) || target.textContent) + (p.delta || '')).slice(-262144)); trim();
      if (method === 'item/agentMessage/delta') el('progress-label').textContent = 'Codex 正在回复';
    }
    if (method === 'turn/plan/updated') {
      el('plan').replaceChildren();
      const labels = {pending:'待开始',inProgress:'进行中',completed:'已完成'};
      for (const step of p.plan || []) { const li = document.createElement('li'); li.textContent = (labels[step.status] || step.status) + ' · ' + step.step; el('plan').append(li); }
    }
    if (method === 'error') append('本机 Codex 报告错误，请在电脑检查详细状态。','remote-notice');
  }
  function approval(request) {
    const key = JSON.stringify(request.id); if (approvals.has(key)) return;
    const p = request.params || {}, method = request.method;
    const card = document.createElement('div'); card.className = 'remote-approval'; card.dataset.thread = p.threadId || '';
    const heading = document.createElement('h3');
    heading.textContent = method.includes('fileChange') ? '审核文件修改' : method.includes('permissions') ? '审核权限请求' : method.includes('requestUserInput') ? 'Codex 需要你的回答' : method.includes('elicitation') ? '工具需要本机确认' : '审核命令执行';
    card.append(heading);
    const preview = document.createElement('pre');
    preview.textContent = [p.reason,p.cwd,p.command,p.grantRoot ? '额外目录：' + p.grantRoot : '',
      method.includes('fileChange') ? JSON.stringify(fileChanges.get(p.itemId) || {grantRoot:p.grantRoot || '查看代码修改'},null,2) : '',
      method.includes('permissions') ? JSON.stringify(p.permissions,null,2) : '',p.message].filter(Boolean).join('\n').slice(0,65536);
    card.append(preview);
    function button(label,result) {
      const b = document.createElement('button'); b.type = 'button'; b.className = label.startsWith('批准') || label.startsWith('提交') || label.startsWith('仅允许') ? 'primary' : 'secondary'; b.textContent = label;
      b.onclick = () => { try { client.decide(request.id,typeof result === 'function' ? result() : result); card.querySelectorAll('button').forEach(b => b.disabled = true); heading.textContent = '已提交，等待本机确认'; } catch (error) { showError(error); } };
      card.append(b);
    }
    if (method.includes('requestUserInput')) {
      const fields = [];
      for (const question of p.questions || []) {
        const label = document.createElement('label'); label.textContent = question.question || question.header;
        const input = document.createElement('input'); input.type = question.isSecret ? 'password' : 'text'; input.maxLength = 4000;
        input.placeholder = (question.options || []).map(o => o.label).join(' / '); label.append(input); card.append(label); fields.push([question.id,input]);
      }
      button('提交回答',()=>({answers:Object.fromEntries(fields.map(([id,input])=>[id,{answers:[input.value]}]))}));
    } else if (method.includes('permissions')) {
      if (p.permissions?.network?.enabled && !p.permissions?.fileSystem) button('仅允许本次网络访问',{permissions:{network:{enabled:true}},scope:'turn'});
      button('拒绝额外权限',{permissions:{},scope:'turn'});
    } else if (method.includes('elicitation')) button('拒绝并在本机处理',{action:'decline',content:null});
    else { button('拒绝',{decision:'decline'}); button('批准一次',{decision:'accept'}); }
    approvals.set(key,card); el('approvals').append(card);
    if (p.threadId === threadId) el('progress-label').textContent = '等待你的确认';
  }
  function reset() {
    epoch++; selection++; threadId = activeThread = activeTurn = selectedThread = null; sending = ready = false; cursor = null; sessions = []; catalog = []; startedAt = 0;
    approvals.clear(); deltas.clear(); fileChanges.clear(); messageItems.clear(); turnGroups.clear(); renderTurn = null; synchronizedAt = catalogPolledAt = 0; lastCompletion = null; el('approvals').replaceChildren(); el('threads').replaceChildren();
    el('transcript').replaceChildren(); el('workspace').replaceChildren(); el('prompt').value = ''; feedback(''); renderDiff(''); controls(); viewThread(false);
  }
  function chooseComputer() {
    client.stop(); reset(); setState('idle'); el('wake').disabled = true; updatePower();
    if (el('device').value) client.connect(el('device').value);
    computerTabs();
  }
  el('connect').onclick = () => {
    if (!el('device').value) return;
    if (client.socket) { client.stop(); setState('idle'); return; }
    client.connect(el('device').value);
  };
  el('device').onchange = chooseComputer;
  el('workspace').onchange = () => { renderLibrary(); computerTabs(); }; el('search').oninput = renderLibrary;
  el('more').onclick = () => listThreads(true).catch(showError);
  el('back').onclick = () => { viewThread(false); window.scrollTo({top:0}); };
  el('new').onclick = () => {
    if (!catalog.length) return;
    if (el('workspace').value) createThread(el('workspace').value).catch(showError);
    else if (catalog.length === 1) createThread(catalog[0].path).catch(showError);
    else el('project-picker').showModal();
  };
  el('create').onclick = () => createThread(el('new-workspace').value).catch(showError);
  el('task').onsubmit = async event => {
    event.preventDefault(); const text = el('prompt').value.trim();
    if (!text || !ready || !threadId || sending || selectedThread?.control === 'desktop') return;
    const current = epoch, chosen = threadId, turn = selectedActive() ? activeTurn : null; sending = true; feedback(''); controls();
    try {
      if (!turn && activeTurn) throw new Error(ERRORS.task_running);
      if (!turn && selectedThread.control !== 'remote') {
        await client.request('thread/resume',{threadId:chosen});
        if (current !== epoch || chosen !== threadId) return;
        selectedThread.control = 'remote';
      }
      const params = {threadId:chosen,input:[{type:'text',text}]}; if (turn) params.expectedTurnId = turn; else if (el('model').value) params.model = el('model').value;
      const revision = turnRevision, result = await client.request(turn ? 'turn/steer' : 'turn/start',params);
      if (current !== epoch || chosen !== threadId) return;
      const lastUser = Array.from(el('transcript').querySelectorAll('.remote-user')).at(-1);
      if (turn || lastUser?.textContent !== text) append(text,'remote-user');
      el('prompt').value = '';
      resizePrompt();
      if (turn) { el('hint').textContent = '引导已由本机接收，将应用到当前任务。'; feedback('引导已由本机接收。'); }
      else if (revision === turnRevision && !activeTurn && result.turn?.status === 'inProgress') {
        activeThread = chosen; activeTurn = result.turn.id; startedAt = Date.now();
      }
    } catch (error) { showError(error); }
    finally { if (current === epoch) { sending = false; controls(); renderLibrary(); } }
  };
  el('prompt').onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); el('task').requestSubmit(); } };
  el('interrupt').onclick = async () => {
    if (!selectedActive() || sending) return;
    const current = epoch, interrupted = activeTurn; sending = true; feedback(''); controls();
    try {
      await client.request('turn/interrupt',{threadId:activeThread,turnId:activeTurn});
      if (current === epoch) {
        const text = interrupted === activeTurn ? '暂停请求已发送，等待本机确认。' : lastCompletion?.turn === interrupted && lastCompletion.status === 'interrupted' ? '本轮任务已暂停，可继续发送消息。' : '本轮任务已结束，请确认最新状态。';
        el('hint').textContent = text; feedback(text);
      }
    }
    catch (error) { showError(error); }
    finally { if (current === epoch) { sending = false; controls(); } }
  };
  let powerUpdating = false;
  async function updatePower() {
    if (!el('device').value) { el('wake').disabled = true; el('power-state').textContent = '请选择电脑'; return; }
    if (powerUpdating) return;
    const chosen = el('device').value; powerUpdating = true;
    const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),4500);
    try {
      const response = await fetch('/api/v2/devices/' + encodeURIComponent(chosen),{cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('status_unavailable');
      const status = await response.json(); if (el('device').value !== chosen) return;
      el('wake').disabled = !status.wake_available;
      const labels = {online:'Windows 在线',offline:'Windows 离线',transitioning:'正在执行电源操作',unknown:'电脑状态未知'};
      el('power-state').textContent = (labels[status.state] || labels.unknown) + ' · ' + (status.wake_available ? '可通过网关唤醒' : '远程唤醒暂不可用');
    } catch { if (el('device').value === chosen) { el('wake').disabled = true; el('power-state').textContent = '电脑状态未知，请检查 Cloud 连接'; } }
    finally { clearTimeout(timeout); powerUpdating = false; }
  }
  el('wake').onclick = async () => {
    el('wake').disabled = true;
    try {
      const response = await fetch('/api/v2/devices/' + encodeURIComponent(el('device').value) + '/commands',{
        method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:'{"action":"wake"}',cache:'no-store'});
      if (!response.ok) throw new Error('唤醒未被接收，请检查网关在线状态。');
      el('hint').textContent = '唤醒请求已发送。电脑上线并登录 Windows 后会自动连接。';
    } catch (error) { showError(error); }
  };
  async function refreshSelected() {
    if (!ready || !threadId || refreshing || sending || selectedThread?.control === 'remote' && selectedActive()) return;
    const current = epoch, chosen = threadId, version = selection; refreshing = true;
    try {
      const result = await client.request('thread/read',{threadId:chosen,includeTurns:true});
      if (current !== epoch || chosen !== threadId || version !== selection || !ready) return;
      const changed = JSON.stringify(result.thread.turns) !== JSON.stringify(selectedThread?.turns);
      selectedThread = result.thread; synchronizedAt = Date.now(); if (changed) history(result.thread,true);
      const index = sessions.findIndex(t=>t.id===chosen); if (index>=0) sessions[index] = {...sessions[index],...selectedThread,turns:undefined};
      controls(); if (changed) renderLibrary();
    } catch (error) { if (current === epoch && chosen === threadId) showError(error); }
    finally { refreshing = false; }
  }
  function togglePanel(name, button) { const target = el(name); target.hidden = !target.hidden; el(button).setAttribute('aria-expanded',String(!target.hidden)); }
  async function copyText(text) { try { await navigator.clipboard.writeText(text); feedback('已复制。'); } catch { feedback('浏览器未允许复制，可使用导出会话文本。',true); } }
  function resizePrompt() { el('prompt').style.height = 'auto'; el('prompt').style.height = Math.min(140,el('prompt').scrollHeight) + 'px'; controls(); }
  el('prompt').oninput = resizePrompt;
  el('options-toggle').onclick = () => togglePanel('options','options-toggle');
  el('menu-toggle').onclick = () => togglePanel('menu','menu-toggle');
  el('search-toggle').onclick = () => { togglePanel('filters','search-toggle'); if (!el('filters').hidden) el('search').focus(); };
  el('computers').onclick = el('connection').onclick = () => { el('menu').hidden = true; el('device-picker').showModal(); };
  el('device').addEventListener('change',()=>el('device-picker').close());
  el('compose').onclick = () => { const path = selectedThread?.projectPath || selectedThread?.cwd; if (path && catalog.some(p=>p.path===path)) createThread(path).catch(showError); else el('new').click(); };
  el('refresh').onclick = () => { el('menu').hidden = true; refreshSelected(); };
  el('copy').onclick = () => { el('menu').hidden = true; const replies = Array.from(el('transcript').querySelectorAll('.remote-message:not(.remote-user):not(.remote-notice)')); const last = replies.at(-1); if (last) copyText(rawMessages.get(last) || last.textContent); else feedback('当前还没有回复可复制。'); };
  el('export').onclick = () => {
    el('menu').hidden = true; const texts = Array.from(el('transcript').querySelectorAll('.remote-message')).map(n=>(n.classList.contains('remote-user')?'你：':'Codex：') + '\n' + (rawMessages.get(n)||n.textContent));
    const blob = new Blob([el('title').textContent + '\n' + el('project-name').textContent + '\n\n' + texts.join('\n\n')],{type:'text/plain;charset=utf-8'}), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'codex-conversation.txt'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  el('chat-scroll').addEventListener('scroll',()=>{ const box=el('chat-scroll'); el('jump').hidden = box.scrollHeight-box.scrollTop-box.clientHeight<100; },{passive:true});
  el('jump').onclick = () => { el('chat-scroll').scrollTop = el('chat-scroll').scrollHeight; };
  document.addEventListener('click',event=>{ if (!event.target.closest('.remote-header-actions') && !event.target.closest('#remote-menu')) { el('menu').hidden=true; el('menu-toggle').setAttribute('aria-expanded','false'); } if (!event.target.closest('.sidebar') && !event.target.closest('[data-nav-toggle]')) { document.querySelector('.sidebar').classList.remove('mobile-open'); document.querySelector('[data-nav-toggle]').setAttribute('aria-expanded','false'); } });
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Recognition) {
    el('mic').hidden = false; let recognition = null;
    el('mic').onclick = () => {
      if (recognition) { recognition.stop(); return; } if (el('prompt').disabled) return;
      recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false;
      recognition.onresult = event => { el('prompt').value = (el('prompt').value + ' ' + event.results[0][0].transcript).trim().slice(0,16000); resizePrompt(); };
      recognition.onend = () => { recognition = null; el('mic').setAttribute('aria-label','语音输入'); };
      recognition.onerror = () => feedback('语音输入不可用，请直接输入文字。',true);
      recognition.start(); el('mic').setAttribute('aria-label','停止语音输入');
    };
  }
  // Keep the composer above the mobile browser keyboard without scrolling the page chrome away.
  function viewport() { if (window.visualViewport && innerWidth<=760) document.querySelector('.workspace').style.height = Math.round(window.visualViewport.height) + 'px'; else document.querySelector('.workspace').style.height = ''; }
  window.visualViewport?.addEventListener('resize',viewport); window.addEventListener('resize',viewport); viewport();
  window.addEventListener('beforeunload',()=>client.stop());
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(()=>{});
  const computer = new URLSearchParams(location.search).get('computer'), options = Array.from(el('device').options).filter(o=>o.value);
  if (computer && options.some(o=>o.value===computer)) el('device').value = computer;
  else if (options.length === 1) el('device').value = options[0].value;
  chooseComputer();
  setInterval(()=>{ if (document.visibilityState === 'visible') { updatePower(); refreshSelected(); } },2000);
  setInterval(()=>{ if (document.visibilityState === 'visible' && ready) listThreads(false).catch(showError); },15000);
  setInterval(()=>{
    if ((!selectedActive() && !observedActive()) || !startedAt) return;
    const seconds = Math.floor((Date.now()-startedAt)/1000);
    el('elapsed').textContent = '已运行 ' + elapsedLabel(seconds);
  },1000);
  document.addEventListener('visibilitychange',()=>{ if (document.visibilityState === 'visible') { updatePower(); refreshSelected(); } });
})();
