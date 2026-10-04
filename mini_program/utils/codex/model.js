const {projectName, relativeTime} = require('../codex-format');
const clone = value => JSON.parse(JSON.stringify(value));
function pathKey(path) {
  const source = String(path || '').replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
  const value = source.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return /^[a-z]:[\\/]/i.test(source) || source.startsWith('\\\\') ? value.toLowerCase() : value;
}
function isChat(thread) { return thread.isChat || !thread.cwd || /(?:^|\/)Documents\/Codex\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(String(thread.cwd).replace(/\\/g, '/')); }
const defaultPreferences = () => ({collapsed: [], pinned: [], hidden: [], order: [], aliases: {}, sections: {}, sort: 'updated', chatsFirst: false});
function buildLibrary(projects, threads, preferences, query = '') {
  const prefs = {...defaultPreferences(), ...preferences}, groups = new Map(), chats = [], search = query.trim().toLowerCase();
  for (const project of projects) if (project.kind !== 'chat' && !isChat({cwd: project.path})) {
    const id = pathKey(project.path); if (!groups.has(id)) groups.set(id, {id, name: prefs.aliases[id] || project.name, path: project.path, threads: []});
  }
  const rows = threads.map(thread => ({...thread, name: (thread.name || thread.preview || '新聊天').split('\n')[0], time: relativeTime(thread.updatedAt), running: thread.status && thread.status.type === 'active' || thread.live && thread.live.state === 'running'}));
  for (const row of rows) {
    if (isChat(row)) { chats.push(row); continue; }
    const cwd = pathKey(row.cwd), explicit = row.projectPath && groups.get(pathKey(row.projectPath));
    let group = explicit || Array.from(groups.values()).filter(g => cwd === g.id || cwd.startsWith(g.id + '/')).sort((a, b) => b.id.length - a.id.length)[0];
    if (!group) { const path = row.projectPath || row.cwd, id = pathKey(path); group = {id, path, name: prefs.aliases[id] || row.projectName || projectName(path), threads: []}; groups.set(id, group); }
    group.threads.push(row);
  }
  const matches = row => [row.name, row.cwd, row.projectName].join(' ').toLowerCase().includes(search);
  const sort = (a, b) => (prefs.sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id);
  const rank = id => prefs.order.includes(id) ? prefs.order.indexOf(id) : prefs.order.length;
  const all = Array.from(groups.values());
  const visible = all.filter(g => search || !prefs.hidden.includes(g.id)).map(g => ({...g,
    collapsed: !search && prefs.collapsed.includes(g.id),
    threads: g.threads.filter(row => !search || g.name.toLowerCase().includes(search) || matches(row)).sort(sort)
  })).filter(g => !search || g.threads.length || g.name.toLowerCase().includes(search)).sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name, 'zh-CN'));
  return {projects: visible, chats: chats.filter(matches).sort(sort), pinned: prefs.pinned.map(id => rows.find(r => r.id === id)).filter(r => r && matches(r)), hidden: all.filter(g => prefs.hidden.includes(g.id))};
}
const emptyDraft = () => ({text: '', images: [], skills: [], files: [], editingQueue: ''});
const blankSettings = () => ({model: '', effort: '', mode: 'default'});
const newSettings = () => ({native: blankSettings(), overrides: {}, initialized: false});
const effectiveSettings = settings => ({...settings.native, ...settings.overrides});
const modelId = model => model.model || model.id || '';
const validEfforts = model => (model && model.supportedReasoningEfforts || []).map(row => row.reasoningEffort);
function observeSettings(settings, thread, fallback) {
  if (!settings.initialized) { settings.native.model = fallback; settings.initialized = true; }
  if (thread.model) settings.native.model = thread.model;
  if ('reasoningEffort' in thread) settings.native.effort = thread.reasoningEffort || '';
  const mode = thread.collaborationMode && thread.collaborationMode.mode || thread.collaborationMode;
  if (['default', 'plan'].includes(mode)) settings.native.mode = mode;
}
class StateClock {
  constructor() { this.clear(); }
  capture(id) { return id ? this.threads.get(id) || 0 : this.clock; }
  unchanged(stamp, id) { return stamp === this.capture(id); }
  event(id, revision) {
    if (Number.isSafeInteger(revision) && revision < (this.revisions.get(id) || 0)) return false;
    this.threads.set(id, ++this.clock); if (Number.isSafeInteger(revision)) this.revisions.set(id, revision); return true;
  }
  snapshot(id, revision) {
    if (!Number.isSafeInteger(revision)) return true;
    if (revision < (this.revisions.get(id) || 0)) return false;
    this.revisions.set(id, revision); return true;
  }
  clear() { this.clock = 0; this.threads = new Map(); this.revisions = new Map(); }
}
function timestamp(value) { const number = typeof value === 'number' ? value < 1e12 ? value * 1000 : value : Date.parse(value); return Number.isFinite(number) && number > 0 ? number : undefined; }
module.exports = {clone, pathKey, isChat, defaultPreferences, buildLibrary, emptyDraft, newSettings, effectiveSettings, modelId, validEfforts, observeSettings, StateClock, timestamp};
