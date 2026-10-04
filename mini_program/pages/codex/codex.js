const {CloudClient} = require('../../utils/cloud');
const {storageKey} = require('../../utils/environment');
const {CodexConnection, STATES} = require('../../utils/codex-remote');
const {VERSION} = require('../../utils/version');
const {CodexController} = require('../../utils/codex/controller');
const {modelId, effectiveSettings, validEfforts} = require('../../utils/codex/model');
const {previewText, changesSummary} = require('../../utils/codex/conversation');
const {permissionOptions, permissionLabels, permissionMode} = require('../../utils/codex/permissions');
const {ImageCache} = require('../../utils/codex/resources');
const {capabilityStatus} = require('../../utils/codex/native-status');
const {projectName} = require('../../utils/codex-format');
const {homePreferences, homeLibrary, quotaSummary} = require('../../utils/codex/home');
const HOME_KEY = 'lanpower_codex_home';
const THEME_KEY = 'lanpower_codex_theme_v1', INPUT_KEY = 'lanpower_codex_input_v2', CACHE_KEY = 'lanpower_device_cache_v2';
const dataOf = event => event.currentTarget.dataset;
const modal = options => new Promise(resolve => wx.showModal({...options, success: result => resolve(!!result.confirm), fail: () => resolve(false)}));
const effortNames = {none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: 'Max', ultra: 'Ultra'};
const modelName = row => (row && (row.displayName || modelId(row)) || '').replace(/^gpt-/i, '').replace(/-(sol|astra|luna)$/i, (_, name) => ' ' + name[0].toUpperCase() + name.slice(1));

