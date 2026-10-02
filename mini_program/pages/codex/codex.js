const {CloudClient} = require('../../utils/cloud');
const {storageKey} = require('../../utils/environment');
const {CodexConnection, STATES, ERRORS} = require('../../utils/codex-remote');
const {projectName, relativeTime, elapsed, markdown, diffSummary, utf8Length} = require('../../utils/codex-format');
const THEME_KEY = 'lanpower_codex_theme_v1';
const CACHE_KEY = 'lanpower_device_cache_v2';

Page({
  data: {theme: 'light', themeMode: 'system', authorized: false, view: 'library', devices: [], deviceIndex: 0,
    deviceId: '', deviceName: '选择开发电脑', state: 'idle', stateTitle: '选择开发电脑', stateHint: '选择电脑后读取项目和最近会话',
    ready: false, loading: false, busy: false, sessions: [], projects: [], projectOptions: [{name: '全部项目', path: ''}],
    projectIndex: 0, search: '', hasMore: false, title: '', project: '', messages: [], prompt: '',
    canSend: false, canInterrupt: false, showStop: false, canRelease: false, desktop: false, placeholder: '向 Codex 提问',
    taskState: '', controlHint: '', running: false, progressOpen: false, plan: [], activities: [], liveAction: '', elapsed: '',
    files: [], added: 0, removed: 0, diffOpen: false, diffText: '', approvals: [], sheet: '', approval: null,
    models: [{name: '本机默认模型', value: ''}], modelIndex: 0, feedback: '', keyboardHeight: 0, scrollTarget: '', showJump: false},

  onLoad(options = {}) {
    this.client = CloudClient.load(wx); this.authorized = !!this.client;
    this.epoch = 0; this.selection = 0; this.follow = true; this.activeTurns = new Map(); this.pendingApprovals = new Map();
    this.items = []; this.sessions = []; this.projects = []; this.changes = new Map(); this.turnRevision = 0;
    this.themeStorageKey = storageKey(wx, THEME_KEY);
    this.themeMode = wx.getStorageSync(this.themeStorageKey) || 'system';
    const system = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    this.systemTheme = (wx.getAppBaseInfo ? wx.getAppBaseInfo().theme : system.theme) || 'light';
    this.applyTheme();
    this.themeChanged = ({theme}) => { this.systemTheme = theme; if (this.themeMode === 'system') this.applyTheme(); };
    if (wx.onThemeChange) wx.onThemeChange(this.themeChanged);
    this.networkChanged = ({isConnected}) => { if (this.visible && isConnected && this.connection && !this.connection.opened) this.reconnect(); };
    if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(this.networkChanged);
    const cache = wx.getStorageSync(storageKey(wx, CACHE_KEY));
    this.preferredDevice = options.computer || (this.client && cache && cache.url === this.client.session.url &&
      cache.client_id === this.client.session.client_id ? cache.selectedId : '');
    this.setData({authorized: this.authorized});
    if (this.client) this.connection = new CodexConnection({wxApi: wx, cloud: this.client,
      state: state => this.setState(state), event: event => this.onEvent(event)});
  },
  onShow() {
    this.visible = true;
    if (this.client) this.loadDevices();
    this.poll = setInterval(() => {
      if (!this.visible || !this.data.ready) return;
      this.refreshSelected();
      if (Date.now() - (this.lastListed || 0) > 15000) this.refreshLibrary();
    }, 2000);
    this.clock = setInterval(() => this.updateElapsed(), 1000);
  },
  onHide() {
    this.visible = false; this.epoch++; clearInterval(this.poll); clearInterval(this.clock);
    clearTimeout(this.paintTimer); this.connection && this.connection.stop();
    this.setState('disconnected'); this.setData({keyboardHeight: 0, sheet: ''});
  },
  onUnload() {
    this.onHide(); this.client && this.client.close();
    if (wx.offThemeChange) wx.offThemeChange(this.themeChanged);
    if (wx.offNetworkStatusChange) wx.offNetworkStatusChange(this.networkChanged);
    this.items = []; this.sessions = []; this.pendingApprovals.clear();
  },
  applyTheme() {
    const theme = this.themeMode === 'system' ? this.systemTheme : this.themeMode;
    this.setData({theme: theme === 'dark' ? 'dark' : 'light', themeMode: this.themeMode});
    if (wx.setNavigationBarColor) wx.setNavigationBarColor({frontColor: theme === 'dark' ? '#ffffff' : '#000000',
      backgroundColor: theme === 'dark' ? '#181818' : '#ffffff', animation: {duration: 0}});
  },
  changeTheme(event) {
    const value = event.currentTarget.dataset.value;
    if (!['light', 'dark', 'system'].includes(value)) return;
    this.themeMode = value; wx.setStorageSync(this.themeStorageKey, value); this.applyTheme();
  },
  navigate(event) {
    const tab = event.currentTarget.dataset.tab || 'connect';
    wx.redirectTo({url: '/pages/cloud/cloud?tab=' + tab});
  },
  notify(message) { this.setData({feedback: message || ''}); },
  dismissFeedback() { this.notify(''); },
  async loadDevices() {
    if (!this.client || this.devicesLoading) return;
    const epoch = this.epoch; this.devicesLoading = true; this.setData({loading: true});
    try {
      const list = await this.client.call('/api/v2/devices');
      if (!this.visible || epoch !== this.epoch) return;
      const devices = list.filter(d => d.device_type === 'windows');
      const selected = devices.find(d => d.device_id === (this.data.deviceId || this.preferredDevice)) || devices[0];
      this.setData({devices, deviceIndex: selected ? devices.indexOf(selected) : 0});
      if (selected) {
        if (selected.device_id !== this.data.deviceId) this.chooseDevice(selected);
        else if (!this.connection.device) this.connection.connect(selected.device_id);
      } else {
        this.connection.stop(); this.resetSession();
        this.setData({deviceId: '', deviceName: '还没有开发电脑'}); this.setState('idle');
      }
    } catch (error) {
      if (this.visible && epoch === this.epoch) { this.notify(error.message); if (error.code === 'REAUTHORIZE') this.setState('reauthorize'); }
    } finally { this.devicesLoading = false; if (epoch === this.epoch) this.setData({loading: false}); }
  },
  selectDevice(event) {
    const device = this.data.devices[Number(event.detail.value)];
    if (device && device.device_id !== this.data.deviceId) this.chooseDevice(device);
  },
  chooseDevice(device) {
    this.epoch++; this.connection.stop(); this.resetSession();
    this.setData({deviceId: device.device_id, deviceName: device.name,
      deviceIndex: this.data.devices.findIndex(d => d.device_id === device.device_id), loading: false});
    this.connection.connect(device.device_id);
  },
  resetSession() {
    this.thread = null; this.activeTurns.clear(); this.pendingApprovals.clear(); this.items = []; this.sessions = []; this.projects = [];
    this.changes.clear(); this.cursor = ''; this.aggregateDiff = ''; this.handoff = false; this.loggedIn = false;
    this.setData({view: 'library', sessions: [], projects: [], messages: [], files: [], diffText: '', approvals: [], sheet: '', approval: null,
      prompt: '', ready: false, busy: false, title: '', search: '', projectIndex: 0, projectOptions: [{name: '全部项目', path: ''}],
      plan: [], liveAction: '', progressOpen: false, diffOpen: false, hasMore: false, feedback: '', added: 0, removed: 0});
  },
  reconnect() {
    if (!this.connection || !this.data.deviceId) { this.loadDevices(); return; }
    this.epoch++; this.connection.connect(this.data.deviceId);
  },
  setState(state) {
    const wasReady = this.data.ready, labels = STATES[state] || STATES.disconnected;
    this.setData({state, stateTitle: labels[0], stateHint: labels[1], ready: state === 'runtime_ready'});
    if (state !== 'runtime_ready') {
      if (wasReady) this.epoch++;
      this.pendingApprovals.clear(); this.setData({approvals: [], approval: null, sheet: '', busy: false});
    }
    this.controls();
    if (state === 'runtime_ready' && !wasReady) {
      const epoch = this.epoch; this.initialize().catch(error => {if (epoch === this.epoch) this.notify(error.message);});
    }
  },
  async initialize() {
    const epoch = this.epoch, status = await this.connection.request('lanpower/status');
    if (epoch !== this.epoch || !this.data.ready) return;
    if (!Array.isArray(status.projects)) { this.setState('runtime_error'); this.notify('请更新电脑上的 LanPower 后重新连接。'); return; }
    this.projects = status.projects; this.handoff = status.sessionHandoff === true; this.loggedIn = status.loggedIn === true;
    const previous = this.activeTurns; this.activeTurns = new Map();
    const turns = status.activeTurns || (status.activeTurn ? [{threadId: status.activeThread, turnId: status.activeTurn}] : []);
    for (const turn of turns) this.activeTurns.set(turn.threadId, {id: turn.turnId, startedAt: previous.get(turn.threadId)?.startedAt || Date.now()});
    this.setData({projects: this.projects, projectOptions: [{name: '全部项目', path: ''}, ...this.projects]});
    for (const request of status.pendingApprovals || []) this.addApproval(request);
    if (!this.loggedIn) this.notify('请先在电脑上的 Codex 完成登录。');
    this.controls(); await this.refreshLibrary();
    if (epoch !== this.epoch || !this.data.ready) return;
    const restore = this.thread && this.thread.id;
    if (restore) await this.readThread(restore, false);
    const models = await this.connection.request('model/list', {limit: 50});
    if (epoch !== this.epoch || !this.data.ready) return;
    this.setData({models: [{name: '本机默认模型', value: ''}, ...(models.data || []).map(m => ({name: m.displayName || m.model || m.id, value: m.model || m.id}))]});
  },
  async refreshLibrary(more = false) {
    if (!this.data.ready || this.listing) return;
    const epoch = this.epoch; this.listing = true;
    try {
      const params = {limit: 50}; if (more && this.cursor) params.cursor = this.cursor;
      const result = await this.connection.request('thread/list', params);
      if (epoch !== this.epoch || !this.data.ready) return;
      const sessions = new Map((more ? this.sessions : []).map(t => [t.id, t]));
      for (const thread of result.data || []) sessions.set(thread.id, thread);
      this.sessions = Array.from(sessions.values()).slice(0, 200); this.cursor = result.nextCursor || '';
      this.lastListed = Date.now(); this.renderLibrary();
    } catch (error) { if (epoch === this.epoch) this.notify(error.message); }
    finally { this.listing = false; }
  },
  renderLibrary() {
    const filter = this.data.projectOptions[this.data.projectIndex]?.path || '', search = this.data.search.toLowerCase();
    const sessions = this.sessions.filter(t => (!filter || (t.projectPath || t.cwd) === filter) &&
      (!search || [t.name, t.preview, t.projectName].join(' ').toLowerCase().includes(search))).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.setData({sessions: sessions.map(t => ({id: t.id, name: t.name || t.preview || '未命名会话',
      project: t.projectName || projectName(t.cwd), time: relativeTime(t.updatedAt),
      running: this.activeTurns.has(t.id) || t.live?.state === 'running', desktop: t.control === 'desktop'})), hasMore: !!this.cursor});
  },
  search(event) { this.setData({search: event.detail.value}); this.renderLibrary(); },
  filterProject(event) { this.setData({projectIndex: Number(event.detail.value)}); this.renderLibrary(); },
  more() { this.refreshLibrary(true); },
  selectThread(event) { this.readThread(event.currentTarget.dataset.id).catch(error => this.notify(error.message)); },
  async readThread(id, navigate = true) {
    const epoch = this.epoch, selection = ++this.selection, revision = this.turnRevision;
    const result = await this.connection.request('thread/read', {threadId: id, includeTurns: true});
    if (epoch !== this.epoch || selection !== this.selection || !this.data.ready) return;
    if (this.thread?.id === id && revision !== this.turnRevision) return;
    const changed = this.thread?.id !== id;
    if (changed || navigate) this.follow = true;
    this.thread = result.thread; this.changes.clear(); this.aggregateDiff = ''; this.items = [];
    for (const turn of this.thread.turns || []) {
      for (const item of turn.items || []) this.installItem(item, turn.id);
      if (turn.items?.length) this.items.push({id: 'summary-' + turn.id, kind: 'summary', turnId: turn.id,
        text: turn.status === 'inProgress' ? '正在运行' : turn.status === 'interrupted' ? '该轮已暂停' : '已完成' + (turn.durationMs ? ' · ' + elapsed(turn.durationMs / 1000) : '')});
    }
    const index = this.sessions.findIndex(t => t.id === id); if (index >= 0) this.sessions[index] = {...this.sessions[index], ...this.thread, turns: undefined};
    this.setData({title: this.thread.name || this.thread.preview || '新会话', project: this.thread.projectName || projectName(this.thread.cwd),
      ...(navigate ? {view: 'chat'} : {}), ...(changed ? {prompt: '', plan: [], liveAction: '', diffOpen: false, progressOpen: false} : {})});
    this.paint(this.follow); this.controls(); this.renderLibrary();
  },
  async refreshSelected() {
    if (!this.thread || this.refreshing || this.data.busy || this.thread.control === 'remote' && this.activeTurns.has(this.thread.id)) return;
    const epoch = this.epoch; this.refreshing = true;
    try { await this.readThread(this.thread.id, false); }
    catch (error) { if (epoch === this.epoch) this.notify(error.message); }
    finally { this.refreshing = false; }
  },
  back() { this.setData({view: 'library', sheet: '', keyboardHeight: 0}); },
  chatScroll(event) {
    const top = event.detail.scrollTop || 0;
    if (top < (this.lastScrollTop || 0) - 16) this.follow = false;
    this.lastScrollTop = top;
    this.setData({showJump: !this.follow});
  },
  reachedBottom() { this.follow = true; this.setData({showJump: false}); },
  jump() { this.follow = true; this.setData({scrollTarget: '', showJump: false}); this.setData({scrollTarget: 'chat-end'}); },
  openNew() {
    if (!this.data.ready || !this.loggedIn || this.data.busy) return;
    this.setData({sheet: 'project'});
  },
  async createThread(event) {
    if (!this.data.ready || this.data.busy) return;
    const path = event.currentTarget.dataset.path;
    if (!this.projects.some(p => p.path === path)) return;
    const epoch = this.epoch; this.setData({busy: true}); this.controls();
    try {
      const params = {cwd: path}, model = this.data.models[this.data.modelIndex]?.value;
      if (model) params.model = model;
      const result = await this.connection.request('thread/start', params);
      if (epoch !== this.epoch) return;
      this.sessions.unshift(result.thread); this.setData({sheet: ''}); await this.readThread(result.thread.id);
    } catch (error) { if (epoch === this.epoch) this.notify(error.message); }
    finally { if (epoch === this.epoch) { this.setData({busy: false}); this.controls(); } }
  },
  input(event) { this.setData({prompt: event.detail.value}); this.controls(); },
  keyboard(event) { this.setData({keyboardHeight: Math.max(0, event.detail.height || 0)}); },
  model(event) { this.setData({modelIndex: Number(event.detail.value)}); },
  async send() {
    const text = this.data.prompt.trim();
    if (!this.data.canSend || !text || text.length > 16000) return;
    const epoch = this.epoch, thread = this.thread, active = this.activeTurns.get(thread.id);
    this.setData({busy: true, feedback: ''}); this.controls();
    try {
      if (!active && thread.control !== 'remote') {
        await this.connection.request('thread/resume', {threadId: thread.id});
        if (epoch !== this.epoch || thread !== this.thread) return; thread.control = 'remote';
      }
      const params = {threadId: thread.id, input: [{type: 'text', text}]};
      if (active) params.expectedTurnId = active.id;
      else { const model = this.data.models[this.data.modelIndex]?.value; if (model) params.model = model; }
      const revision = this.turnRevision;
      const previousUserIds = new Set(this.items.filter(item => item.kind === 'user').map(item => item.id));
      const result = await this.connection.request(active ? 'turn/steer' : 'turn/start', params);
      if (epoch !== this.epoch || thread !== this.thread) return;
      const turnId = active?.id || result.turn?.id;
      if (!this.items.some(item => item.kind === 'user' && item.text === text.slice(-12000) && item.turnId === turnId && !previousUserIds.has(item.id)))
        this.items.push({id: 'sent-' + Date.now(), kind: 'user', text: text.slice(-12000), turnId, optimistic: true});
      if (!active && revision === this.turnRevision && result.turn?.status === 'inProgress') this.activeTurns.set(thread.id, {id: result.turn.id, startedAt: Date.now()});
      this.setData({prompt: '', sheet: ''}); this.paint(true);
      if (active) this.notify('补充要求已由本机接收。');
    } catch (error) { if (epoch === this.epoch) this.notify(error.message); }
    finally { if (epoch === this.epoch) { this.setData({busy: false}); this.controls(); this.renderLibrary(); } }
  },
  async interrupt() {
    if (!this.data.canInterrupt) return;
    const epoch = this.epoch, active = this.activeTurns.get(this.thread.id);
    this.setData({busy: true}); this.controls();
    try {
      await this.connection.request('turn/interrupt', {threadId: this.thread.id, turnId: active.id});
      if (epoch === this.epoch) this.notify(this.activeTurns.has(this.thread.id) ? '暂停请求已发送，等待本机确认。' : '本轮任务已结束。');
    } catch (error) { if (epoch === this.epoch) this.notify(error.message); }
    finally { if (epoch === this.epoch) { this.setData({busy: false}); this.controls(); } }
  },
  async release() {
    if (!this.data.canRelease) return;
    const epoch = this.epoch, id = this.thread.id; this.setData({busy: true}); this.controls();
    try {
      await this.connection.request('lanpower/session/release', {threadId: id});
      if (epoch === this.epoch && this.thread?.id === id) { this.thread.control = 'available'; this.setData({sheet: ''}); this.notify('会话已交还，可以在桌面继续。'); }
    } catch (error) { if (epoch === this.epoch) this.notify(error.message); }
    finally { if (epoch === this.epoch) { this.setData({busy: false}); this.controls(); } }
  },
  controls() {
    const thread = this.thread, active = thread && this.activeTurns.get(thread.id), desktop = thread?.control === 'desktop';
    const observed = desktop && thread.live?.state === 'running', editable = this.data.ready && this.loggedIn && !!thread && !desktop && !this.data.busy;
    this.setData({desktop: !!desktop, canSend: editable && !!this.data.prompt.trim(), canInterrupt: editable && !!active,
      showStop: (!!active || observed) && !this.data.prompt.trim(), running: !!active || observed,
      canRelease: this.data.ready && this.handoff && thread?.control === 'remote' && !active && !this.data.busy,
      placeholder: desktop ? '桌面会话 · 当前同步查看' : active ? '补充要求…' : '向 Codex 提问',
      taskState: !this.data.ready ? this.data.stateTitle : desktop ? observed ? '桌面正在运行 · 同步查看' : thread.live?.state === 'idle' ? '桌面已连接 · 本轮已结束' : '桌面已连接 · 状态待确认' : active ? '正在运行' : this.data.busy ? '正在发送' : '可以继续',
      controlHint: desktop ? '每 2 秒同步桌面进度，桌面释放后可继续。' : active ? '可补充要求或暂停任务' : ''});
    this.updateElapsed();
  },
  updateElapsed() {
    const started = this.thread?.control === 'desktop' ? this.thread.live?.startedAt * 1000 : this.activeTurns.get(this.thread?.id)?.startedAt;
    this.setData({elapsed: this.data.running && started ? elapsed((Date.now() - started) / 1000) : ''});
  },
  installItem(item, turnId) {
    if (!item || !item.id) return;
    if (item.type === 'fileChange') { this.changes.set(item.id, item.changes || []); return; }
    let kind = '', text = '';
    if (item.type === 'userMessage') { kind = 'user'; text = (item.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n'); }
    else if (item.type === 'agentMessage') { kind = item.phase === 'commentary' ? 'activity' : 'assistant'; text = item.text || ''; }
    else if (item.type === 'commandExecution' || item.type === 'toolActivity') {
      kind = 'tool'; text = (item.status === 'inProgress' ? '正在执行 · ' : '已执行 · ') + String(item.command || item.text || '本机操作').slice(0, 200);
    } else return;
    const value = {id: item.id, kind, text: text.slice(-12000), turnId};
    let old = this.items.findIndex(i => i.id === item.id);
    if (old < 0 && kind === 'user') old = this.items.findIndex(i => i.optimistic && i.turnId === turnId && i.text === value.text);
    if (old >= 0) this.items[old] = value; else this.items.push(value);
  },
  paint(scroll = false) {
    clearTimeout(this.paintTimer); this.paintTimer = null;
    this.items = this.items.slice(-80);
    const allMessages = this.items.filter(i => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'summary').map(i =>
      ({...i, nodes: i.kind === 'assistant' ? markdown(i.text) : []}));
    const messages = []; let messageBytes = 0;
    for (const message of allMessages.slice().reverse()) {
      messageBytes += utf8Length(JSON.stringify(message));
      if (messageBytes > 320000) break;
      messages.unshift(message);
    }
    const activity = this.items.filter(i => i.kind === 'activity' || i.kind === 'tool').slice(-12);
    const changes = Array.from(this.changes.values()).flat().slice(-32);
    const diff = this.aggregateDiff || changes.map(c => '--- a/' + c.path + '\n+++ b/' + c.path + '\n' + (c.diff || '')).join('\n');
    const summary = diffSummary(diff, changes);
    this.setData({messages, historyNotice: messages.length < allMessages.length || this.thread?.historyTruncated,
      activities: activity, files: summary.files, added: summary.added, removed: summary.removed,
      diffText: diff.slice(0, 48000), ...(scroll ? {scrollTarget: ''} : {})});
    if (scroll && this.follow) this.setData({scrollTarget: 'chat-end'});
  },
  onEvent(message) {
    if (message.id !== undefined && message.method) { this.addApproval(message); return; }
    const p = message.params || {}, method = message.method;
    if (method === 'lanpower/error') { if (p.code === 'controller_busy') this.setState('controller_busy'); this.notify(ERRORS[p.code] || '连接请求被拒绝，请检查电脑状态。'); return; }
    if (method === 'lanpower/approvalError') {
      const request = this.pendingApprovals.get(JSON.stringify(p.id)); if (request) request.submitted = false;
      this.renderApprovals(); this.notify('审批未被接收，请确认最新状态后再处理。'); return;
    }
    if (method === 'serverRequest/resolved') { this.pendingApprovals.delete(JSON.stringify(p.requestId)); this.renderApprovals(); return; }
    if (method === 'turn/started') {
      this.turnRevision++; this.activeTurns.set(p.threadId, {id: p.turn?.id, startedAt: Date.now()});
      if (p.threadId === this.thread?.id) { this.thread.control = 'remote'; this.changes.clear(); this.aggregateDiff = ''; this.setData({plan: [], liveAction: ''}); }
      this.controls(); this.renderLibrary(); return;
    }
    if (method === 'turn/completed') {
      this.turnRevision++; if (this.activeTurns.get(p.threadId)?.id === p.turn?.id) this.activeTurns.delete(p.threadId);
      for (const [id, request] of this.pendingApprovals) if (request.params?.threadId === p.threadId) this.pendingApprovals.delete(id);
      if (p.threadId === this.thread?.id) {
        this.items.push({id: 'summary-' + p.turn?.id, kind: 'summary', text: p.turn?.status === 'interrupted' ? '该轮已暂停' : p.turn?.status === 'failed' ? '任务执行失败' : '已完成'});
        this.paint(true); this.notify(p.turn?.status === 'interrupted' ? '本轮已暂停，可继续发送消息。' : p.turn?.status === 'failed' ? '任务执行失败，请查看电脑上的详情。' : '任务已完成。');
      }
      this.renderApprovals(); this.controls(); this.renderLibrary(); return;
    }
    if (method === 'lanpower/session/released') {
      if (p.threadId === this.thread?.id) this.thread.control = 'available'; this.controls(); return;
    }
    if (p.threadId && p.threadId !== this.thread?.id || !this.thread) return;
    if (method === 'turn/diff/updated') this.aggregateDiff = String(p.diff || '').slice(0, 240000);
    if ((method === 'item/started' || method === 'item/completed') && p.item) this.installItem(p.item, p.turnId);
    if (method === 'item/agentMessage/delta') {
      let item = this.items.find(i => i.id === p.itemId);
      if (!item) { item = {id: p.itemId, kind: 'assistant', text: '', turnId: p.turnId}; this.items.push(item); }
      item.text = (item.text + (p.delta || '')).slice(-12000);
      this.setData({liveAction: 'Codex 正在回复'});
    }
    if (method === 'turn/plan/updated') this.setData({plan: (p.plan || []).slice(0, 20).map(s => ({text: s.step, status: s.status}))});
    if (!this.paintTimer) this.paintTimer = setTimeout(() => { this.paintTimer = null; this.paint(true); }, 120);
  },
  addApproval(request) {
    const key = JSON.stringify(request.id);
    if (!this.pendingApprovals.has(key) && this.pendingApprovals.size < 64) this.pendingApprovals.set(key, {...request, key, submitted: false});
    this.renderApprovals();
  },
  renderApprovals() {
    const approvals = Array.from(this.pendingApprovals.values()).map(r => ({key: r.key, submitted: r.submitted,
      label: r.method.includes('requestUserInput') ? 'Codex 需要你的回答' : r.method.includes('fileChange') ? '确认文件修改' : r.method.includes('permissions') ? '确认权限请求' : r.method.includes('elicitation') ? '工具需要本机确认' : '确认命令执行'}));
    this.setData({approvals});
    if (this.data.approval) {
      const request = this.pendingApprovals.get(this.data.approval.key);
      if (!request) this.setData({sheet: '', approval: null});
      else this.setData({'approval.submitted': request.submitted});
    }
  },
  openApproval(event) {
    const request = this.pendingApprovals.get(event.currentTarget.dataset.key); if (!request) return;
    const p = request.params || {}, method = request.method;
    const kind = method.includes('requestUserInput') ? 'answer' : method.includes('fileChange') ? 'file' : method.includes('permissions') ? 'permission' : method.includes('elicitation') ? 'local' : 'command';
    this.setData({sheet: 'approval', approval: {key: request.key, kind, submitted: request.submitted,
      title: this.data.approvals.find(r => r.key === request.key).label, detail: [p.reason, p.command, p.message, p.cwd, p.grantRoot ? '额外目录：' + p.grantRoot : ''].filter(Boolean).join('\n').slice(0, 12000),
      files: (this.changes.get(p.itemId) || []).map(c => ({path: c.path})),
      network: !!p.permissions?.network?.enabled && !p.permissions?.fileSystem,
      questions: (p.questions || []).slice(0, 20).map(q => ({id: q.id, text: q.question || q.header, secret: !!q.isSecret, value: '', options: (q.options || []).map(o => o.label).join(' / ')}))}});
  },
  answer(event) {
    const index = Number(event.currentTarget.dataset.index); this.setData({['approval.questions[' + index + '].value']: event.detail.value});
  },
  async decide(event) {
    const approval = this.data.approval, request = approval && this.pendingApprovals.get(approval.key);
    if (!request || request.submitted || !this.data.ready) return;
    const allow = event.currentTarget.dataset.allow === 'yes'; let result;
    if (approval.kind === 'answer') {
      if (approval.questions.some(q => !q.value.trim())) { this.notify('请填写每个问题后提交。'); return; }
      result = {answers: Object.fromEntries(approval.questions.map(q => [q.id, {answers: [q.value]}]))};
    } else if (approval.kind === 'permission') result = {permissions: allow && approval.network ? {network: {enabled: true}} : {}, scope: 'turn'};
    else if (approval.kind === 'local') result = {action: 'decline', content: null};
    else result = {decision: allow ? 'accept' : 'decline'};
    request.submitted = true; this.renderApprovals();
    try { await this.connection.decide(request.id, result); }
    catch (error) { request.submitted = false; this.renderApprovals(); this.notify(error.message); }
  },
  openOptions() { this.setData({sheet: 'options'}); },
  openMenu() { this.setData({sheet: 'menu'}); },
  closeSheet() { this.setData({sheet: '', approval: null}); },
  noop() {},
  toggleProgress() { this.setData({progressOpen: !this.data.progressOpen}); },
  toggleDiff() { this.setData({diffOpen: !this.data.diffOpen}); },
  copy() {
    const text = this.items.filter(i => i.kind === 'assistant').map(i => i.text).pop();
    if (text) wx.setClipboardData({data: text, success: () => this.notify('已复制最新回复。')});
    this.setData({sheet: ''});
  }
});
