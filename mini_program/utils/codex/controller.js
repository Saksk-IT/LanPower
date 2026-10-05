const {clone, defaultPreferences, buildLibrary, emptyDraft, newSettings, effectiveSettings, observeSettings, modelId, validEfforts, StateClock, timestamp} = require('./model');
const {ReadScope, readThread, readPage, mergeHistory, advanceCursor, newBeginning, findBeginning, ContentReader, refreshTurn} = require('./history');
const {projectConversation, conversationWindow, userContent} = require('./conversation');
const {updateWebSearchStatus} = require('./web-search');
const {approvalView, approvalResult} = require('./approvals');
const {ResourceBrowser} = require('./resources');
const {NativeUsage} = require('./native-status');
const {permissionMode, permissionLabels} = require('./permissions');
const {elapsed} = require('../codex-format');
const error = (message, code = 'not_sent') => Object.assign(new Error(message), {code, uncertain: false});
let submissionSequence = 0;
const submissionId = () => `mini-${Date.now().toString(36)}-${++submissionSequence}-${Math.random().toString(36).slice(2, 12)}`;

// Owns remote state and in-memory drafts. The Page only adapts native controls and renders projections.
class CodexController {
  constructor(connection, changed = () => {}) {
    this.connection = connection; this.changed = changed; this.clock = new StateClock();
    this.drafts = new Map(); this.settings = new Map(); this.receipts = new Map(); this.permissionRequests = new Map(); this.epoch = 0; this.selection = 0;
    this.state = 'idle'; this.deviceId = ''; this.threadId = ''; this.current = null; this.feedback = ''; this.bootstrapSupported = true;
    this.resources = new ResourceBrowser(connection, () => this.ready, () => this.emit());
    this.nativeUsage = new NativeUsage(connection, () => this.ready, () => this.emit());
    this.resetDevice();
  }
  emit() { this.changed(); }
  notify(message) { this.feedback = message || ''; this.emit(); }
  get ready() { return this.state === 'runtime_ready'; }
  get key() { return this.deviceId + ':' + this.threadId; }
  get draft() { if (!this.drafts.has(this.key)) this.drafts.set(this.key, emptyDraft()); return this.drafts.get(this.key); }
  get threadSettings() { if (!this.settings.has(this.key)) this.settings.set(this.key, newSettings()); return this.settings.get(this.key); }
  get activeTurn() { return this.activeTurns.get(this.threadId) || ''; }
  get receipt() { return this.receipts.get(this.key); }
  get changingPermissions() { return this.permissionRequests.has(this.key); }
  get sendBlocked() { return !!this.receipt && ['sending', 'uncertain'].includes(this.receipt.state); }
  get canControl() { return this.ready && this.statusFresh && this.synced && !this.recovering && !this.loadingThread && !!this.current && this.current.id === this.threadId && !this.threadArchived && this.loggedIn && (this.sharedControl || this.current.control !== 'desktop'); }
  get selectedApprovals() { return Array.from(this.approvals.values()).filter(request => request.params && request.params.threadId === this.threadId); }
  resetHistory() {
    if (this.historyScope) this.historyScope.cancel(); if (this.contentScope) this.contentScope.cancel();
    this.historyScope = null; this.contentScope = null; this.contentReader = null; this.contentRun = (this.contentRun || 0) + 1; this.restoringContent = false; clearTimeout(this.contentRetry);
    this.historyCursor = ''; this.historySeen = new Set(); this.beginning = null; this.beginningIndex = -1; this.historyProgress = ''; this.historyResume = false; this.readingHistory = false;
    this.windowOffset = null; this.windowKey = ''; this.windowSize = 36; this.expandedTurns = new Set(); this.expandedActivities = new Set(); this.expandedImages = new Set(); this.contentProgress = {}; this.contentFailures = new Map(); this.rows = [];
  }
  resetDevice() {
    this.nativeUsage.reset(); this.capabilityPaging = false; this.resources.paging = false;
    this.resetHistory(); this.activeTurns = new Map(); this.approvals = new Map(); this.approvalAnswers = new Map(); this.queue = []; this.threads = []; this.projects = []; this.models = [];
    this.listCursor = ''; this.listSeen = new Set(); this.archived = false; this.threadArchived = false; this.library = {revision: 0, preferences: defaultPreferences()};
    this.sharedControl = false; this.desktopControl = false; this.queueSupported = false; this.planSupported = false; this.chatSupported = false; this.receiptsSupported = false; this.permissionsSupported = false; this.permissionRequests.clear();
    this.unsupportedMethods = []; this.loggedIn = true; this.statusFresh = false; this.busy = false; this.interrupting = false; this.responding = false; this.queryingReceipt = false; this.recovering = false;
    this.loadingThread = false; this.loadingLibrary = false; this.syncing = false; this.statusReading = false; this.synced = false; this.lastSync = 0; this.syncFailed = false; this.overlay = {label: '', plan: [], error: ''};
    this.libraryDraft = null; this.librarySaving = false; this.shellStale = false; this.resources.reset();
    clearTimeout(this.reconcileTimer); clearTimeout(this.libraryTimer); clearTimeout(this.contentRetry);
  }
  chooseDevice(id) {
    this.epoch++; this.selection++; this.deviceId = id; this.threadId = ''; this.current = null; this.feedback = ''; this.clock.clear(); this.resetDevice();
    this.state = id ? 'connecting' : 'idle'; this.connection.connect(id); this.emit();
  }
  hydrateShell(snapshot) {
    if (!snapshot || snapshot.deviceId !== this.deviceId) return;
    this.archived = snapshot.archived === true; this.threads = Array.isArray(snapshot.threads) ? snapshot.threads.slice() : [];
    if (snapshot.library && typeof snapshot.library === 'object') this.library = snapshot.library;
    if (snapshot.threadId) this.threadId = snapshot.threadId;
    this.shellStale = true; this.emit();
  }
  shellSnapshot() {
    return {deviceId: this.deviceId, threadId: this.threadId, archived: this.archived, threads: this.threads, library: this.library};
  }
  onState(state) {
    const wasReady = this.ready; this.state = state;
    if (!this.ready) {
      this.permissionRequests.clear();
      clearTimeout(this.quotaTimer); this.nativeUsage.reset('电脑连接未就绪，无法取得当前额度与上下文。');
      this.epoch++; this.statusFresh = false; this.busy = false; this.syncing = false; this.statusReading = false; this.queryingReceipt = false; this.readingHistory = false; this.loadingThread = false; this.loadingLibrary = false; this.recovering = false; this.interrupting = false; this.responding = false;
      this.approvals.clear(); this.queue = []; this.resources.reset(); this.clock.clear(); this.libraryDraft = null; this.synced = false;
      if (this.historyScope) this.historyScope.cancel(); if (this.contentScope) this.contentScope.cancel();
      this.contentRun++; this.restoringContent = false; clearTimeout(this.contentRetry); this.overlay = {label: '', plan: [], error: ''};
    } else if (!wasReady) { this.recovering = true; void this.nativeUsage.readQuota(); void this.restore(); }
    this.emit();
  }
  applyLibraryPage(page, more = false) {
    const rows = [...(page && page.data || []), ...(page && page.pinned || [])];
    this.threads = Array.from(new Map([...(more || page && page.stale ? this.threads : []), ...rows].map(thread => [thread.id, thread])).values());
    this.listCursor = page && page.nextCursor || '';
    if (!page || page.stale !== true) this.shellStale = false;
  }
  async loadRemainingModels(cursor, e) {
    const all = [...this.models], seen = new Set();
    try {
      while (cursor && e === this.epoch) {
        if (seen.has(cursor)) throw new Error('模型列表游标未推进。');
        seen.add(cursor); const page = await this.connection.request('model/list', {limit: 50, cursor});
        if (e !== this.epoch) return;
        all.push(...(page.data || [])); this.models = Array.from(new Map(all.map(model => [modelId(model), model])).values()); this.emit(); cursor = page.nextCursor || '';
      }
    } catch (failure) { if (e === this.epoch) this.notify(failure.message); }
  }
  async acceptThread(result, e, s, stamp) {
    if (!result || !result.thread || !this.valid(e, s)) return;
    const id = result.thread.id;
    if (!this.clock.unchanged(stamp, id) || !this.clock.snapshot(id, result.thread.lanpowerRevision)) { this.loadingThread = false; this.reconcile(); return; }
    this.current = result.thread; this.historyCursor = result.thread.historyCursor || ''; this.observeThread(result.thread); this.lastSync = Date.now(); this.syncFailed = false; this.shellStale = false; this.loadingThread = false; this.emit();
  }
  deferThreadWork(e, s) {
    void this.refreshQueue().catch(failure => { if (this.valid(e, s) && failure.code !== 'unsupported_method') this.notify(failure.message); });
    void this.refreshStatus(); void this.queryReceipt();
  }
  async restore() {
    const e = this.epoch, stamp = this.clock.capture(), initialThreadId = this.threadId,
      initialSelection = this.selection, initialArchived = this.archived, threadStamp = this.clock.capture(this.threadId);
    this.recovering = true; this.emit();
    try {
      let bootstrap = null;
      if (this.bootstrapSupported) try { bootstrap = await this.connection.request('lanpower/bootstrap', {...(this.threadId ? {threadId: this.threadId} : {}), archived: this.archived, limit: 50}); }
      catch (failure) { if (failure.code === 'unsupported_method' || failure.code === 'method_not_allowed') this.bootstrapSupported = false; else throw failure; }
      if (e !== this.epoch || !this.ready) return;
      if (bootstrap && typeof bootstrap === 'object' && ('status' in bootstrap || 'library' in bootstrap || 'models' in bootstrap)) {
        this.applyStatus(bootstrap.status || {}, stamp); this.models = Array.from(new Map((bootstrap.models || []).map(model => [modelId(model), model])).values()); this.planSupported = bootstrap.planSupported === true;
        if (this.archived === initialArchived && !this.libraryQuery) this.applyLibraryPage(bootstrap.library || {});
        if (bootstrap.thread && this.threadId === initialThreadId && this.selection === initialSelection) {
          this.loadingThread = true; this.threadArchived = initialArchived; this.resetHistory(); const s = ++this.selection;
          await this.acceptThread({thread: bootstrap.thread}, e, s, threadStamp); if (this.valid(e, s)) this.deferThreadWork(e, s);
        } else if (this.threadId && this.selection === initialSelection) await this.selectThread(this.threadId, true);
        void this.loadRemainingModels(bootstrap.modelNextCursor || '', e); void this.refreshStatus(); setTimeout(() => { if (e === this.epoch && this.ready) void this.loadThreads(false, false); }, 750);
        return;
      }
      if (bootstrap) { bootstrap = null; this.bootstrapSupported = false; }
      const [status, firstModels, modes] = await Promise.all([this.connection.request('lanpower/status'), this.connection.request('model/list', {limit: 50}), this.connection.request('collaborationMode/list').catch(() => ({data: []}))]);
      if (e !== this.epoch || !this.ready) return;
      this.applyStatus(status, stamp); this.planSupported = (modes.data || []).some(mode => mode.mode === 'plan');
      this.models = Array.from(new Map((firstModels.data || []).map(model => [modelId(model), model])).values()); void this.loadRemainingModels(firstModels.nextCursor || '', e);
      await this.loadThreads(); if (e !== this.epoch) return;
      if (this.threadId) await this.selectThread(this.threadId, true);
      void this.queryReceipt();
    } catch (failure) { if (e === this.epoch) this.notify(failure.message); }
    finally { if (e === this.epoch) { this.recovering = false; this.emit(); void this.restoreContent(); } }
  }
  applyStatus(status, stamp = this.clock.capture()) {
    this.statusFresh = status.fast !== true && typeof status.loggedIn === 'boolean';
    this.permissionsSupported = status.permissionsControl === true;
    this.capabilityPaging = status.capabilityPaging === true; this.resources.paging = this.capabilityPaging;
    this.sharedControl = !!status.sharedControl; this.desktopControl = !!status.desktopControl; this.queueSupported = !!status.queueSupported; this.chatSupported = !!status.chatSupported; this.receiptsSupported = !!status.submissionReceipts;
    this.targetedHistoryActions = !!status.targetedHistoryActions;
    this.libraryCatalog = !!status.libraryCatalog;
    this.loggedIn = status.loggedIn !== false; this.handoff = !!status.sessionHandoff; this.unsupportedMethods = status.unsupportedMethods || []; this.projects = status.projects || [];
    if (status.library && !this.libraryDraft && !this.librarySaving) this.library = status.library;
    if (!this.clock.unchanged(stamp)) { this.reconcile(); return; }
    const active = new Map((status.activeTurns || []).map(turn => [turn.threadId, turn.turnId]));
    if (status.activeTurn) active.set(status.activeThread, status.activeTurn);
    for (const id of new Set([...this.activeTurns.keys(), ...active.keys()])) if (this.clock.snapshot(id, status.lanpowerRevision)) { if (active.has(id)) this.activeTurns.set(id, active.get(id)); else this.activeTurns.delete(id); }
    const incoming = status.pendingApprovals || [], ids = incoming.map(request => request.id), keys = new Set(ids.map(id => JSON.stringify(id)));
    for (const key of this.approvals.keys()) if (!keys.has(key)) { this.approvals.delete(key); this.approvalAnswers.delete(key); }
    for (const request of incoming) this.approvals.set(JSON.stringify(request.id), request);
    this.connection.reconcileApprovals(ids); this.emit();
  }
  async refreshStatus() {
    if (!this.ready || this.statusReading) return;
    const e = this.epoch, stamp = this.clock.capture(); this.statusReading = true;
    try { const status = await this.connection.request('lanpower/status'); if (e === this.epoch) this.applyStatus(status, stamp); }
    catch (failure) { if (e === this.epoch) this.notify(failure.message); }
    finally { if (e === this.epoch) this.statusReading = false; }
  }
  async loadThreads(more = false, refresh = true) {
    if (!this.ready || this.loadingLibrary) return;
    const e = this.epoch, archived = this.archived, cursor = more ? this.listCursor : '', query = this.libraryQuery || ''; this.loadingLibrary = true; this.emit();
    try {
      const page = await this.connection.request(this.libraryCatalog ? 'lanpower/library/list' : 'thread/list', {limit:50,archived,...(this.libraryCatalog ? {refresh:!more && refresh,...(query ? {query} : {})} : {}),...(cursor ? {cursor} : {})}); if (e !== this.epoch || archived !== this.archived || query !== (this.libraryQuery || '')) return;
      if (more) advanceCursor(cursor, page.nextCursor, this.listSeen);
      const preservePrevious = page && page.stale === true;
      let previous = more || !query || preservePrevious ? this.threads : [];
      if (!more && this.libraryCatalog && !query && !preservePrevious) {
        const checked = [];
        for (let offset = 0; offset < previous.length; offset += 256) {
          const result = await this.connection.request('lanpower/library/check',{threadIds:previous.slice(offset,offset + 256).map(t => t.id),archived}); if (e !== this.epoch || archived !== this.archived || query !== (this.libraryQuery || '')) return;
          checked.push(...(result.data || []));
        }
        previous = checked;
      }
      this.threads = Array.from(new Map([...previous,...(page.data || []),...(page.pinned || [])].map(thread => [thread.id,thread])).values());
      this.listCursor = page.nextCursor || '';
      if (!page || page.stale !== true) this.shellStale = false;
      if (page && page.refreshing) setTimeout(() => { if (e === this.epoch && this.ready && !this.loadingLibrary) void this.loadThreads(false, false); }, 1000);
    } catch (failure) { if (e === this.epoch) this.notify(failure.message); }
    finally { if (e === this.epoch) { this.loadingLibrary = false; this.emit(); if (query !== (this.libraryQuery || '')) void this.loadThreads(); } }
  }
  searchLibrary(query) { this.libraryQuery = query.trim(); this.listCursor = ''; this.listSeen.clear(); if (!this.libraryCatalog && query) this.notify('当前版本只能搜索已加载聊天，请更新电脑端与 Cloud。'); else { this.threads = []; void this.loadThreads(); } }
  async toggleArchived() { if (this.loadingLibrary || !this.ready) return; this.archived = !this.archived; this.threads = []; this.listCursor = ''; this.listSeen.clear(); await this.loadThreads(); }
  async selectThread(id, restoring = false) {
    if (!this.ready) return;
    const same = id === this.threadId; if (same && !restoring && this.current) return this.refreshCurrent();
    this.resetHistory(); const e = this.epoch, s = ++this.selection, stamp = this.clock.capture(id);
    this.threadId = id; this.threadArchived = this.archived; this.current = null; this.queue = []; this.busy = false; this.loadingThread = true; this.synced = false; this.lastSync = 0; this.syncFailed = false; this.overlay = {label: '', plan: [], error: ''};
    const scope = this.historyScope = new ReadScope(); this.emit();
    try {
      const result = await readThread(this.connection, id, scope); if (!this.valid(e, s)) return;
      await this.acceptThread(result, e, s, stamp); if (this.valid(e, s)) this.deferThreadWork(e, s);
    } catch (failure) { if (this.valid(e, s) && failure.code !== 'CANCELLED') this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.loadingThread = false; this.emit(); void this.restoreContent(); } }
  }
  valid(e, s = this.selection) { return e === this.epoch && s === this.selection && this.ready; }
  observeThread(thread) {
    this.synced = true;
    observeSettings(this.threadSettings, thread, modelId(this.models.find(model => model.isDefault) || this.models[0] || {}));
    const active = (thread.turns || []).filter(turn => turn.status === 'inProgress').pop();
    if (active) this.activeTurns.set(thread.id, active.id); else if (!thread.status || thread.status.type !== 'active') this.activeTurns.delete(thread.id);
    this.threads = this.threads.map(row => row.id === thread.id ? {...row, ...thread, turns: undefined} : row);
  }
  async refreshCurrent() {
    if (!this.ready || !this.threadId || this.loadingThread || this.syncing || this.busy || this.readingHistory || this.beginningIndex >= 0) return;
    const e = this.epoch, s = this.selection, id = this.threadId, stamp = this.clock.capture(id), statusStamp = this.clock.capture(), scope = new ReadScope();
    if (this.historyScope) this.historyScope.cancel(); this.historyScope = scope; this.syncing = true;
    try {
      const [result, status] = await Promise.all([readThread(this.connection, id, scope), this.connection.request('lanpower/status')]); if (!this.valid(e, s)) return;
      let latest = result.thread.turns || [], cursor = result.thread.historyCursor || ''; const previous = this.current && this.current.turns || [], ids = new Set(previous.map(turn => turn.id)), seen = new Set();
      while (previous.length && latest.length && !latest.some(turn => ids.has(turn.id)) && cursor) { const page = await readPage(this.connection, id, cursor, scope); if (!this.valid(e, s)) return; latest = [...(page.data || []).slice().reverse(), ...latest]; cursor = advanceCursor(cursor, page.nextCursor, seen); }
      this.applyStatus(status, statusStamp);
      if (!this.clock.unchanged(stamp, id) || !this.clock.snapshot(id, result.thread.lanpowerRevision)) { this.reconcile(); return; }
      if (!previous.length || latest.some(turn => turn.id === previous[0].id)) this.historyCursor = cursor;
      this.current = {...result.thread, turns: mergeHistory(previous, latest)}; this.observeThread(result.thread); this.lastSync = Date.now(); this.syncFailed = false; await this.refreshQueue();
    } catch (failure) { if (this.valid(e, s) && failure.code !== 'CANCELLED') { this.syncFailed = true; this.notify(failure.message); } }
    finally { if (this.valid(e, s)) { this.syncing = false; this.emit(); void this.restoreContent(); } }
  }
  chooseSetting(key, value) {
    this.threadSettings.overrides[key] = value;
    if (key === 'model') { const model = this.models.find(row => modelId(row) === value); if (!validEfforts(model).includes(effectiveSettings(this.threadSettings).effort)) this.threadSettings.overrides.effort = model && model.defaultReasoningEffort || ''; }
    this.emit();
  }
  inheritSettings() { this.threadSettings.overrides = {}; this.emit(); }
  async changePermissions(mode) {
    if (!['ask', 'auto-review', 'full-access'].includes(mode) || !this.canControl || !this.permissionsSupported || this.busy || this.sendBlocked || this.changingPermissions) return;
    const e = this.epoch, s = this.selection, id = this.threadId, key = this.key, token = {};
    this.permissionRequests.set(key, token); this.emit();
    try {
      const result = await this.connection.request('lanpower/permissions/set', {threadId: id, permissionMode: mode});
      if (!this.valid(e, s)) return;
      if (!result.thread || result.thread.id !== id) throw error('电脑未返回此聊天的实际权限。');
      observeSettings(this.threadSettings, result.thread, modelId(this.models[0] || {}));
      this.notify(permissionMode(this.threadSettings.permissions, this.current.cwd || '') === mode
        ? `已切换为${permissionLabels[mode]}${this.activeTurn ? '，用于后续任务；当前任务和待回复的审批保留原设置。' : '。'}`
        : '已读取电脑的实际权限，请核对电脑上的配置限制。');
      this.reconcile();
    } catch (failure) { if (this.valid(e, s)) { this.notify('权限更改未确认：' + failure.message); this.reconcile(); } }
    finally { if (this.permissionRequests.get(key) === token) this.permissionRequests.delete(key); this.emit(); }
  }
  input(text) { this.draft.text = text; this.emit(); }
  addSkill(skill) { if (!this.canControl) throw error('请先打开可以控制的聊天。'); if (!this.draft.skills.some(row => row.path === skill.path)) this.draft.skills.push({name: skill.name, path: skill.path}); this.emit(); }
  addFile(path) { if (!this.canControl) throw error('请先打开可以控制的聊天。'); if (!this.draft.files.some(file => file.path === path)) this.draft.files.push({label: path.replace(/\\/g, '/').split('/').pop(), path}); this.emit(); }
  removeAttachment(kind, index) { if (['images', 'skills', 'files'].includes(kind)) this.draft[kind].splice(index, 1); this.emit(); }
  makeInput(draft) {
    const text = draft.files.length ? `# Files mentioned by the user:\n${draft.files.map(file => `## ${file.label}: ${file.path}`).join('\n')}\n\n## My request for Codex:\n${draft.text.trim()}` : draft.text.trim();
    if (Array.from(text).some(point => point.length === 1 && /[\uD800-\uDFFF]/u.test(point))) throw error('输入包含无效 Unicode 字符。');
    const input = [...(text ? [{type: 'text', text}] : []), ...draft.images.map(image => ({type: 'image', url: image.url})), ...draft.skills.map(skill => ({type: 'skill', name: skill.name, path: skill.path}))];
    if (!input.length) throw error('请先输入内容或添加附件。'); return input;
  }
  async submit(mode = 'queue') {
    if (!this.canControl || this.busy || this.sendBlocked || this.changingPermissions) return;
    const e = this.epoch, s = this.selection, id = this.threadId, key = this.key, draft = clone(this.draft), options = clone(effectiveSettings(this.threadSettings)), active = this.activeTurn;
    let input;
    try {
      input = this.makeInput(draft);
      if (draft.editingQueue && !this.queue.some(row => row.id === draft.editingQueue)) throw error('这条排队消息已经被处理，请取消编辑后重试。');
      if (!active && !draft.editingQueue) {
        const model = this.models.find(row => modelId(row) === options.model);
        if (options.effort && model && model.supportedReasoningEfforts && !validEfforts(model).includes(options.effort)) throw error('该模型不支持所选思考强度。');
        if (options.mode === 'plan' && !this.planSupported) throw error('原窗口暂不支持计划模式。');
      }
      if (active && mode === 'queue' && !this.queueSupported) throw error('原窗口不支持排队，请选择引导。');
    } catch (failure) { this.notify(failure.message); return; }
    const receipt = {submissionId: submissionId(), state: 'sending', payload: draft, settings: options, method: ''};
    this.receipts.set(key, receipt); this.drafts.set(key, emptyDraft()); this.busy = true; this.feedback = ''; this.emit();
    try {
      if (!this.sharedControl && this.current.control !== 'remote') { await this.connection.request('thread/resume', {threadId: id}); if (!this.valid(e, s)) throw error('连接已变化，请确认原窗口状态。'); this.current.control = 'remote'; }
      let params = {threadId: id, input, ...(this.receiptsSupported ? {submissionId: receipt.submissionId} : {})};
      if (draft.editingQueue) { receipt.method = 'thread/queue/update'; params.queuedSubmissionId = draft.editingQueue; }
      else if (active && mode === 'queue') { receipt.method = 'thread/queue/add'; params.clientUserMessageId = receipt.submissionId; }
      else if (active) { receipt.method = 'turn/steer'; params.expectedTurnId = active; }
      else { receipt.method = 'turn/start'; params = {...params, ...(this.sharedControl ? {mode: options.mode} : {}), ...(options.model ? {model: options.model} : {}), ...(options.effort ? {effort: options.effort} : {})}; }
      const result = await this.connection.request(receipt.method, params);
      receipt.state = result.receipt && ['sending', 'uncertain'].includes(result.receipt.state) ? 'uncertain' : result.receipt && result.receipt.state === 'failed' ? 'failed' : 'accepted';
      receipt.turnId = result.receipt && result.receipt.turnId || result.turn && result.turn.id || result.turnId;
      if (receipt.state === 'failed') throw error('原窗口拒绝了提交，草稿已恢复。');
      if (receipt.state === 'uncertain') throw Object.assign(new Error('提交结果待确认，请查询回执。'), {uncertain: true});
      if (this.valid(e, s) && receipt.method === 'turn/start') { this.threadSettings.native = options; this.threadSettings.overrides = {}; if (receipt.turnId) this.activeTurns.set(id, receipt.turnId); this.overlay = {label: '正在思考', plan: [], error: ''}; }
      if (this.valid(e, s)) await this.refreshQueue();
    } catch (failure) {
      if (receipt.state !== 'accepted') { receipt.state = failure.uncertain ? 'uncertain' : 'failed'; if (receipt.state === 'failed') this.drafts.set(key, draft); }
      if (key === this.key) this.notify(failure.message);
    } finally { if (this.valid(e, s)) { this.busy = false; this.emit(); this.reconcile(); } }
  }
  async queryReceipt() {
    const receipt = this.receipt, key = this.key, e = this.epoch;
    if (!receipt || !this.ready || !this.receiptsSupported || !['sending', 'uncertain'].includes(receipt.state) || this.queryingReceipt) return;
    this.queryingReceipt = true; this.emit();
    try {
      const result = await this.connection.request('lanpower/submission/read', {threadId: this.threadId, submissionId: receipt.submissionId}); if (key !== this.key || e !== this.epoch) return;
      receipt.state = ['accepted', 'failed'].includes(result.state) ? result.state : 'uncertain'; receipt.turnId = result.turnId;
      if (receipt.state === 'failed') { this.drafts.set(key, clone(receipt.payload)); this.feedback = '原窗口明确拒绝了提交，输入已恢复。'; }
      else if (receipt.state === 'accepted') { this.feedback = '原窗口已接受，请勿重复发送。'; this.reconcile(); }
      else this.feedback = '电脑端尚不能确认，请检查原窗口的消息、任务和队列。';
    } catch (failure) { if (key === this.key && e === this.epoch) this.notify(failure.message); }
    finally { if (key === this.key && e === this.epoch) { this.queryingReceipt = false; this.emit(); } }
  }
  restoreUnaccepted() { if (this.receipt && this.receipt.state === 'uncertain') { this.receipt.state = 'failed'; this.drafts.set(this.key, clone(this.receipt.payload)); this.emit(); } }
  async interrupt() {
    if (!this.canControl || !this.activeTurn || this.interrupting) return;
    if (this.unsupportedMethods.includes('turn/interrupt')) { this.notify('原窗口暂不支持停止任务，请在电脑处理。'); return; }
    const e = this.epoch, s = this.selection, id = this.threadId, turnId = this.activeTurn; this.interrupting = true; this.emit();
    try { await this.connection.request('turn/interrupt', {threadId: id, turnId}); if (this.valid(e, s)) await this.refreshCurrent(); }
    catch (failure) { if (this.valid(e, s)) this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.interrupting = false; this.reconcile(); this.emit(); } }
  }
  async refreshQueue() {
    if (!this.queueSupported || !this.threadId) return;
    const e = this.epoch, s = this.selection, stamp = this.clock.capture(this.threadId), id = this.threadId, all = [], seen = new Set(); let cursor = '';
    try {
      do { const page = await this.connection.request('thread/queue/list', {threadId: id, limit: 32, ...(cursor ? {cursor} : {})}); if (!this.valid(e, s)) return; all.push(...(page.data || [])); cursor = advanceCursor(cursor, page.nextCursor, seen); } while (cursor);
      if (this.clock.unchanged(stamp, id)) this.queue = Array.from(new Map(all.map(row => [row.id, row])).values()); else this.reconcile(); this.emit();
    } catch (failure) { if (failure.code === 'unsupported_method' && this.valid(e, s)) { this.queueSupported = false; this.queue = []; this.emit(); } else throw failure; }
  }
  editQueue(id) {
    const row = this.queue.find(value => value.id === id); if (!row || !this.canControl || this.busy || this.sendBlocked) return;
    const value = userContent(row.input); this.drafts.set(this.key, {text: value.text, images: value.images.map(url => ({url, src: ''})), skills: value.skills, files: value.files, editingQueue: id}); this.emit();
  }
  cancelQueueEdit() { this.drafts.set(this.key, emptyDraft()); this.emit(); }
  async queueAction(action, id, direction = 0) {
    if (!this.canControl || this.busy || !this.queueSupported) return;
    const e = this.epoch, s = this.selection; this.busy = true; this.emit();
    try {
      const params = {threadId: this.threadId};
      if (action === 'reorder') { const ids = this.queue.map(row => row.id), from = ids.indexOf(id), target = from + direction; if (from < 0 || target < 0 || target >= ids.length) return; ids.splice(from, 1); ids.splice(target, 0, id); params.queuedSubmissionIds = ids; }
      else params.queuedSubmissionId = id;
      await this.connection.request('thread/queue/' + action, params); if (this.valid(e, s)) { await this.refreshQueue(); if (action === 'delete' && this.draft.editingQueue === id && !this.queue.some(row => row.id === id)) this.cancelQueueEdit(); }
    } catch (failure) { if (this.valid(e, s)) this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.busy = false; this.emit(); this.reconcile(); } }
  }
  async createThread(cwd, chat = false, model = '') {
    if (!this.ready || !this.statusFresh || !this.loggedIn || this.busy || chat && !this.chatSupported || !chat && !cwd) return;
    const e = this.epoch; this.busy = true; this.emit();
    try { const result = await this.connection.request(chat ? 'lanpower/chat/start' : 'thread/start', {...(!chat ? {cwd} : {}), ...(model ? {model} : {})}); if (e !== this.epoch) return; this.busy = false; if (this.archived) { this.archived = false; this.threads = []; this.listCursor = ''; } await this.loadThreads(); if (e === this.epoch) await this.selectThread(result.thread.id); return result.thread.id; }
    catch (failure) { if (e === this.epoch) this.notify(failure.message); }
    finally { if (e === this.epoch) { this.busy = false; this.emit(); } }
  }
  async threadAction(action, value) {
    const id = this.threadId, e = this.epoch, s = this.selection;
    if ((!this.canControl && action !== 'unarchive') || !this.ready || !this.statusFresh || !this.loggedIn || this.busy || !id) return;
    if (['rollback', 'archive', 'fork'].includes(action) && this.activeTurn) { this.notify('请先等待任务结束或停止任务。'); return; }
    this.busy = true; this.emit();
    try {
      let result;
      if (action === 'rename') { const name = String(value || '').trim(); if (!name || name.length > 1000) throw error('聊天名称需为 1–1000 字符。'); result = await this.connection.request('thread/name/set', {threadId: id, name}); if (this.valid(e, s)) { this.current.name = name; this.threads = this.threads.map(thread => thread.id === id ? {...thread, name} : thread); } }
      else if (action === 'fork') {
        if (value && (!this.targetedHistoryActions || !this.current.historyTailTurnId || !this.current.turns.some(turn => turn.id === value))) throw error('请更新电脑端与 Cloud 后，再按指定历史轮次分支。');
        result = await this.connection.request(value ? 'lanpower/history/action' : 'thread/fork', value ? {threadId:id,turnId:value,expectedTailTurnId:this.current.historyTailTurnId,action:'fork'} : {threadId:id}); if (!this.valid(e, s)) return;
        this.busy = false; await this.loadThreads(); if (this.valid(e, s)) await this.selectThread(result.thread.id);
      } else if (action === 'rollback') {
        if (!this.targetedHistoryActions || !this.current.historyTailTurnId || !(this.current.turns || []).some(turn => turn.id === value)) throw error('请更新电脑端与 Cloud 后，再按指定历史轮次回退。');
        result = await this.connection.request('lanpower/history/action', {threadId:id,turnId:value,expectedTailTurnId:this.current.historyTailTurnId,action:'rollback'}); if (!this.valid(e, s)) return;
        this.resetHistory(); this.current = result.thread; this.observeThread(result.thread); this.historyCursor = result.thread.historyCursor || ''; this.feedback = '已移除此轮及后续对话，文件修改保留。';
      } else if (['archive', 'unarchive'].includes(action)) {
        await this.connection.request('thread/' + action, {threadId: id}); if (!this.valid(e, s)) return;
        this.threads = this.threads.filter(thread => thread.id !== id); this.threadId = ''; this.current = null; this.resetHistory();
      } else if (action === 'release') { if (this.sharedControl || !this.handoff || this.activeTurn) throw error('当前会话无需交还或仍在运行。'); await this.connection.request('lanpower/session/release', {threadId: id}); if (this.valid(e, s)) this.current.control = 'available'; }
    } catch (failure) { if (this.valid(e, s)) this.notify(failure.message); }
    finally { if (e === this.epoch && (s === this.selection || action === 'fork')) { this.busy = false; this.emit(); this.reconcile(); } }
  }
  libraryView(query) { return buildLibrary(this.projects, this.threads.map(thread => ({...thread, ...(this.activeTurns.has(thread.id) ? {status: {type: 'active'}} : {})})), this.library.preferences, query); }
  saveLibrary(preferences) { if (!this.ready) return; this.libraryDraft = clone(preferences); this.library = {...this.library, preferences: clone(preferences)}; clearTimeout(this.libraryTimer); this.libraryTimer = setTimeout(() => void this.flushLibrary(), 250); this.emit(); }
  async flushLibrary() {
    if (this.librarySaving || !this.libraryDraft || !this.ready) return;
    const e = this.epoch; this.librarySaving = true;
    try {
      while (this.libraryDraft && e === this.epoch && this.ready) {
        const draft = this.libraryDraft; this.libraryDraft = null; let result = await this.connection.request('lanpower/library/update', {revision: this.library.revision, preferences: draft}); if (e !== this.epoch) return;
        if (result.conflict) result = await this.connection.request('lanpower/library/update', {revision: result.revision, preferences: draft}); if (e !== this.epoch) return;
        if (result.conflict) throw new Error('项目整理状态已变化，请刷新后重试。'); this.library = {revision: result.revision, preferences: this.libraryDraft || result.preferences};
      }
    } catch (failure) { if (e === this.epoch) { this.libraryDraft = null; this.notify(failure.message); this.librarySaving = false; await this.refreshStatus(); } }
    finally { if (e === this.epoch) { this.librarySaving = false; this.emit(); } }
  }
  changeLibrary(action, id, value) {
    const preferences = clone(this.library.preferences), groups = this.libraryView('').projects;
    if (['collapsed', 'pinned', 'hidden'].includes(action)) preferences[action] = preferences[action].includes(id) ? preferences[action].filter(key => key !== id) : [...preferences[action], id];
    else if (action === 'alias') preferences.aliases[id] = String(value || '').trim();
    else if (action === 'sort') preferences.sort = value;
    else if (action === 'chatsFirst') preferences.chatsFirst = !!value;
    else if (action === 'section') preferences.sections[id] = preferences.sections[id] === false;
    else if (action === 'move') { const order = groups.map(group => group.id), from = order.indexOf(id), target = from + value; if (from < 0 || target < 0 || target >= order.length) return; order.splice(from, 1); order.splice(target, 0, id); preferences.order = order; }
    this.saveLibrary(preferences);
  }
  approval(key) { return this.approvals.get(key); }
  approvalView(key) { const request = this.approval(key); if (!request) return null; const item = this.current && (this.current.turns || []).flatMap(turn => turn.items || []).find(item => item.id === request.params.itemId); return approvalView(request, this.approvalAnswers.get(key) || {}, item && item.changes || request.params.changes || []); }
  answer(key, questionId, text, index) {
    const request = this.approval(key); if (!request) return; const all = this.approvalAnswers.get(key) || {}, value = all[questionId] || {selected: [], text: ''};
    if (text !== undefined) value.text = text;
    if (index !== undefined) { const question = (request.params.questions || []).find(row => row.id === questionId); value.selected = question && question.multiSelect ? value.selected.includes(index) ? value.selected.filter(item => item !== index) : [...value.selected, index] : [index]; }
    all[questionId] = value; this.approvalAnswers.set(key, all); this.emit();
  }
  async decide(key, allow) {
    const request = this.approval(key); if (!request || this.responding || !this.canControl) return;
    if (request.params.turnId && request.params.turnId !== this.activeTurn) { this.notify('审批所属任务已变化，请刷新后处理。'); this.reconcile(); return; }
    const e = this.epoch, s = this.selection; this.responding = true; this.emit();
    try { const result = approvalResult(request, allow, this.approvalAnswers.get(key) || {}); const pending = this.connection.decide(request.id, result); void this.refreshStatus(); await pending; if (this.valid(e, s)) await this.refreshCurrent(); }
    catch (failure) { if (this.valid(e, s)) this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.responding = false; this.emit(); this.reconcile(); } }
  }
  onEvent(event) {
    if (!this.ready) return;
    const p = event.params || {}, id = p.threadId || p.thread && p.thread.id;
    if (id && !this.clock.event(id, p.lanpowerRevision)) return;
    if (this.nativeUsage.event(event.method,p)) return;
    if (event.method === 'turn/completed') { clearTimeout(this.quotaTimer); this.quotaTimer = setTimeout(() => { void this.nativeUsage.readQuota(); },300); }
    if (event.id !== undefined) { this.approvals.set(JSON.stringify(event.id), event); this.emit(); return; }
    if (event.method === 'serverRequest/resolved') { this.approvals.delete(JSON.stringify(p.requestId)); this.approvalAnswers.delete(JSON.stringify(p.requestId)); this.emit(); return; }
    if (['lanpower/error', 'lanpower/approvalError'].includes(event.method)) { this.notify(p.message || '操作未完成，请恢复会话确认。'); this.reconcile(); return; }
    const oldTurn = event.method === 'turn/completed' && this.activeTurns.get(id) !== (p.turn && p.turn.id);
    if (event.method === 'turn/started' && id && p.turn && p.turn.id) this.activeTurns.set(id, p.turn.id);
    if (event.method === 'turn/completed' && !oldTurn) this.activeTurns.delete(id);
    if (event.method === 'thread/name/updated') { const name = p.threadName || p.name; this.threads = this.threads.map(thread => thread.id === id ? {...thread, name} : thread); if (this.current && this.current.id === id) this.current.name = name; }
    if (event.method === 'thread/settings/updated' && id) { const key = this.deviceId + ':' + id, settings = this.settings.get(key) || newSettings(); this.settings.set(key, settings); observeSettings(settings, p.threadSettings || p.settings || p, modelId(this.models[0] || {})); }
    if (['thread/started', 'thread/archived', 'thread/unarchived'].includes(event.method)) { void this.loadThreads(); return; }
    if (event.method === 'thread/name/updated' && this.libraryCatalog) void this.loadThreads();
    if (event.method === 'thread/status/changed') this.threads = this.threads.map(thread => thread.id === id ? {...thread, status: p.status} : thread);
    if (['lanpower/historyChanged', 'lanpower/conversation/changed', 'lanpower/stream/changed', 'thread/status/changed', 'thread/settings/updated', 'thread/queue/changed'].includes(event.method)) { this.reconcile(); this.emit(); return; }
    if (id !== this.threadId || !this.current || this.beginningIndex >= 0) { this.emit(); return; }
    const turns = this.current.turns || (this.current.turns = []);
    if (['turn/started', 'turn/completed'].includes(event.method) && p.turn) {
      let turn = turns.find(value => value.id === p.turn.id); if (!turn) { turn = {...p.turn, items: p.turn.items || []}; turns.push(turn); } else Object.assign(turn, p.turn, {items: p.turn.items && p.turn.items.length ? p.turn.items : turn.items});
      if (event.method === 'turn/started' && !turn.startedAt) turn.startedAt = Date.now();
      if (event.method === 'turn/completed' && !turn.completedAt) turn.completedAt = Date.now();
      if (!oldTurn) this.overlay = {label: event.method === 'turn/started' ? '正在思考' : '', plan: [], error: p.turn.error && p.turn.error.message || ''};
    } else if (p.turnId && (['item/started', 'item/completed'].includes(event.method) || /(?:\/delta|\/outputDelta|\/summaryTextDelta)$/.test(event.method))) {
      let turn = turns.find(value => value.id === p.turnId); if (!turn) { turn = {id: p.turnId, status: 'inProgress', items: []}; turns.push(turn); }
      const itemId = p.item && p.item.id || p.itemId; let item = turn.items.find(value => value.id === itemId);
      if (p.item) { if (item) Object.assign(item, p.item); else { item = p.item; turn.items.push(item); } }
      else {
        const types = {'item/agentMessage/delta': 'agentMessage', 'item/plan/delta': 'plan', 'item/reasoning/summaryTextDelta': 'reasoning', 'item/commandExecution/outputDelta': 'commandExecution'};
        if (!item && types[event.method]) { item = {id: itemId, type: types[event.method], text: '', summary: [], aggregatedOutput: ''}; turn.items.push(item); }
        if (item && event.method === 'item/reasoning/summaryTextDelta') { const index = Number.isSafeInteger(p.summaryIndex) && p.summaryIndex >= 0 && p.summaryIndex < 100 ? p.summaryIndex : 0; item.summary = item.summary || []; item.summary[index] = (item.summary[index] || '') + (p.delta || ''); }
        else if (item && event.method === 'item/commandExecution/outputDelta') item.aggregatedOutput = (item.aggregatedOutput || '') + (p.delta || '');
        else if (item && types[event.method]) item.text = (item.text || '') + (p.delta || '');
      }
      updateWebSearchStatus(item, event.method);
      if (p.turnId === this.activeTurn) this.overlay.label = event.method === 'item/completed' ? '正在思考' : item && item.type === 'agentMessage' ? '正在撰写回复' : item && item.type === 'commandExecution' ? '正在运行命令' : '正在思考';
    } else if (event.method === 'turn/plan/updated' && (!p.turnId || p.turnId === this.activeTurn)) this.overlay.plan = (p.plan || []).map(step => ({step: step.step, status: step.status}));
    else if (event.method === 'turn/diff/updated') { const turn = turns.find(value => value.id === p.turnId); if (turn) turn.diff = p.diff || ''; }
    else if (event.method === 'error' && (!p.turnId || p.turnId === this.activeTurn)) this.overlay.error = p.error && p.error.message || '任务出错，请查看原窗口。';
    if (event.method === 'turn/completed') this.reconcile(); this.emit();
  }
  reconcile() {
    clearTimeout(this.reconcileTimer); const e = this.epoch;
    this.reconcileTimer = setTimeout(() => { if (e !== this.epoch || !this.ready) return; if (this.busy || this.syncing || this.loadingThread || this.readingHistory) { this.reconcile(); return; } void this.refreshStatus(); void this.refreshCurrent(); }, 500);
  }
  messages(imageView) {
    this.rows = projectConversation(this.current, this.expandedTurns, this.expandedActivities, this.expandedImages);
    if (this.windowOffset !== null && this.windowKey) { const index = this.rows.findIndex(row => row.key === this.windowKey); if (index >= 0) this.windowOffset = index; }
    const view = conversationWindow(this.rows, this.windowOffset, imageView, this.windowSize);
    this.windowKey = this.windowOffset === null ? '' : view.messages[0] && view.messages[0].key || '';
    return view;
  }
  holdWindow() { const view = this.messages(); this.windowOffset = view.windowStart; this.windowKey = view.messages[0] && view.messages[0].key || ''; }
  setWindow(offset, size = 36) { this.windowOffset = offset; this.windowKey = ''; this.windowSize = size; }
  toggleImageRow(key) { if (!this.rows.some(row => row.key === key && row.images && row.images.length)) return; this.holdWindow(); if (this.expandedImages.has(key)) this.expandedImages.delete(key); else this.expandedImages.add(key); this.emit(); }
  toggleRow(key, turnId) { this.holdWindow(); const work = key.startsWith('work:'), set = work ? this.expandedTurns : this.expandedActivities, value = work ? turnId : key; if (set.has(value)) set.delete(value); else set.add(value); this.emit(); }
  async earlier() {
    const view = this.messages();
    // Like the web render window, prepend without removing the already rendered tail.
    if (view.windowStart > 0) { const start = Math.max(0, view.windowStart - 24); this.setWindow(start, view.messages.length + view.windowStart - start); this.emit(); return; }
    if (!this.ready || !this.historyCursor || this.readingHistory || this.beginningIndex >= 0) return;
    const e = this.epoch, s = this.selection, scope = this.historyScope = new ReadScope(); this.readingHistory = true; this.emit();
    try { const page = await readPage(this.connection, this.threadId, this.historyCursor, scope); if (!this.valid(e, s)) return; const cursor = advanceCursor(this.historyCursor, page.nextCursor, this.historySeen), existing = new Set(this.current.turns.map(turn => turn.id)); this.current.turns = [...(page.data || []).slice().reverse().filter(turn => !existing.has(turn.id)), ...this.current.turns]; this.historyCursor = cursor;
      const rows = projectConversation(this.current, this.expandedTurns, this.expandedActivities, this.expandedImages), anchor = rows.findIndex(row => row.key === (view.messages[0] && view.messages[0].key)), start = Math.max(0, anchor - 24); this.setWindow(start, view.messages.length + Math.max(0, anchor - start)); }
    catch (failure) { if (this.valid(e, s) && failure.code !== 'CANCELLED') this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.readingHistory = false; this.emit(); void this.restoreContent(); } }
  }
  laterWindow() {
    const view = this.messages(); if (!view.hasWindowAfter) return;
    // Retain the head while appending. Only rotate a byte-full bridge window on an actual downward gesture.
    if (view.messages.length >= this.windowSize) this.setWindow(view.windowStart, this.windowSize + 24);
    else this.setWindow(view.windowStart + Math.max(1, view.messages.length - 12));
    this.emit();
  }
  latest() { this.resetHistory(); if (this.current) this.current.turns = []; this.emit(); return this.refreshCurrent(); }
  async jumpToBeginning() {
    if (!this.ready || !this.threadId || this.readingHistory) return;
    const e = this.epoch, s = this.selection, scope = this.historyScope = new ReadScope(); this.beginning = this.beginning || newBeginning(); this.readingHistory = true; this.historyResume = true; this.emit();
    try { const page = await findBeginning(this.connection, this.threadId, this.beginning, scope, count => { this.historyProgress = `正在定位开头 · 已检查 ${count} 轮`; this.emit(); }); if (!this.valid(e, s)) return; this.beginningIndex = this.beginning.pages.length - 1; this.current.turns = (page.data || []).slice().reverse(); this.historyCursor = ''; this.windowOffset = 0; this.contentReader = null; this.historyResume = false; this.historyProgress = `已定位开头 · 共 ${this.beginning.count} 轮`; }
    catch (failure) { if (e === this.epoch && s === this.selection) this.historyProgress = failure.code === 'CANCELLED' ? '读取已取消，可以继续。' : `读取中断，可继续：${failure.message}`; }
    finally { if (e === this.epoch && s === this.selection) { this.readingHistory = false; this.emit(); void this.restoreContent(); } }
  }
  async loadLater() {
    if (!this.ready || !this.beginning || this.beginningIndex <= 0 || this.readingHistory) return;
    const e = this.epoch, s = this.selection, index = this.beginningIndex - 1, scope = this.historyScope = new ReadScope(); this.readingHistory = true; this.emit();
    const view = this.messages();
    try { const page = await readPage(this.connection, this.threadId, this.beginning.pages[index], scope); if (!this.valid(e, s)) return; this.current.turns = mergeHistory(this.current.turns, (page.data || []).slice().reverse()); this.beginningIndex = index; this.setWindow(view.windowStart, view.messages.length + 24); }
    catch (failure) { if (this.valid(e, s) && failure.code !== 'CANCELLED') this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.readingHistory = false; this.emit(); void this.restoreContent(); } }
  }
  cancelHistory() { if (this.historyScope) this.historyScope.cancel(); if (this.contentScope) this.contentScope.cancel(); clearTimeout(this.contentRetry); }
  retryContent() { this.contentFailures.clear(); for (const value of Object.values(this.contentProgress)) value.error = ''; return this.restoreContent(); }
  async restoreContent() {
    if (!this.ready || !this.current || this.loadingThread || this.restoringContent) return;
    const e = this.epoch, s = this.selection, run = this.contentRun, scope = this.contentScope = new ReadScope(), reader = this.contentReader = this.contentReader || new ContentReader(this.threadId); this.restoringContent = true;
    const valid = () => this.valid(e, s) && run === this.contentRun;
    try {
      while (valid()) {
        const available = item => item.type === 'lanpowerLargeItem' && !(this.contentProgress[item.reference] || {}).error;
        const turn = this.current.turns.find(value => (value.items || []).some(available)); if (!turn) break;
        const item = turn.items.find(available), key = `${turn.id}:${item.id}`; this.contentProgress[item.reference] = {loaded: 0, error: ''};
        try { await reader.read(this.connection, item, scope, loaded => { if (valid()) { this.contentProgress[item.reference] = {loaded, error: ''}; this.emit(); } }); if (!valid()) return; this.current.turns = reader.apply(this.current.turns); this.contentFailures.delete(key); this.emit(); }
        catch (failure) {
          if (!valid() || failure.code === 'CANCELLED') return;
          const count = (this.contentFailures.get(key) || 0) + 1; this.contentFailures.set(key,count);
          if (count < 3 && ['history_reference_expired','history_reference_changed'].includes(failure.code)) {
            reader.forget(item.reference);
            try { const refreshed = await refreshTurn(this.connection,this.threadId,turn.id,scope); if (!valid()) return; this.current.turns = this.current.turns.map(value => value.id === turn.id ? refreshed : value); continue; } catch (_) { if (!valid() || scope.cancelled) return; }
          }
          this.contentProgress[item.reference].error = count < 3 ? failure.message : '内容读取已暂停，请点击重试或查看原窗口。'; this.emit();
        }
      }
    } catch (failure) { if (valid() && failure.code !== 'CANCELLED') this.notify(failure.message); }
    finally { if (run === this.contentRun) { this.restoringContent = false; if (valid() && !scope.cancelled && [...this.contentFailures.values()].some(count => count < 3)) {
      clearTimeout(this.contentRetry); this.contentRetry = setTimeout(() => { for (const turn of this.current.turns) for (const item of turn.items || []) if ((this.contentFailures.get(`${turn.id}:${item.id}`) || 0) < 3 && this.contentProgress[item.reference]) this.contentProgress[item.reference].error = ''; void this.restoreContent(); },5000);
    } } }
  }
  liveLabel() {
    if (!this.ready) return '任务状态待恢复'; if (this.selectedApprovals.length) return '等待你的回复'; if (!this.activeTurn) return '当前无运行任务'; if (this.interrupting) return '正在停止'; return this.overlay.label || '正在工作';
  }
  duration() { const turn = this.current && (this.current.turns || []).find(value => value.id === this.activeTurn), start = timestamp(turn && turn.startedAt || this.current && this.current.live && this.current.live.startedAt); return start ? elapsed((Date.now() - start) / 1000) : ''; }
  dispose() { clearTimeout(this.quotaTimer); this.nativeUsage.reset(); this.epoch++; this.resetHistory(); clearTimeout(this.reconcileTimer); clearTimeout(this.libraryTimer); clearTimeout(this.contentRetry); this.resources.reset(); this.drafts.clear(); this.settings.clear(); this.receipts.clear(); this.connection.stop(); }
}
module.exports = {CodexController};