Page({
  data: {version: VERSION, theme: 'light', themeMode: 'system', authorized: false, view: 'library', sheet: '', devices: [], deviceId: '', deviceName: '选择开发电脑', deviceIndex: 0,
    state: 'idle', stateTitle: '选择开发电脑', stateHint: '选择电脑后读取原窗口的项目和聊天', ready: false, recovering: false, loading: false, busy: false, feedback: '',
    search: '', searchOpen: false, homeMenu: false, homeOrder: 'project', recentFirst: true, libraryFilter: 'all', recent: [], recentTotal: 0, recentCollapsed: false, recentTimeline: false, recentHasPrevious: false, recentHasNext: false, quotaSummary: [], groups: [], chats: [], pinned: [], hiddenProjects: [], hasMore: false, archived: false, chatSupported: false, projects: [], libraryHasPrevious: false, libraryHasNext: false, chatsFirst: false, sections: {}, sort: 'updated',
    title: '新聊天', project: '', cwd: '', messages: [], totalMessages: 0, windowStart: 0, windowEnd: 0, hasWindowBefore: false, hasWindowAfter: false, historyCursor: '', readingHistory: false, historyProgress: '', historyResume: false, beginningIndex: -1,
    prompt: '', draftImages: [], draftSkills: [], draftFiles: [], canSend: false, canControl: false, canInterrupt: false, canRelease: false, activeTurnId: '', running: false, interrupting: false, sendLabel: '发送', sendMode: 'queue', queueSupported: false,
    selectedModel: '', selectedModelName: '', selectedEffort: '', selectedEffortName: '', selectedMode: 'default', models: [], efforts: [], effortChoices: [], effortIndex: -1, effortPercent: 0, planSupported: false, settingsHint: '', taskState: '', syncLabel: '', controlHint: '', elapsed: '', plan: [], progressOpen: false,
    selectedPermission: 'unknown', permissionLabel: '批准状态待确认', permissionChoices: permissionOptions, permissionsSupported: false, changingPermissions: false, contextPercent: null,
    inputFocused: false, uploadingAttachment: false, changes: {count: 0, added: 0, removed: 0, files: []}, changesPage: 1, changesPages: 1,
    receiptState: '', receiptLabel: '', queryingReceipt: false, queue: [], editingQueue: '', approvals: [], approval: null, responding: false, keyboardHeight: 0, scrollTarget: '', showJump: false,
    renameTitle: '', renameDraft: '', newProjects: [], newProjectQuery: '', projectMenu: null, threadMenuPinned: false,
    catalogKind: 'skill', catalogQuery: '', catalogRows: [], catalogLoading: false, catalogError: '', catalogHasMore: false, catalogCwdIndex: 0, catalogPage: 1, catalogHasPrevious: false,
    quotaRows: [], quotaLoading: false, quotaReason: '连接电脑后读取原生额度。', contextText: '', contextReason: '尚未收到原生用量通知。',
    fileState: {files: [], cwd: '', directory: '.', cursor: '', selected: null, breadcrumbs: []}, fileHasPrevious: false, fileHasNext: false,
    detailTitle: '', detailText: '', detailPage: 1, detailPages: 1, detailKind: '', sendWithEnter: false, wakeAvailable: false, powerText: '', waking: false},
  onLoad(options = {}) {
    this.visible = false; this.unloaded = false; this.follow = true; this.imagePaths = new Map(); this.libraryOffset = 0; this.groupOffsets = {}; this.chatOffset = 0; this.recentOffset = 0; this.catalogLimit = 30; this.fileOffset = 0;
    this.preferredDevice = options.computer || ''; this.systemTheme = (wx.getAppBaseInfo && wx.getAppBaseInfo().theme) || 'light';
    this.installClient(CloudClient.load(wx));
    this.themeChanged = ({theme}) => { this.systemTheme = theme; if (this.data.themeMode === 'system') this.applyTheme(); };
    this.networkChanged = ({isConnected}) => { if (this.visible && isConnected && this.connection && !this.connection.opened && !['update_required', 'revoked', 'forbidden', 'reauthorize'].includes(this.controller.state)) this.reconnect(); };
    if (wx.onThemeChange) wx.onThemeChange(this.themeChanged); if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(this.networkChanged);
    this.applyTheme(); this.paint();
  },
  installClient(client) {
    if (this.controller) this.controller.dispose(); if (this.images) this.images.clear(); if (this.client) this.client.close();
    this.client = client; this.imagePaths.clear(); this.deviceLoading = false; this.themeKey = storageKey(wx, THEME_KEY); this.inputKey = storageKey(wx, INPUT_KEY);
    const input = wx.getStorageSync(this.inputKey) || {}; this.themeMode = wx.getStorageSync(this.themeKey) || 'system';
    this.setData({authorized: !!client, devices: [], deviceId: '', deviceName: '选择开发电脑', view: 'library', sheet: '', homeMenu: false, search: '', searchOpen: false, libraryFilter: 'all', prompt: '', messages: [], draftImages: [], draftSkills: [], draftFiles: [],
      themeMode: ['light', 'dark', 'system'].includes(this.themeMode) ? this.themeMode : 'system', sendMode: input.mode === 'steer' ? 'steer' : 'queue', sendWithEnter: !!input.enter});
    this.loadHomePreferences();
    this.connection = new CodexConnection({wxApi: wx, cloud: client, state: state => { this.controller.onState(state); if (state !== 'runtime_ready') { this.images.clear(); this.imagePaths.clear(); } }, event: event => this.controller.onEvent(event)});
    this.controller = new CodexController(this.connection, () => this.schedulePaint()); this.images = new ImageCache(wx, this.connection);
  },
  onShow() {
    this.visible = true; this.clearTimers();
    const latest = CloudClient.load(wx);
    if (!latest || !this.client || latest.storageKey !== this.client.storageKey || latest.session.client_id !== this.client.session.client_id) { this.installClient(latest); this.applyTheme(); }
    else this.client.session = latest.session;
    if (this.client) void this.loadDevices();
    this.poll = setInterval(() => { if (!this.visible || !this.controller.ready) return; void this.controller.refreshCurrent(); void this.controller.refreshStatus(); void this.controller.loadThreads(); void this.controller.queryReceipt(); void this.loadDevices(false); }, 30000);
    this.clockTimer = setInterval(() => { if (this.visible && this.controller.activeTurn) this.setData({elapsed: this.controller.duration()}); }, 1000);
    this.paint();
  },
  clearTimers() { clearInterval(this.poll); clearInterval(this.clockTimer); clearTimeout(this.paintTimer); clearTimeout(this.searchTimer); clearTimeout(this.librarySearchTimer); },
  onHide() { this.visible = false; this.clearTimers(); this.controller.onState('disconnected'); this.connection.stop(); this.images.clear(); this.imagePaths.clear(); this.setData({keyboardHeight: 0, sheet: '', homeMenu: false}); this.paint(); },
  onUnload() { this.onHide(); this.unloaded = true; this.controller.dispose(); if (this.client) this.client.close(); if (wx.offThemeChange) wx.offThemeChange(this.themeChanged); if (wx.offNetworkStatusChange) wx.offNetworkStatusChange(this.networkChanged); this.detailText = ''; this.setData({detailText: '', messages: [], prompt: '', draftImages: [], draftSkills: [], draftFiles: []}); },
  schedulePaint() { if (this.unloaded || this.paintTimer) return; this.paintTimer = setTimeout(() => { this.paintTimer = null; if (!this.unloaded) this.paint(); }, 70); },
  paint() {
    const c = this.controller; if (!c) return;
    const labels = STATES[c.state] || STATES.disconnected, library = c.libraryView(this.data.search), prefs = c.library.preferences;
    const rows = threads => threads.map(thread => ({id: thread.id, name: previewText(thread.name, 100), time: thread.time, running: !!thread.running, pending: Array.from(c.approvals.values()).some(request => request.params.threadId === thread.id), selected: thread.id === c.threadId}));
    const home = homeLibrary(library, {order: this.data.homeOrder}, this.data.libraryFilter, Array.from(c.approvals.values()).map(request => request.params.threadId), prefs.pinned);
    const groups = home.groups.slice(this.libraryOffset, this.libraryOffset + 12).map(group => { const offset = this.groupOffsets[group.id] || 0; return {...group, threads: rows(group.threads.slice(offset, offset + 10)), count: group.threads.length, hasPrevious: offset > 0, hasNext: offset + 10 < group.threads.length}; });
    const recentSize = home.timeline ? 15 : 6;
    this.recentOffset = home.timeline ? Math.min(this.recentOffset, Math.max(0, Math.ceil(home.recent.length / recentSize) - 1) * recentSize) : 0;
    const options = effectiveSettings(c.threadSettings), model = c.models.find(row => modelId(row) === options.model), draft = c.draft, receipt = c.receipt;
    const efforts = validEfforts(model), effortIndex = efforts.indexOf(options.effort), permission = c.ready ? permissionMode(c.threadSettings.permissions, c.current && c.current.cwd || '') : 'unknown';
    const usage = c.nativeUsage.context(c.threadId).usage, changes = changesSummary(c.current);
    const changesPages = Math.max(1, Math.ceil(changes.files.length / 40)); this.changeOffset = Math.min(this.changeOffset || 0, (changesPages - 1) * 40);
    const messages = c.messages((key, index) => this.imagePaths.get(key + ':img:' + index) || '');
    const queue = c.queue.map((entry, index) => { const value = require('../../utils/codex/conversation').userContent(entry.input); return {id: entry.id, text: previewText(value.text, 800), images: value.images.length, skills: value.skills.map(skill => skill.name).join(' · '), position: index + 1}; });
    const approvals = c.selectedApprovals.map(request => ({key: JSON.stringify(request.id), title: c.approvalView(JSON.stringify(request.id)).title}));
    let sheet = this.data.sheet, approval = sheet === 'approval' ? c.approvalView(this.approvalKey) : null;
    if (sheet === 'approval' && !approval) sheet = '';
    const canSend = c.canControl && !c.busy && !c.sendBlocked && !c.changingPermissions && !this.data.uploadingAttachment && !approvals.length && !!(draft.text.trim() || draft.images.length || draft.skills.length || draft.files.length);
    const value = {ready: c.ready, state: c.state, stateTitle: labels[0], stateHint: labels[1], recovering: c.recovering, loading: c.loadingLibrary || c.loadingThread, busy: c.busy, feedback: c.feedback,
      recent: rows(home.recent.slice(this.recentOffset, this.recentOffset + recentSize)), recentTotal: home.recent.length, recentTimeline: home.timeline, recentHasPrevious: this.recentOffset > 0, recentHasNext: this.recentOffset + recentSize < home.recent.length,
      quotaSummary: quotaSummary(c.nativeUsage.state.snapshots),
      quotaLoading: c.nativeUsage.state.loading, quotaReason: c.nativeUsage.state.reason,
      quotaRows: c.nativeUsage.state.snapshots.map(row => ({id:row.limitId || row.limitName || 'default',name:row.limitName || row.limitId || '额度',metrics:[row.primary,row.secondary].filter(Boolean).map(window => `${window.windowDurationMins ? window.windowDurationMins % 60 === 0 ? window.windowDurationMins / 60 + ' 小时' : window.windowDurationMins + ' 分钟' : '原生窗口'} · ${Math.max(0,Math.min(100,Math.round(100 - window.usedPercent)))}% 剩余${window.resetsAt ? ' · 重置 ' + new Date(window.resetsAt * 1000).toLocaleString('zh-CN') : ''}`).join('\n'),credits:row.credits ? row.credits.unlimited ? '无限积分' : row.credits.balance ? '积分 ' + row.credits.balance : row.credits.hasCredits ? '有积分' : '原生状态：无积分' : ''})),
      contextText: (() => { const usage = c.nativeUsage.context(c.threadId).usage; return usage ? `当前 ${usage.currentContextTokens}${usage.modelContextWindow ? ' / ' + usage.modelContextWindow : ''} tokens${usage.remainingContextPercent !== null ? ' · ' + usage.remainingContextPercent + '% 剩余' : ''} · 累计 ${usage.total.totalTokens} tokens` : ''; })(),
      contextReason: c.nativeUsage.context(c.threadId).reason,
      groups, chats: rows(library.chats.slice(this.chatOffset, this.chatOffset + 15)), chatsHasPrevious: this.chatOffset > 0, chatsHasNext: this.chatOffset + 15 < library.chats.length, pinned: rows(library.pinned.slice(0, 30)), hiddenProjects: library.hidden.map(group => ({id: group.id, name: group.name})),
      libraryHasPrevious: this.libraryOffset > 0, libraryHasNext: this.libraryOffset + 12 < home.groups.length, archived: c.archived, threadArchived: c.threadArchived, hasMore: !!c.listCursor, chatSupported: c.chatSupported, chatsFirst: !!prefs.chatsFirst, sections: prefs.sections, sort: prefs.sort,
      projects: c.projects.filter(project => project.kind !== 'chat').map(project => ({name: project.name, path: project.path})), title: previewText(c.current && (c.current.name || c.current.preview) || '新聊天', 100), project: projectName(c.current && c.current.cwd), cwd: c.current && c.current.cwd || '',
      ...messages, historyCursor: c.historyCursor, readingHistory: c.readingHistory, historyProgress: c.historyProgress, historyResume: c.historyResume, beginningIndex: c.beginningIndex,
      prompt: draft.text, draftImages: draft.images.map((image, index) => ({src: image.src || '', index})), draftSkills: draft.skills.map((skill, index) => ({name: skill.name, index})), draftFiles: draft.files.map((file, index) => ({label: file.label, index})), editingQueue: draft.editingQueue,
      canControl: c.canControl, canSend, canInterrupt: c.canControl && !!c.activeTurn && !c.interrupting, canRelease: c.canControl && !c.sharedControl && c.handoff && !c.activeTurn, activeTurnId: c.activeTurn, running: !!c.activeTurn, interrupting: c.interrupting,
      sendLabel: draft.editingQueue ? '保存修改' : c.activeTurn ? this.data.sendMode === 'queue' && c.queueSupported ? '加入队列' : '引导任务' : '发送', queueSupported: c.queueSupported,
      selectedModel: options.model, selectedModelName: modelName(model) || options.model || '原窗口模型', selectedEffort: options.effort, selectedEffortName: effortNames[options.effort] || options.effort || '默认', selectedMode: options.mode,
      models: c.models.map(row => ({value: modelId(row), name: modelName(row), description: row.description || ''})), efforts, effortIndex, effortPercent: effortIndex < 0 || efforts.length < 2 ? 0 : effortIndex / (efforts.length - 1) * 100,
      effortChoices: efforts.map((value, index) => ({value, index, name: effortNames[value] || value})), planSupported: c.planSupported,
      selectedPermission: permission, permissionLabel: permissionLabels[permission], permissionsSupported: c.permissionsSupported, changingPermissions: c.changingPermissions,
      contextPercent: usage && Number.isFinite(usage.remainingContextPercent) ? Math.max(0, Math.min(100, usage.remainingContextPercent)) : null,
      changes: {...changes, files: changes.files.slice(this.changeOffset, this.changeOffset + 40).map((file, index) => ({path: file.path, kind: file.kind, added: file.added, removed: file.removed, index: this.changeOffset + index}))}, changesPages, changesPage: this.changeOffset / 40 + 1,
      settingsHint: Object.keys(c.threadSettings.overrides).length ? '已选择下次新任务参数；排队和引导沿用当前任务。' : '', taskState: c.liveLabel(), elapsed: c.duration(), plan: c.overlay.plan,
      syncLabel: c.recovering || c.loadingThread ? '正在恢复原窗口状态' : !c.ready ? '显示历史缓存' : c.syncFailed ? '同步未完成 · 显示缓存' : c.lastSync ? '最近同步 ' + new Date(c.lastSync).toLocaleTimeString('zh-CN', {hour12: false}) : '',
      controlHint: c.threadArchived ? '已归档，恢复后可继续' : c.canControl ? c.desktopControl ? '原 Codex 窗口' : c.sharedControl ? '备用共享窗口' : '本机 Codex' : c.current && c.current.control === 'desktop' && !c.sharedControl ? '桌面占用 · 只读' : '',
      receiptState: receipt && receipt.state || '', receiptLabel: receipt ? {sending: '正在等待电脑回执', accepted: '原窗口已接受', failed: '发送失败，输入已恢复', uncertain: '发送结果待确认，请先查询回执'}[receipt.state] : '', queryingReceipt: c.queryingReceipt,
      queue, approvals, approval, responding: c.responding, sheet};
    // Separate visible history from chrome, keeping each native bridge update comfortably below 1 MiB.
    const messagePatch = {messages: value.messages}; delete value.messages;
    this.setData(messagePatch); this.setData(value);
    this.paintResources();
    if (this.follow && this.data.view === 'chat' && c.beginningIndex < 0) this.scrollLatest();
  },
  paintResources() {
    const resource = this.controller.resources;
    if (this.data.view === 'files' || this.data.sheet === 'files') {
      const state = resource.fileView(), all = state.files; state.files = all.slice(this.fileOffset, this.fileOffset + 50);
      this.setData({fileState: state, fileProject: projectName(state.cwd), fileHasPrevious: this.fileOffset > 0, fileHasNext: this.fileOffset + 50 < all.length});
    }
    if (['catalog', 'automations'].includes(this.data.view)) {
      const query = this.data.catalogQuery.trim().toLowerCase(), catalog = resource.catalog, all = catalog.rows.filter(row => [row.name, row.displayName, row.description].join(' ').toLowerCase().includes(query));
      this.setData({catalogRows: all.map(row => ({index: catalog.rows.indexOf(row), key: row.path || row.id || row.name, name: row.displayName || row.interface && row.interface.displayName || row.name || row.id,
        description: previewText(row.description || row.interface && row.interface.shortDescription || '', 260), path: row.path || '', enabled: row.enabled === true,
        badge: catalog.kind === 'automations' ? row.status === 'PAUSED' ? '已暂停' : '启用中' : capabilityStatus(catalog.kind,row).label,
        status: catalog.kind === 'automations' ? '' : capabilityStatus(catalog.kind,row).state, reason: catalog.kind === 'automations' ? '' : capabilityStatus(catalog.kind,row).reason,
        schedule: catalog.kind === 'automations' ? row.rrule || '' : '', projects: (row.cwds || []).map(projectName).join(' · ')})), catalogHasMore: !!catalog.nextCursor, catalogHasPrevious: catalog.page > 1, catalogPage: catalog.page, catalogLoading: catalog.loading, catalogError: catalog.error});
    }
  },
  async loadDevices(connect = true) {
    if (!this.client || this.deviceLoading) return; const client = this.client; this.deviceLoading = true;
    try {
      const list = await client.call('/api/v2/devices'); if (client !== this.client || !this.visible) return;
      const devices = (list || []).filter(device => device.device_type === 'windows').map(device => ({device_id: device.device_id, name: device.name || '开发电脑', state: device.state || '', wake_available: !!device.wake_available}));
      this.setData({devices}); const selected = devices.find(device => device.device_id === this.controller.deviceId);
      if (connect && !selected) this.chooseDevice(devices.find(device => device.device_id === this.preferredDevice) || devices[0]);
      else if (connect && selected && !this.connection.opened) this.reconnect();
      if (selected) this.showDevice(selected); else if (!devices.length && this.controller.deviceId) this.chooseDevice();
    } catch (failure) { if (client === this.client) { if (['REAUTHORIZE', 'CLOUD_CHANGED'].includes(failure.code)) { this.controller.onState('reauthorize'); this.connection.stop(); this.images.clear(); } this.controller.notify(failure.message); } }
    finally { if (client === this.client) this.deviceLoading = false; }
  },
  showDevice(device) { this.setData({deviceId: device.device_id, deviceName: device.name, deviceIndex: Math.max(0, this.data.devices.findIndex(row => row.device_id === device.device_id)), wakeAvailable: device.wake_available, powerText: ({online: 'Windows 在线', offline: 'Windows 离线', transitioning: '正在执行电源操作'})[device.state] || '电脑状态未知'}); },
  chooseDevice(device) { this.detailText = ''; this.detailIndex = 0; this.images.clear(); this.imagePaths.clear(); this.libraryOffset = 0; this.groupOffsets = {}; this.chatOffset = 0; clearTimeout(this.librarySearchTimer); this.controller.chooseDevice(device ? device.device_id : ''); this.setData({view: 'library', sheet: '', homeMenu: false, search: '', searchOpen: false, libraryFilter: 'all', detailText: '', approval: null, keyboardHeight: 0, deviceId: device ? device.device_id : '', deviceName: device ? device.name : '选择开发电脑', wakeAvailable: false}); this.loadHomePreferences(); if (device) this.showDevice(device); this.paint(); },
  selectDevice(event) { this.chooseDevice(this.data.devices[Number(event.detail.value)]); },
  reconnect() { if (this.controller.deviceId) this.connection.connect(this.controller.deviceId); },
  async wake() { if (!this.client || this.data.waking) return; const client = this.client, id = this.controller.deviceId; this.setData({waking: true}); try { await client.call(`/api/v2/devices/${encodeURIComponent(id)}/commands`, 'POST', {action: 'wake'}); if (client === this.client && id === this.controller.deviceId) this.controller.notify('唤醒请求已发送，电脑登录后会自动连接。'); } catch (error) { this.controller.notify(error.message); } finally { this.setData({waking: false}); } },
  navigate(event) { const page = dataOf(event).page; if (page === 'codex') return; wx.redirectTo({url: page === 'lan' ? '/pages/index/index' : '/pages/cloud/cloud?tab=' + page}); },
  back() { this.setData({view: this.auxReturn || 'library', sheet: '', keyboardHeight: 0}); this.auxReturn = ''; this.paint(); },
  backLibrary() { this.setData({view: 'library', sheet: '', keyboardHeight: 0}); this.paint(); },
  async selectThread(event) { this.follow = true; this.changeOffset = 0; this.setData({view: 'chat', sheet: '', progressOpen: false, inputFocused: false}); await this.controller.selectThread(dataOf(event).id); this.paint(); },
  readThread(id, navigate = true) { if (navigate) this.setData({view: 'chat'}); return this.controller.selectThread(id); },
  search(event) { this.setData({search: event.detail.value}); this.libraryOffset = 0; this.chatOffset = 0; this.recentOffset = 0; clearTimeout(this.librarySearchTimer); this.librarySearchTimer = setTimeout(() => this.controller.searchLibrary(this.data.search),250); this.paint(); },
  toggleSearch() { const open = !this.data.searchOpen; this.setData({searchOpen: open, homeMenu: false, keyboardHeight: 0}); if (!open) { if (wx.hideKeyboard) wx.hideKeyboard(); this.search({detail: {value: ''}}); } },
  toggleHomeMenu() { const open = !this.data.homeMenu; if (wx.hideKeyboard) wx.hideKeyboard(); this.setData({homeMenu: open, sheet: '', keyboardHeight: 0}); if (open && this.controller.ready && !this.data.quotaSummary.length) void this.refreshQuota(); },
  closeHomeMenu() { this.setData({homeMenu: false}); },
  loadHomePreferences() { this.homeKey = storageKey(wx, HOME_KEY) + ':computer:' + encodeURIComponent(this.data.deviceId || ''); const prefs = homePreferences(wx.getStorageSync(this.homeKey)); this.recentOffset = 0; this.setData({homeOrder: prefs.order, recentFirst: prefs.recentFirst, recentCollapsed: false}); },
  saveHomePreferences() { wx.setStorageSync(this.homeKey, {order: this.data.homeOrder, recentFirst: this.data.recentFirst}); },
  chooseHomeOrder(event) { const order = dataOf(event).order; if (!['project', 'updated', 'priority'].includes(order)) return; this.recentOffset = 0; this.libraryOffset = 0; this.setData({homeOrder: order, homeMenu: false, recentCollapsed: false}); this.saveHomePreferences(); this.paint(); },
  setRecentFirst(event) { this.setData({recentFirst: !!event.detail.value}); this.saveHomePreferences(); this.paint(); },
  toggleRecentFirst() { this.setRecentFirst({detail: {value: !this.data.recentFirst}}); this.closeHomeMenu(); },
  toggleRecent() { this.setData({recentCollapsed: !this.data.recentCollapsed}); },
  filterLibrary(event) { const filter = dataOf(event).filter === 'chats' ? 'chats' : 'all'; this.recentOffset = 0; this.libraryOffset = 0; this.setData({libraryFilter: filter, recentCollapsed: false, homeMenu: false}); this.paint(); },
  showAllRecent() { this.chooseHomeOrder({currentTarget: {dataset: {order: 'updated'}}}); },
  recentPage(event) { this.recentOffset = Math.max(0, this.recentOffset + Number(dataOf(event).direction) * 15); this.paint(); },
  more() { return this.controller.loadThreads(true); },
  async toggleArchived() { this.closeHomeMenu(); await this.controller.toggleArchived(); this.libraryOffset = 0; this.chatOffset = 0; this.recentOffset = 0; this.paint(); },
  libraryPage(event) { this.libraryOffset = Math.max(0, this.libraryOffset + Number(dataOf(event).direction) * 12); this.paint(); },
  groupPage(event) { const {id, direction} = dataOf(event); this.groupOffsets[id] = Math.max(0, (this.groupOffsets[id] || 0) + Number(direction) * 10); this.paint(); },
  chatsPage(event) { this.chatOffset = Math.max(0, this.chatOffset + Number(dataOf(event).direction) * 15); this.paint(); },
  toggleProject(event) { this.controller.changeLibrary('collapsed', dataOf(event).id); },
  toggleSection(event) { this.controller.changeLibrary('section', dataOf(event).id); },
  openNew() { if (!this.controller.ready || this.controller.busy) return; this.setData({sheet: 'new', homeMenu: false, newProjectQuery: '', newProjects: this.data.projects}); },
  newProjectSearch(event) { const query = event.detail.value.toLowerCase(); this.setData({newProjectQuery: event.detail.value, newProjects: this.data.projects.filter(project => [project.name, project.path].join(' ').toLowerCase().includes(query))}); },
  async createThread(event) { const id = await this.controller.createThread(dataOf(event).path, false, this.data.selectedModel); if (id) { this.follow = true; this.setData({view: 'chat', sheet: ''}); this.paint(); } },
  async newChat() { const id = await this.controller.createThread('', true, this.data.selectedModel); if (id) { this.follow = true; this.setData({view: 'chat', sheet: ''}); this.paint(); } },
  input(event) { this.controller.input(event.detail.value); },
  inputFocus() { this.setData({inputFocused: true}); },
  inputBlur() { this.setData({inputFocused: false}); },
  keyboard(event) { this.setData({keyboardHeight: Math.max(0, Number(event.detail.height) || 0)}); },
  confirmSend(event) { if (this.data.sendWithEnter) { if (event.detail.value !== undefined) this.controller.input(event.detail.value); void this.send(); } },
  async send() { if (this.data.uploadingAttachment) return; this.follow = true; await this.controller.submit(this.controller.queueSupported ? this.data.sendMode : 'steer'); this.paint(); },
  interrupt() { return this.controller.interrupt(); },
  chooseSendMode(event) { const mode = dataOf(event).mode; this.setData({sendMode: mode === 'steer' ? 'steer' : 'queue'}); this.saveInputPreferences(); this.paint(); },
  chooseSetting(event) { const {key, value} = dataOf(event); this.controller.chooseSetting(key, value); this.paint(); },
  inheritSettings() { this.controller.inheritSettings(); this.paint(); },
  openOptions() { this.setData({sheet: 'options'}); },
  openOptionList(event) { const kind = dataOf(event).kind; if (['models', 'effort'].includes(kind)) this.setData({sheet: kind}); },
  chooseModel(event) { this.controller.chooseSetting('model', dataOf(event).value); this.setData({sheet: 'options'}); this.paint(); },
  chooseEffort(event) { const value = dataOf(event).value; if (this.data.efforts.includes(value)) this.controller.chooseSetting('effort', value); this.paint(); },
  optionBack() { this.setData({sheet: 'options'}); },
  openPermissions() { this.setData({sheet: 'permissions'}); this.paint(); },
  permissionHelp() { this.showDetail('批准 Codex 操作', '请求批准：编辑项目外的文件和访问互联网前询问你。\n\n替我批准：由电脑上的自动审核评估请求，需要你处理时显示审批。\n\n完全访问：允许 Codex 完全访问计算机，请确认你信任当前任务。\n\n自定义：在电脑的 config.toml 中管理。\n\n这里显示电脑确认的实际权限。更改用于后续任务，运行中的任务和已有审批保留原设置。'); },
  async choosePermission(event) {
    const mode = dataOf(event).value, c = this.controller, key = c.key;
    if (mode === 'custom') { c.notify('自定义权限请在电脑配置后刷新聊天。'); return; }
    if (mode === this.data.selectedPermission || !c.permissionsSupported || !c.canControl || c.changingPermissions) return;
    if (mode === 'full-access' && !await modal({title: '允许完全访问？', content: 'Codex 将能访问项目外的文件和网络。仅在信任当前任务时开启。', confirmText: '允许'})) return;
    if (key !== c.key) return;
    await c.changePermissions(mode); this.paint();
  },
  openStatus() { this.setData({sheet: 'status'}); this.paint(); },
  copyThreadId() { this.copyText(this.controller.threadId); this.closeSheet(); },
  openChanges() { this.changeOffset = 0; this.setData({sheet: 'changes'}); this.paint(); },
  changesPage(event) { this.changeOffset = Math.max(0, (this.changeOffset || 0) + Number(dataOf(event).direction) * 40); this.paint(); },
  showChange(event) { const file = changesSummary(this.controller.current).files[Number(dataOf(event).index)]; if (file) this.showDetail(file.path, file.diff || '此文件未提供差异内容。', 'code'); },
  async openMenu(event) { const id = event && dataOf(event).id; if (id && id !== this.controller.threadId) await this.controller.selectThread(id); if (!this.controller.current) return; this.setData({sheet: 'menu', threadMenuPinned: this.controller.library.preferences.pinned.includes(this.controller.threadId)}); this.paint(); },
  openProjectMenu(event) { const group = this.controller.libraryView('').projects.find(row => row.id === dataOf(event).id); if (group) this.setData({sheet: 'project', projectMenu: {id: group.id, name: group.name, path: group.path}}); },
  projectAction(event) { const {action} = dataOf(event), project = this.data.projectMenu; if (!project) return; if (action === 'new') return this.createThread({currentTarget: {dataset: {path: project.path}}}); if (action === 'files') return this.openFiles({currentTarget: {dataset: {cwd: project.path}}}); if (action === 'rename') { this.renameTarget = {kind: 'project', id: project.id}; this.setData({sheet: 'rename', renameTitle: '项目显示名', renameDraft: project.name}); return; } this.controller.changeLibrary(action === 'up' || action === 'down' ? 'move' : 'hidden', project.id, action === 'up' ? -1 : 1); this.closeSheet(); },
  async threadAction(event) {
    const {action, turn} = dataOf(event), c = this.controller, key = c.key;
    if (action === 'pin') { c.changeLibrary('pinned', c.threadId); this.closeSheet(); return; }
    if (action === 'rename') { this.renameTarget = {kind: 'thread', key}; this.setData({sheet: 'rename', renameTitle: '重命名聊天', renameDraft: c.current && (c.current.name || c.current.preview) || ''}); return; }
    if (action === 'beginning') { this.closeSheet(); this.follow = false; this.setData({view: 'chat'}); await c.jumpToBeginning(); return; }
    if (action === 'refresh') { this.closeSheet(); return c.refreshCurrent(); }
    if (action === 'archive' && !await modal({title: '归档聊天', content: '归档后仍可在已归档中查看和恢复。', confirmText: '归档'})) return;
    if (action === 'rollback' && !await modal({title: '回退对话', content: '移除此轮及后续对话，已经修改的文件会保留。', confirmText: '回退'})) return;
    if (key !== c.key) return; this.closeSheet(); await c.threadAction(action, turn);
    if (!c.threadId) this.setData({view: 'library'}); else if (action === 'fork') this.setData({view: 'chat'}); this.paint();
  },
  renameInput(event) { this.setData({renameDraft: event.detail.value}); },
  async saveRename() { const target = this.renameTarget, name = this.data.renameDraft.trim(); if (!target || !name) return; if (target.kind === 'project') this.controller.changeLibrary('alias', target.id, name); else if (target.key === this.controller.key) await this.controller.threadAction('rename', name); this.closeSheet(); this.paint(); },
  async editQueue(event) { const key = this.controller.key, id = dataOf(event).id, draft = this.controller.draft; if ((draft.text || draft.images.length || draft.skills.length || draft.files.length) && !await modal({title: '编辑排队消息', content: '用这条排队消息替换当前未发送的输入？', confirmText: '替换'})) return; if (key === this.controller.key) this.controller.editQueue(id); this.paint(); },
  cancelQueueEdit() { this.controller.cancelQueueEdit(); this.paint(); },
  queueAction(event) { const {action, id, direction} = dataOf(event); return this.controller.queueAction(action, id, Number(direction)); },
  queryReceipt() { return this.controller.queryReceipt(); },
  async restoreUnaccepted() { const key = this.controller.key; if (await modal({title: '确认提交未执行', content: '请先检查原窗口的消息、任务和队列。只有确认这条消息未被执行，才恢复输入；再次发送会产生新提交。', confirmText: '确认未执行'}) && key === this.controller.key) this.controller.restoreUnaccepted(); },
  openApproval(event) { this.approvalKey = dataOf(event).key; this.setData({sheet: 'approval'}); this.paint(); },
  answer(event) { this.controller.answer(this.approvalKey, dataOf(event).id, event.detail.value); this.paint(); },
  answerOption(event) { this.controller.answer(this.approvalKey, dataOf(event).id, undefined, Number(dataOf(event).index)); this.paint(); },
  decide(event) { return this.controller.decide(this.approvalKey, dataOf(event).allow === 'yes'); },
  closeSheet() { this.setData({sheet: '', approval: null}); },
  noop() {},
  dismissFeedback() { this.controller.notify(''); },
  toggleProgress() { this.setData({progressOpen: !this.data.progressOpen}); },
  toggleRow(event) { this.controller.toggleRow(dataOf(event).key, dataOf(event).turn); this.paint(); },
  chatScroll(event) { const detail = event.detail || {}; if (this.lastScrollTop !== undefined && detail.scrollTop < this.lastScrollTop - 8) { this.follow = false; this.setData({showJump: true}); } this.lastScrollTop = detail.scrollTop; },
  reachedBottom() { if (this.controller.windowOffset === null && this.controller.beginningIndex < 0) { this.follow = true; this.setData({showJump: false}); } },
  scrollLatest() { this.setData({scrollTarget: ''}); this.setData({scrollTarget: 'chat-end', showJump: false}); },
  async jump() { this.follow = true; if (this.controller.beginningIndex >= 0) await this.controller.latest(); else { this.controller.windowOffset = null; this.controller.emit(); } this.paint(); this.scrollLatest(); },
  async earlier() { this.follow = false; await this.controller.earlier(); this.paint(); this.setData({scrollTarget: this.data.messages[0] && this.data.messages[0].domId || ''}); },
  later() { this.controller.laterWindow(); this.paint(); },
  loadLater() { return this.controller.loadLater(); },
  cancelHistory() { this.controller.cancelHistory(); },
  resumeHistory() { return this.controller.jumpToBeginning(); },
  retryContent() { return this.controller.retryContent(); },
  openDetail(event) { const row = this.controller.rows.find(value => value.key === dataOf(event).key); if (row) this.showDetail(row.label || (row.kind === 'assistant' ? '完整回复' : '消息详情'), (row.command ? row.command + '\n\n' : '') + row.text, row.kind); },
  showDetail(title, text, kind = '') { this.detailText = String(text || ''); this.detailIndex = 0; this.setData({sheet: 'detail', detailTitle: title, detailKind: kind}); this.paintDetail(); },
  paintDetail() { const pages = Math.max(1, Math.ceil(this.detailText.length / 6000)); this.detailIndex = Math.max(0, Math.min(this.detailIndex, pages - 1)); let start = this.detailIndex * 6000, end = (this.detailIndex + 1) * 6000; if (/[\uDC00-\uDFFF]/.test(this.detailText[start] || '')) start--; if (/[\uDC00-\uDFFF]/.test(this.detailText[end] || '')) end--; this.setData({detailText: this.detailText.slice(start, end), detailPage: this.detailIndex + 1, detailPages: pages}); },
  detailPage(event) { this.detailIndex += Number(dataOf(event).direction); this.paintDetail(); },
  copyDetail() { this.copyText(this.detailText); },
  copyRow(event) { const row = this.controller.rows.find(value => value.key === dataOf(event).key); if (row) this.copyText(row.text); },
  copy() { const row = this.controller.rows.filter(value => value.kind === 'assistant').pop(); if (row) this.copyText(row.text); this.closeSheet(); },
  copyText(text) { if (wx.setClipboardData) wx.setClipboardData({data: String(text || ''), success: () => this.controller.notify('已复制。'), fail: () => this.controller.notify('复制未完成，可以在完整内容中分段选取。')}); },
  openLink(event) { const target = dataOf(event).target; if (/^(https?:|codex:)/i.test(target)) this.copyText(target); else this.openFiles({currentTarget: {dataset: {path: target.replace(/:\d+(?::\d+)?$/, '')}}}); },
  async loadImagePreview(key, index) {
    const c = this.controller, context = c.key, epoch = c.epoch, row = c.rows.find(value => value.key === key); if (!row || !row.images[index] || !c.ready || !this.visible) return '';
    try { const path = await this.images.resolve(row.images[index], c.threadId, c.current.cwd || ''); if (c !== this.controller || context !== c.key || epoch !== c.epoch || !c.ready || !this.visible) return ''; this.imagePaths.set(key + ':img:' + index, path); this.paint(); return path; }
    catch (error) { if (c === this.controller && context === c.key && epoch === c.epoch) c.notify(error.message); return ''; }
  },
  async toggleImageRow(event) {
    const {key} = dataOf(event), c = this.controller, context = c.key, row = c.rows.find(value => value.key === key); if (!row || !row.images.length) return;
    c.toggleImageRow(key); this.paint();
    if (c.expandedImages.has(key)) for (let index = 0; index < row.images.length; index++) { if (c !== this.controller || context !== c.key || !c.expandedImages.has(key)) break; await this.loadImagePreview(key, index); }
  },
  async viewImage(event) {
    const {key, index} = dataOf(event), c = this.controller, context = c.key, epoch = c.epoch, row = c.rows.find(value => value.key === key);
    if (!row) return;
    const paths = await Promise.all(row.images.map((_, imageIndex) => this.loadImagePreview(key, imageIndex))), current = paths[Number(index)];
    if (current && c === this.controller && context === c.key && epoch === c.epoch && this.visible && wx.previewImage) wx.previewImage({current, urls: paths.filter(Boolean)});
  },
  previewDraftImage(event) { const image = this.data.draftImages[Number(dataOf(event).index)]; if (image && image.src && wx.previewImage) wx.previewImage({current: image.src, urls: this.data.draftImages.map(row => row.src).filter(Boolean)}); },
  async addImages(event) {
    const c = this.controller, key = c.key; if (!c.canControl || c.busy || c.sendBlocked) return;
    const source = event && dataOf(event).source === 'camera' ? 'camera' : 'album', count = source === 'camera' ? 1 : 9;
    try {
      const files = await new Promise((resolve, reject) => {
        if (wx.chooseMedia) wx.chooseMedia({count, sourceType: [source], mediaType: ['image'], sizeType: ['original'], success: result => resolve(result.tempFiles.map(file => file.tempFilePath)), fail: reject});
        else wx.chooseImage({count, sourceType: [source], sizeType: ['original'], success: result => resolve(result.tempFilePaths), fail: reject});
      });
      const fs = wx.getFileSystemManager();
      for (const filePath of files) {
        const result = await new Promise((resolve, reject) => fs.readFile({filePath, success: resolve, fail: reject})); if (c !== this.controller || key !== c.key || this.unloaded || ['forbidden', 'reauthorize', 'revoked'].includes(c.state)) return;
        const bytes = new Uint8Array(result.data), type = bytes[0] === 137 && bytes[1] === 80 ? 'png' : bytes[0] === 255 && bytes[1] === 216 ? 'jpeg' : bytes[0] === 71 && bytes[1] === 73 ? 'gif' : bytes[0] === 82 && bytes[8] === 87 ? 'webp' : '';
        if (!type) throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。');
        const url = `data:image/${type};base64,${wx.arrayBufferToBase64(result.data)}`;
        c.draft.images.push({url, src: filePath});
      }
      c.emit(); this.closeSheet(); this.paint();
    } catch (error) { if (!String(error.errMsg || '').includes('cancel') && key === c.key) c.notify(error.message || '图片读取未完成。'); }
  },
  removeAttachment(event) { this.controller.removeAttachment(dataOf(event).kind, Number(dataOf(event).index)); this.paint(); },
  async addFiles() {
    const c = this.controller, key = c.key, cwd = c.current && c.current.cwd;
    if (!c.canControl || c.busy || c.sendBlocked || !cwd || this.data.uploadingAttachment) return;
    if (!wx.chooseMessageFile) return c.notify('当前微信版本不支持文件选择，请更新微信。');
    this.setData({uploadingAttachment: true});
    try {
      const result = await new Promise((resolve,reject) => wx.chooseMessageFile({count:100,type:'all',success:resolve,fail:reject}));
      // A native file picker may temporarily hide the Page and close its SocketTask.
      for (let attempt = 0; !c.canControl && attempt < 100 && c === this.controller && key === c.key && !this.unloaded; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      if (c !== this.controller || key !== c.key || this.unloaded) return;
      if (!c.canControl) throw new Error('连接尚未恢复，重新连接后再选择文件。');
      const fs = wx.getFileSystemManager();
      for (const file of result.tempFiles) {
        c.notify('正在添加文件：' + file.name);
        const data = await new Promise((resolve,reject) => fs.readFile({filePath:file.path,success:resolve,fail:reject}));
        if (c !== this.controller || key !== c.key || !c.canControl) return;
        const uploaded = await this.connection.request('lanpower/files/upload',{cwd,name:file.name,base64:wx.arrayBufferToBase64(data.data)});
        if (c !== this.controller || key !== c.key || !c.canControl) return;
        c.addFile(uploaded.path);
      }
      c.notify('文件已添加到消息。'); this.closeSheet(); this.paint();
    } catch (failure) { if (key === c.key && !String(failure.errMsg || '').includes('cancel')) c.notify(failure.message || '文件上传未完成，请重试。'); }
    finally { if (!this.unloaded) { this.setData({uploadingAttachment: false}); this.paint(); } }
  },
  openAttachments() { this.setData({sheet: 'attachments'}); },
  togglePlanMode() { if (!this.controller.planSupported || this.controller.activeTurn) return; this.controller.chooseSetting('mode', this.data.selectedMode === 'plan' ? 'default' : 'plan'); this.closeSheet(); this.paint(); },
  openFileSheet() { const cwd = this.controller.current && this.controller.current.cwd; if (!cwd || !this.controller.ready) return this.controller.notify('请先连接电脑并选择项目。'); this.fileOffset = 0; this.setData({sheet: 'files'}); void this.controller.resources.open(cwd); this.paintResources(); },
  selectFileProject(event) { const project = this.data.projects[Number(event.detail.value)]; if (!project || !this.controller.ready) return; this.fileOffset = 0; void this.controller.resources.open(project.path); this.paintResources(); },
  openFiles(event) { const dataset = event ? dataOf(event) : {}, cwd = dataset.cwd || this.controller.current && this.controller.current.cwd || this.data.projects[0] && this.data.projects[0].path; if (!cwd || !this.controller.ready) return this.controller.notify('请先连接电脑并选择项目。'); this.auxReturn = this.data.view === 'chat' ? 'chat' : 'library'; this.fileOffset = 0; this.setData({view: 'files', sheet: ''}); void this.controller.resources.open(cwd, dataset.path || ''); },
  openFile(event) { const {path, directory} = dataOf(event); this.fileOffset = 0; return directory ? this.controller.resources.directory(path) : this.controller.resources.files('lanpower/files/read', {path}); },
  fileParent() { this.fileOffset = 0; return this.controller.resources.directory(this.data.fileState.parent); },
  fileRoot() { this.fileOffset = 0; return this.controller.resources.directory('.'); },
  fileBack() { this.controller.resources.state.selected = null; this.paintResources(); },
  fileSearch(event) { const value = event.detail.value; this.controller.resources.state.query = value; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => { this.fileOffset = 0; void this.controller.resources.search(value); }, 300); },
  filesMore() { return this.controller.resources.more(); },
  filePage(event) { this.fileOffset = Math.max(0, this.fileOffset + Number(dataOf(event).direction) * 50); this.paintResources(); },
  fileFull() { const file = this.controller.resources.state.selected; if (file) this.showDetail(file.path, file.content || '', 'code'); },
  attachFile() { const resources = this.controller.resources, file = resources.state.selected; if (!file) return; try { this.controller.addFile(resources.absolute(file.path)); this.setData({view: 'chat', sheet: ''}); this.auxReturn = ''; this.paint(); } catch (error) { this.controller.notify(error.message); } },
  openFeature(event) { const kind = dataOf(event).kind; this.auxReturn = this.data.view === 'chat' ? 'chat' : 'library'; this.setData({homeMenu: false, view: kind === 'settings' ? 'settings' : kind === 'automations' ? 'automations' : 'catalog', sheet: '', catalogKind: kind === 'automations' ? 'automations' : kind === 'plugins' ? 'plugin' : 'skill', catalogQuery: ''}); this.catalogLimit = 30; if (kind !== 'settings') return this.refreshCatalog(); },
  chooseCatalog(event) { this.catalogLimit = 30; this.setData({catalogKind: dataOf(event).kind, catalogQuery: ''}); return this.refreshCatalog(); },
  chooseCatalogCwd(event) { this.setData({catalogCwdIndex: Number(event.detail.value)}); return this.refreshCatalog(); },
  refreshCatalog() { if (!this.controller.ready) return; const project = this.data.projects[this.data.catalogCwdIndex], cwd = project && project.path || this.controller.current && this.controller.current.cwd || ''; return this.controller.resources.directoryCatalog(this.data.catalogKind, cwd); },
  catalogSearch(event) { this.setData({catalogQuery: event.detail.value}); this.catalogLimit = 30; this.paintResources(); },
  catalogMore() { return this.controller.resources.catalogPager.next(); },
  catalogPrevious() { return this.controller.resources.catalogPager.previous(); },
  refreshQuota() { return this.controller.nativeUsage.readQuota(); },
  catalogDetail(event) { const row = this.controller.resources.catalog.rows[Number(dataOf(event).index)]; if (row) this.showDetail(row.displayName || row.name || row.id, [row.description, row.path, row.rrule, ...(row.tools || []).map(tool => `${tool.title || tool.name}\n${tool.description || ''}`)].filter(Boolean).join('\n\n')); },
  useSkill(event) { const row = this.controller.resources.catalog.rows[Number(dataOf(event).index)]; if (!row || row.enabled !== true) return; try { this.controller.addSkill(row); this.setData({view: 'chat', sheet: ''}); this.auxReturn = ''; this.paint(); } catch (error) { this.controller.notify(error.message); } },
  async reloadMcp() { if (!this.controller.ready) return; try { await this.connection.request('config/mcpServer/reload'); await this.refreshCatalog(); } catch (error) { this.controller.notify(error.message); } },
  setEnter(event) { this.setData({sendWithEnter: !!event.detail.value}); this.saveInputPreferences(); },
  saveInputPreferences() { wx.setStorageSync(this.inputKey, {mode: this.data.sendMode, enter: this.data.sendWithEnter}); },
  librarySort(event) { this.controller.changeLibrary('sort', '', dataOf(event).sort); },
  chatsFirst(event) { this.controller.changeLibrary('chatsFirst', '', !!event.detail.value); },
  unhideProject(event) { this.controller.changeLibrary('hidden', dataOf(event).id); },
  changeTheme(event) { const mode = dataOf(event).value; if (!['light', 'dark', 'system'].includes(mode)) return; this.setData({themeMode: mode}); wx.setStorageSync(this.themeKey, mode); this.applyTheme(); },
  applyTheme() { const mode = this.data.themeMode, theme = mode === 'system' ? this.systemTheme : mode; this.setData({theme: theme === 'dark' ? 'dark' : 'light'}); if (wx.setNavigationBarColor) wx.setNavigationBarColor({frontColor: theme === 'dark' ? '#ffffff' : '#000000', backgroundColor: theme === 'dark' ? '#17181a' : '#ffffff', animation: {duration: 0}}); },
});
