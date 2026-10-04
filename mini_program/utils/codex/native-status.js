// Native data only. Shared by the browser adapter and the WeChat controller.
const PAGE_SIZE = 24;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function quotaWindow(value) {
  const row = object(value), used = row && number(row.usedPercent ?? row.used_percent);
  if (used === null || used > 100 || !row) return null;
  const minutes = number(row.windowDurationMins ?? row.window_minutes);
  return {usedPercent: used, windowDurationMins: minutes, windowMinutes: minutes, resetsAt: number(row.resetsAt ?? row.resets_at)};
}
function quotaSnapshot(value, id) {
  const row = object(value); if (!row) return null;
  const primary = quotaWindow(row.primary), secondary = quotaWindow(row.secondary), source = object(row.credits);
  const credits = source && typeof source.hasCredits === 'boolean' && typeof source.unlimited === 'boolean'
    ? {hasCredits: source.hasCredits, unlimited: source.unlimited, balance: text(source.balance)} : null;
  if (!primary && !secondary && !credits) return null;
  return {limitId: text(row.limitId ?? row.limit_id) || id || null, limitName: text(row.limitName ?? row.limit_name), primary, secondary, credits, planType: text(row.planType ?? row.plan_type)};
}
function quotaSnapshots(value) {
  const row = object(value); if (!row) return [];
  if (text(row.unavailableReason)) throw new Error(row.unavailableReason);
  const snapshots = new Map(), buckets = object(row.rateLimitsByLimitId ?? row.rate_limits_by_limit_id);
  for (const [id, value] of Object.entries(buckets || {})) { const snapshot = quotaSnapshot(value, id); if (snapshot) snapshots.set(snapshot.limitId, snapshot); }
  const primary = quotaSnapshot(row.rateLimits ?? row.rate_limits);
  if (primary && (primary.limitId || !snapshots.size)) snapshots.set(primary.limitId || '__default__', primary);
  return Array.from(snapshots.values());
}
function tokenUsage(value) {
  const row = object(value); if (!row) return null;
  const keys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  const normalize = source => object(source) && keys.every(key => number(source[key]) !== null) ? Object.fromEntries(keys.map(key => [key, source[key]])) : null;
  const total = normalize(row.total), last = normalize(row.last); if (!total || !last) return null;
  const rawWindow = number(row.modelContextWindow ?? row.model_context_window), window = rawWindow > 0 ? rawWindow : null;
  return {total, last, modelContextWindow: window, currentContextTokens: last.totalTokens,
    remainingContextTokens: window === null ? null : Math.max(0, window - last.totalTokens),
    remainingContextPercent: window === null ? null : Math.max(0, Math.min(100, Math.round((window - last.totalTokens) / window * 100)))};
}
function capabilityStatus(kind, row) {
  const result = (state, label, reason) => ({state, label, reason});
  if (kind === 'plugin' && row.installed === false) return result('not-installed', '未安装', '原生目录明确返回尚未安装。');
  if (row.enabled === false || kind === 'app' && row.isEnabled === false) return result('disabled', '未启用', '原生目录明确返回此能力未启用。');
  if (kind === 'app') {
    if (row.isAccessible === false) return result('needs-auth', '需授权', '原生目录未授予访问权限，请在原 Codex 窗口连接或授权。');
    if (row.isAccessible === true && row.isEnabled === true) return result('installed', '已安装', '原生目录确认已接入并启用；实际工具权限在使用时检查。');
  } else if (kind === 'mcp') {
    if (row.authStatus === 'notLoggedIn') return result('needs-auth', '需授权', '原生 MCP 服务明确要求登录。');
    if (['oAuth', 'bearerToken'].includes(row.authStatus)) return result('installed', '已安装', '原生 MCP 服务确认认证；实际工具权限在使用时检查。');
  } else {
    if (row.installed === false) return result('not-installed', '未安装', '原生目录明确返回尚未安装。');
    if ((kind === 'skill' || row.installed === true) && row.enabled === true) return result('installed', '已安装', '原生目录确认已安装并启用；实际工具权限在使用时检查。');
  }
  return result('unknown', '未知', kind === 'mcp' ? '原生 MCP 服务未确认认证或就绪状态。' : '原生目录未提供完整的安装、启用或访问状态。');
}
function directoryRows(kind, value) {
  const row = object(value); if (!row) throw new Error('原生接口未返回能力目录。');
  if (text(row.unavailableReason)) throw new Error(row.unavailableReason);
  const errors = kind === 'skill' ? (row.data || []).flatMap(entry => entry.errors || []) : row.marketplaceLoadErrors || [];
  if (errors.length) throw new Error(errors.map(error => text(error && error.message) || text(error && error.error) || text(error) || '原生目录加载失败。').join('；'));
  if (kind === 'plugin') {
    if (!Array.isArray(row.marketplaces)) throw new Error('原生插件接口未返回市场目录。');
    return row.marketplaces.flatMap(market => (market.plugins || []).map(plugin => ({...plugin, path: plugin.id || `${market.name}/${plugin.name}`, displayName: plugin.interface && plugin.interface.displayName || plugin.name, description: plugin.description || plugin.interface && plugin.interface.shortDescription, marketplace: market.name})));
  }
  if (!Array.isArray(row.data)) throw new Error('原生接口未返回目录页。');
  return kind === 'skill' ? row.data.flatMap(entry => entry.skills || []) : row.data;
}
class NativeDirectory {
  constructor(client, valid, changed, paging = () => true) { this.client = client; this.valid = valid; this.changed = changed; this.paging = paging; this.reset(); }
  reset() { this.revision = (this.revision || 0) + 1; this.cursors = ['']; this.state = {kind: 'skill', cwd: '', rows: [], loading: false, error: '', page: 1, nextCursor: ''}; }
  async load(kind, cwd = '', cursor = '', page = 1, refresh = false) {
    const revision = ++this.revision;
    if (!cursor) this.cursors = [''];
    this.state = {kind, cwd, rows: [], loading: true, error: '', page, nextCursor: ''}; this.changed();
    try {
      if (['skill', 'plugin'].includes(kind) && !this.paging()) throw new Error('电脑端未提供目录分页，请更新电脑端和 Cloud 后重连。');
      const methods = {skill: 'skills/list', plugin: 'plugin/list', app: 'app/list', mcp: 'mcpServerStatus/list', automations: 'lanpower/automations/list'};
      const params = {...(['skill', 'plugin'].includes(kind) && cwd ? {cwd} : {}), ...(kind !== 'automations' ? {limit: PAGE_SIZE} : {}), ...(cursor ? {cursor} : {}), ...(['skill', 'plugin'].includes(kind) && refresh ? {refresh: true} : {})};
      const result = await this.client.request(methods[kind], params); if (revision !== this.revision || !this.valid()) return;
      const rows = directoryRows(kind, result), next = text(result.nextCursor) || '';
      if (next && (next === cursor || this.cursors.slice(0, page).includes(next))) throw new Error('原生目录游标未推进，请刷新。');
      if (kind !== 'automations' && rows.length > PAGE_SIZE) throw new Error('电脑端未返回有界目录页，请更新电脑端后刷新。');
      this.state.rows = rows; this.state.nextCursor = next; this.cursors = [...this.cursors.slice(0, page - 1), cursor];
    } catch (failure) { if (revision === this.revision && this.valid()) this.state.error = failure.message || '原生目录不可取得。'; }
    finally { if (revision === this.revision) { this.state.loading = false; this.changed(); } }
  }
  next() { const s = this.state; if (!s.loading && s.nextCursor) return this.load(s.kind, s.cwd, s.nextCursor, s.page + 1); }
  previous() { const s = this.state; if (!s.loading && s.page > 1) return this.load(s.kind, s.cwd, this.cursors[s.page - 2], s.page - 1); }
}
class NativeUsage {
  constructor(client, valid, changed) { this.client = client; this.valid = valid; this.changed = () => {}; this.reset(); this.changed = changed; }
  reset(reason = '连接所选电脑后读取原生额度与用量。') { this.revision = (this.revision || 0) + 1; this.quotaVersion = (this.quotaVersion || 0) + 1; this.pending = null; this.usage = new Map(); this.state = {snapshots: [], loading: false, reason}; this.changed(); }
  async readQuota() {
    if (!this.valid()) return;
    if (this.pending) return this.pending;
    const revision = this.revision, version = ++this.quotaVersion;
    this.state = {snapshots: [], loading: true, reason: ''}; this.changed();
    this.pending = (async () => {
      try {
        const result = await this.client.request('account/rateLimits/read'); if (revision !== this.revision || version !== this.quotaVersion || !this.valid()) return;
        const snapshots = quotaSnapshots(result); this.state = {snapshots, loading: false, reason: snapshots.length ? '' : '原生接口未返回额度窗口或积分；未推测剩余额度。'};
      } catch (failure) { if (revision === this.revision && version === this.quotaVersion && this.valid()) this.state = {snapshots: [], loading: false, reason: failure.message || '原生额度不可取得。'}; }
      finally { if (revision === this.revision) { this.pending = null; this.changed(); } }
    })();
    return this.pending;
  }
  event(method, params) {
    if (!this.valid()) return false;
    if (method === 'account/rateLimits/updated') {
      this.quotaVersion++;
      try { const snapshots = quotaSnapshots(params), merged = new Map(this.state.snapshots.map(snapshot => [snapshot.limitId || '__default__', snapshot]));
        for (const snapshot of snapshots) merged.set(snapshot.limitId || '__default__', snapshot);
        this.state = snapshots.length ? {snapshots: Array.from(merged.values()), loading: false, reason: ''} : {snapshots: [], loading: false, reason: '最新原生额度通知未提供完整额度数据。'};
      } catch (failure) { this.state = {snapshots: [], loading: false, reason: failure.message}; }
      this.changed(); return true;
    }
    if (method !== 'thread/tokenUsage/updated') return false;
    const id = text(params.threadId ?? params.thread_id); if (!id) return true;
    const usage = tokenUsage(params.tokenUsage ?? params.token_usage);
    this.usage.delete(id); this.usage.set(id, {usage, reason: usage ? usage.modelContextWindow ? '' : '原生事件未提供上下文窗口，只显示实际 token 用量。' : '最新原生用量通知字段不完整，不能计算上下文。'});
    while (this.usage.size > 128) this.usage.delete(this.usage.keys().next().value);
    this.changed(); return true;
  }
  context(id) { return this.usage.get(id) || {usage: null, reason: !this.valid() ? '电脑连接未就绪，无法确认当前上下文。' : !id ? '选择聊天后读取该会话的原生用量。' : '尚未收到此会话的原生用量通知。'}; }
}
module.exports = {PAGE_SIZE, quotaSnapshots, tokenUsage, capabilityStatus, directoryRows, NativeDirectory, NativeUsage};
