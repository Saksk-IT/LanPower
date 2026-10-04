const {clone, defaultPreferences, buildLibrary, emptyDraft, newSettings, effectiveSettings, observeSettings, modelId, validEfforts, StateClock, timestamp} = require('./model');
const {ReadScope, readThread, readPage, mergeHistory, advanceCursor, newBeginning, findBeginning, ContentReader, refreshTurn} = require('./history');
const {projectConversation, conversationWindow, userContent} = require('./conversation');
const {approvalView, approvalResult} = require('./approvals');
const {ResourceBrowser} = require('./resources');
const {elapsed} = require('../codex-format');
const error = (message, code = 'not_sent') => Object.assign(new Error(message), {code, uncertain: false});
let submissionSequence = 0;
const submissionId = () => `mini-${Date.now().toString(36)}-${++submissionSequence}-${Math.random().toString(36).slice(2, 12)}`;

// Owns remote state and in-memory drafts. The Page only adapts native controls and renders projections.
class CodexController {
  constructor(connection, changed = () => {}) {
    this.connection = connection; this.changed = changed; this.clock = new StateClock();
    this.drafts = new Map(); this.settings = new Map(); this.receipts = new Map(); this.epoch = 0; this.selection = 0;
    this.state = 'idle'; this.deviceId = ''; this.threadId = ''; this.current = null; this.feedback = '';
    this.resources = new ResourceBrowser(connection, () => this.ready, () => this.emit());
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
  get sendBlocked() { return !!this.receipt && ['sending', 'uncertain'].includes(this.receipt.state); }
  get canControl() { return this.ready && this.synced && !this.recovering && !this.loadingThread && !!this.current && this.current.id === this.threadId && !this.threadArchived && this.loggedIn && (this.sharedControl || this.current.control !== 'desktop'); }
  get selectedApprovals() { return Array.from(this.approvals.values()).filter(request => request.params && request.params.threadId === this.threadId); }
  resetHistory() {
    if (this.historyScope) this.historyScope.cancel(); if (this.contentScope) this.contentScope.cancel();
    this.historyScope = null; this.contentScope = null; this.contentReader = null; this.contentRun = (this.contentRun || 0) + 1; this.restoringContent = false; clearTimeout(this.contentRetry);
    this.historyCursor = ''; this.historySeen = new Set(); this.beginning = null; this.beginningIndex = -1; this.historyProgress = ''; this.historyResume = false; this.readingHistory = false;
    this.windowOffset = null; this.expandedTurns = new Set(); this.expandedActivities = new Set(); this.contentProgress = {}; this.rows = [];
  }
  resetDevice() {
    this.resetHistory(); this.activeTurns = new Map(); this.approvals = new Map(); this.approvalAnswers = new Map(); this.queue = []; this.threads = []; this.projects = []; this.models = [];
    this.listCursor = ''; this.listSeen = new Set(); this.archived = false; this.threadArchived = false; this.library = {revision: 0, preferences: defaultPreferences()};
    this.sharedControl = false; this.desktopControl = false; this.queueSupported = false; this.planSupported = false; this.chatSupported = false; this.receiptsSupported = false;
    this.unsupportedMethods = []; this.loggedIn = true; this.busy = false; this.interrupting = false; this.responding = false; this.queryingReceipt = false; this.recovering = false;
    this.loadingThread = false; this.loadingLibrary = false; this.syncing = false; this.statusReading = false; this.synced = false; this.lastSync = 0; this.syncFailed = false; this.overlay = {label: '', plan: [], error: ''};
    this.libraryDraft = null; this.librarySaving = false; this.resources.reset();
    clearTimeout(this.reconcileTimer); clearTimeout(this.libraryTimer); clearTimeout(this.contentRetry);
  }
  chooseDevice(id) {
    this.epoch++; this.selection++; this.deviceId = id; this.threadId = ''; this.current = null; this.feedback = ''; this.clock.clear(); this.resetDevice();
    this.state = id ? 'connecting' : 'idle'; this.connection.connect(id); this.emit();
  }
  onState(state) {
    const wasReady = this.ready; this.state = state;
    if (!this.ready) {
      this.epoch++; this.busy = false; this.syncing = false; this.statusReading = false; this.queryingReceipt = false; this.readingHistory = false; this.loadingThread = false; this.loadingLibrary = false; this.recovering = false; this.interrupting = false; this.responding = false;
      this.approvals.clear(); this.queue = []; this.resources.reset(); this.clock.clear(); this.libraryDraft = null; this.synced = false;
      if (this.historyScope) this.historyScope.cancel(); if (this.contentScope) this.contentScope.cancel();
      this.contentRun++; this.restoringContent = false; clearTimeout(this.contentRetry); this.overlay = {label: '', plan: [], error: ''};
    } else if (!wasReady) { this.recovering = true; void this.restore(); }
    this.emit();
  }
  async restore() {
    const e = this.epoch, stamp = this.clock.capture(); this.recovering = true; this.emit();
    try {
      const [status, firstModels, modes] = await Promise.all([this.connection.request('lanpower/status'), this.connection.request('model/list', {limit: 50}), this.connection.request('collaborationMode/list').catch(() => ({data: []}))]);
      if (e !== this.epoch || !this.ready) return;
      this.applyStatus(status, stamp); this.planSupported = (modes.data || []).some(mode => mode.mode === 'plan');
      const all = [...(firstModels.data || [])], seen = new Set(); let cursor = firstModels.nextCursor || '';
      while (cursor) { if (seen.has(cursor)) throw new Error('模型列表游标未推进。'); seen.add(cursor); const page = await this.connection.request('model/list', {limit: 50, cursor}); if (e !== this.epoch) return; all.push(...(page.data || [])); cursor = page.nextCursor || ''; }
      this.models = Array.from(new Map(all.map(model => [modelId(model), model])).values());
      await this.loadThreads(); if (e !== this.epoch) return;
      if (this.threadId) await this.selectThread(this.threadId, true);
      await this.queryReceipt();
    } catch (failure) { if (e === this.epoch) this.notify(failure.message); }
    finally { if (e === this.epoch) { this.recovering = false; this.emit(); void this.restoreContent(); } }
  }
  applyStatus(status, stamp = this.clock.capture()) {
    this.sharedControl = !!status.sharedControl; this.desktopControl = !!status.desktopControl; this.queueSupported = !!status.queueSupported; this.chatSupported = !!status.chatSupported; this.receiptsSupported = !!status.submissionReceipts;
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
  async loadThreads(more = false) {
    if (!this.ready || this.loadingLibrary) return;
    const e = this.epoch, archived = this.archived, cursor = more ? this.listCursor : ''; this.loadingLibrary = true; this.emit();
    try {
      const page = await this.connection.request('thread/list', {limit: 50, archived, ...(cursor ? {cursor} : {})}); if (e !== this.epoch || archived !== this.archived) return;
      if (more) advanceCursor(cursor, page.nextCursor, this.listSeen);
      this.threads = Array.from(new Map([...this.threads, ...(page.data || [])].map(thread => [thread.id, thread])).values());
      if (more || !this.listCursor) this.listCursor = page.nextCursor || '';
    } catch (failure) { if (e === this.epoch) this.notify(failure.message); }
    finally { if (e === this.epoch) { this.loadingLibrary = false; this.emit(); } }
  }
  async toggleArchived() { if (this.loadingLibrary || !this.ready) return; this.archived = !this.archived; this.threads = []; this.listCursor = ''; this.listSeen.clear(); await this.loadThreads(); }
  async selectThread(id, restoring = false) {
    if (!this.ready) return;
    const same = id === this.threadId; if (same && !restoring && this.current) return this.refreshCurrent();
    this.resetHistory(); const e = this.epoch, s = ++this.selection, stamp = this.clock.capture(id);
    this.threadId = id; this.threadArchived = this.archived; this.current = null; this.queue = []; this.busy = false; this.loadingThread = true; this.synced = false; this.lastSync = 0; this.syncFailed = false; this.overlay = {label: '', plan: [], error: ''};
    const scope = this.historyScope = new ReadScope(); this.emit();
    try {
      const result = await readThread(this.connection, id, scope); if (!this.valid(e, s)) return;
      if (!this.clock.unchanged(stamp, id) || !this.clock.snapshot(id, result.thread.lanpowerRevision)) { this.loadingThread = false; this.reconcile(); return; }
      this.current = result.thread; this.historyCursor = result.thread.historyCursor || ''; this.observeThread(result.thread); this.lastSync = Date.now();
      await this.refreshQueue(); await this.refreshStatus(); if (this.valid(e, s)) await this.queryReceipt();
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
  input(text) { this.draft.text = text; this.emit(); }
  addSkill(skill) { if (!this.canControl) throw error('请先打开可以控制的聊天。'); if (this.draft.skills.length >= 8) throw error('一次最多添加 8 个技能。'); if (!this.draft.skills.some(row => row.path === skill.path)) this.draft.skills.push({name: skill.name, path: skill.path}); this.emit(); }
  addFile(path) { if (!this.canControl) throw error('请先打开可以控制的聊天。'); if (!this.draft.files.some(file => file.path === path)) this.draft.files.push({label: path.replace(/\\/g, '/').split('/').pop(), path}); this.emit(); }
  removeAttachment(kind, index) { if (['images', 'skills', 'files'].includes(kind)) this.draft[kind].splice(index, 1); this.emit(); }
  makeInput(draft) {
    const text = draft.files.length ? `# Files mentioned by the user:\n${draft.files.map(file => `## ${file.label}: ${file.path}`).join('\n')}\n\n## My request for Codex:\n${draft.text.trim()}` : draft.text.trim();
    if (text.length > 16000) throw error('文字与文件引用合计不能超过 16000 字符。');
    if (draft.skills.length > 8 || draft.images.length > 4 || draft.images.reduce((sum, image) => sum + image.url.length, 0) > 850000 || draft.images.some(image => image.url.length > 700000)) throw error('附件过大，请减少图片或技能。');
    const input = [...(text ? [{type: 'text', text}] : []), ...draft.images.map(image => ({type: 'image', url: image.url})), ...draft.skills.map(skill => ({type: 'skill', name: skill.name, path: skill.path}))];
    if (!input.length) throw error('请先输入内容或添加附件。'); return input;
  }
  async submit(mode = 'queue') {
    if (!this.canControl || this.busy || this.sendBlocked) return;
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
      if (action === 'reorder') { const ids = this.queue.map(row => row.id), from = ids.indexOf(id), target = from + direction; if (from < 0 || target < 0 || target >= ids.length) return; if (ids.length > 32) throw error('队列超过 32 条，请在原窗口整理。'); ids.splice(from, 1); ids.splice(target, 0, id); params.queuedSubmissionIds = ids; }
      else params.queuedSubmissionId = id;
      await this.connection.request('thread/queue/' + action, params); if (this.valid(e, s)) { await this.refreshQueue(); if (action === 'delete' && this.draft.editingQueue === id && !this.queue.some(row => row.id === id)) this.cancelQueueEdit(); }
    } catch (failure) { if (this.valid(e, s)) this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.busy = false; this.emit(); this.reconcile(); } }
  }
  async createThread(cwd, chat = false, model = '') {
    if (!this.ready || this.busy || chat && !this.chatSupported || !chat && !cwd) return;
    const e = this.epoch; this.busy = true; this.emit();
    try { const result = await this.connection.request(chat ? 'lanpower/chat/start' : 'thread/start', {...(!chat ? {cwd} : {}), ...(model ? {model} : {})}); if (e !== this.epoch) return; this.busy = false; if (this.archived) { this.archived = false; this.threads = []; this.listCursor = ''; } await this.loadThreads(); if (e === this.epoch) await this.selectThread(result.thread.id); return result.thread.id; }
    catch (failure) { if (e === this.epoch) this.notify(failure.message); }
    finally { if (e === this.epoch) { this.busy = false; this.emit(); } }
  }
  async threadAction(action, value) {
    const id = this.threadId, e = this.epoch, s = this.selection;
    if ((!this.canControl && action !== 'unarchive') || !this.ready || this.busy || !id) return;
    if (['rollback', 'archive', 'fork'].includes(action) && this.activeTurn) { this.notify('请先等待任务结束或停止任务。'); return; }
    this.busy = true; this.emit();
    try {
      let result;
      if (action === 'rename') { const name = String(value || '').trim(); if (!name || name.length > 1000) throw error('聊天名称需为 1–1000 字符。'); result = await this.connection.request('thread/name/set', {threadId: id, name}); if (this.valid(e, s)) { this.current.name = name; this.threads = this.threads.map(thread => thread.id === id ? {...thread, name} : thread); } }
      else if (action === 'fork') {
        result = await this.connection.request('thread/fork', {threadId: id}); if (!this.valid(e, s)) return;
        const index = value ? this.current.turns.findIndex(turn => turn.id === value) : -1, later = index >= 0 ? this.current.turns.length - index - 1 : 0;
        if (later > 0) await this.connection.request('thread/rollback', {threadId: result.thread.id, numTurns: later}); if (!this.valid(e, s)) return;
        this.busy = false; await this.loadThreads(); if (this.valid(e, s)) await this.selectThread(result.thread.id);
      } else if (action === 'rollback') {
        const index = (this.current.turns || []).findIndex(turn => turn.id === value); if (index < 0 || this.beginningIndex >= 0) throw error('请返回最新消息并加载该轮及后续内容，再执行回退。');
        result = await this.connection.request('thread/rollback', {threadId: id, numTurns: this.current.turns.length - index}); if (!this.valid(e, s)) return;
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
    if (event.id !== undefined) { this.approvals.set(JSON.stringify(event.id), event); this.emit(); return; }
    if (event.method === 'serverRequest/resolved') { this.approvals.delete(JSON.stringify(p.requestId)); this.approvalAnswers.delete(JSON.stringify(p.requestId)); this.emit(); return; }
    if (['lanpower/error', 'lanpower/approvalError'].includes(event.method)) { this.notify(p.message || '操作未完成，请恢复会话确认。'); this.reconcile(); return; }
    const oldTurn = event.method === 'turn/completed' && this.activeTurns.get(id) !== (p.turn && p.turn.id);
    if (event.method === 'turn/started' && id && p.turn && p.turn.id) this.activeTurns.set(id, p.turn.id);
    if (event.method === 'turn/completed' && !oldTurn) this.activeTurns.delete(id);
    if (event.method === 'thread/name/updated') { const name = p.threadName || p.name; this.threads = this.threads.map(thread => thread.id === id ? {...thread, name} : thread); if (this.current && this.current.id === id) this.current.name = name; }
    if (event.method === 'thread/settings/updated' && id) { const key = this.deviceId + ':' + id, settings = this.settings.get(key) || newSettings(); this.settings.set(key, settings); observeSettings(settings, p.settings || p, modelId(this.models[0] || {})); }
    if (event.method === 'thread/started') { void this.loadThreads(); return; }
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
      if (p.turnId === this.activeTurn) this.overlay.label = event.method === 'item/completed' ? '正在思考' : item && item.type === 'agentMessage' ? '正在撰写回复' : item && item.type === 'commandExecution' ? '正在运行命令' : '正在思考';
    } else if (event.method === 'turn/plan/updated' && (!p.turnId || p.turnId === this.activeTurn)) this.overlay.plan = (p.plan || []).map(step => ({step: step.step, status: step.status}));
    else if (event.method === 'error' && (!p.turnId || p.turnId === this.activeTurn)) this.overlay.error = p.error && p.error.message || '任务出错，请查看原窗口。';
    if (event.method === 'turn/completed') this.reconcile(); this.emit();
  }
  reconcile() {
    clearTimeout(this.reconcileTimer); const e = this.epoch;
    this.reconcileTimer = setTimeout(() => { if (e !== this.epoch || !this.ready) return; if (this.busy || this.syncing || this.loadingThread || this.readingHistory) { this.reconcile(); return; } void this.refreshStatus(); void this.refreshCurrent(); }, 500);
  }
  messages(imageView) { this.rows = projectConversation(this.current, this.expandedTurns, this.expandedActivities); return conversationWindow(this.rows, this.windowOffset, imageView); }
  toggleRow(key, turnId) { const set = key.startsWith('activity:') ? this.expandedActivities : this.expandedTurns, value = key.startsWith('activity:') ? key : turnId; if (set.has(value)) set.delete(value); else set.add(value); this.emit(); }
  async earlier() {
    const view = this.messages(); if (view.windowStart > 0) { this.windowOffset = Math.max(0, view.windowStart - 24); this.emit(); return; }
    if (!this.ready || !this.historyCursor || this.readingHistory || this.beginningIndex >= 0) return;
    const e = this.epoch, s = this.selection, scope = this.historyScope = new ReadScope(); this.readingHistory = true; this.emit();
    try { const page = await readPage(this.connection, this.threadId, this.historyCursor, scope); if (!this.valid(e, s)) return; const cursor = advanceCursor(this.historyCursor, page.nextCursor, this.historySeen), existing = new Set(this.current.turns.map(turn => turn.id)); this.current.turns = [...(page.data || []).slice().reverse().filter(turn => !existing.has(turn.id)), ...this.current.turns]; this.historyCursor = cursor; this.windowOffset = 0; }
    catch (failure) { if (this.valid(e, s) && failure.code !== 'CANCELLED') this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.readingHistory = false; this.emit(); void this.restoreContent(); } }
  }
  laterWindow() { const view = this.messages(); this.windowOffset = view.windowEnd >= view.totalMessages ? null : Math.min(view.windowStart + 24, Math.max(0, view.totalMessages - 36)); this.emit(); }
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
    try { const page = await readPage(this.connection, this.threadId, this.beginning.pages[index], scope); if (!this.valid(e, s)) return; this.current.turns = (page.data || []).slice().reverse(); this.beginningIndex = index; this.windowOffset = 0; this.contentReader = null; }
    catch (failure) { if (this.valid(e, s) && failure.code !== 'CANCELLED') this.notify(failure.message); }
    finally { if (this.valid(e, s)) { this.readingHistory = false; this.emit(); void this.restoreContent(); } }
  }
  cancelHistory() { if (this.historyScope) this.historyScope.cancel(); if (this.contentScope) this.contentScope.cancel(); clearTimeout(this.contentRetry); }
  async restoreContent() {
    if (!this.ready || !this.current || this.loadingThread || this.restoringContent) return;
    const e = this.epoch, s = this.selection, run = this.contentRun, scope = this.contentScope = new ReadScope(), reader = this.contentReader = this.contentReader || new ContentReader(this.threadId); this.restoringContent = true;
    const valid = () => this.valid(e, s) && run === this.contentRun;
    try {
      while (valid()) {
        const turn = this.current.turns.find(value => (value.items || []).some(item => item.type === 'lanpowerLargeItem')); if (!turn) break;
        const item = turn.items.find(value => value.type === 'lanpowerLargeItem'); this.contentProgress[item.reference] = {loaded: 0, error: ''};
        try { await reader.read(this.connection, item, scope, loaded => { if (valid()) { this.contentProgress[item.reference] = {loaded, error: ''}; this.emit(); } }); if (!valid()) return; this.current.turns = reader.apply(this.current.turns); this.emit(); }
        catch (failure) {
          if (!valid() || failure.code === 'CANCELLED') return;
          if (failure.code === 'history_reference_expired') { reader.forget(item.reference); const refreshed = await refreshTurn(this.connection, this.threadId, turn.id, scope); if (!valid()) return; this.current.turns = this.current.turns.map(value => value.id === turn.id ? refreshed : value); continue; }
          this.contentProgress[item.reference].error = failure.message; this.emit(); break;
        }
      }
    } catch (failure) { if (valid() && failure.code !== 'CANCELLED') this.notify(failure.message); }
    finally { if (run === this.contentRun) { this.restoringContent = false; if (valid() && Object.values(this.contentProgress).some(value => value.error)) { clearTimeout(this.contentRetry); this.contentRetry = setTimeout(() => void this.restoreContent(), 5000); } } }
  }
  liveLabel() {
    if (!this.ready) return '任务状态待恢复'; if (this.selectedApprovals.length) return '等待你的回复'; if (!this.activeTurn) return '当前无运行任务'; if (this.interrupting) return '正在停止'; return this.overlay.label || '正在工作';
  }
  duration() { const turn = this.current && (this.current.turns || []).find(value => value.id === this.activeTurn), start = timestamp(turn && turn.startedAt || this.current && this.current.live && this.current.live.startedAt); return start ? elapsed((Date.now() - start) / 1000) : ''; }
  dispose() { this.epoch++; this.resetHistory(); clearTimeout(this.reconcileTimer); clearTimeout(this.libraryTimer); clearTimeout(this.contentRetry); this.resources.reset(); this.drafts.clear(); this.settings.clear(); this.receipts.clear(); this.connection.stop(); }
}
module.exports = {CodexController};
