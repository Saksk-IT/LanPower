const {previewText} = require('./conversation');
class ResourceBrowser {
  constructor(client, valid, changed) { this.client = client; this.valid = valid; this.changed = changed; this.sequence = 0; this.reset(); }
  reset() { this.sequence++; this.state = {cwd: '', directory: '.', branch: '', files: [], cursor: '', query: '', selected: null, loading: false, error: '', truncated: false}; this.catalog = {kind: 'skill', cwd: '', rows: [], loading: false, error: ''}; }
  async files(method, params, append = false) {
    const sequence = ++this.sequence, cwd = this.state.cwd; this.state.loading = true; this.state.error = ''; this.changed();
    try {
      const result = await this.client.request(method, {cwd, ...params}); if (!this.valid() || sequence !== this.sequence) return;
      if (method === 'lanpower/files/read') this.state.selected = result;
      else {
        if (append && result.nextCursor && result.nextCursor === this.state.cursor) throw new Error('文件游标未推进。');
        this.state.files = [...(append ? this.state.files : []), ...(result.data || [])]; this.state.cursor = result.nextCursor || ''; this.state.branch = result.branch || this.state.branch; this.state.truncated = !!result.truncated;
      }
    } catch (error) { if (sequence === this.sequence) this.state.error = error.message; }
    finally { if (sequence === this.sequence) { this.state.loading = false; this.changed(); } }
  }
  open(cwd, path = '') { this.reset(); this.state.cwd = cwd; return path ? this.files('lanpower/files/read', {path}) : this.directory('.'); }
  directory(path) { this.state.directory = path; this.state.query = ''; this.state.selected = null; return this.files('lanpower/files/list', {path}); }
  search(query) { this.state.query = query; this.state.selected = null; return query.trim() ? this.files('lanpower/files/search', {query: query.trim()}) : this.directory(this.state.directory); }
  more() { if (!this.state.cursor || this.state.loading) return; return this.files('lanpower/files/list', {path: this.state.directory, cursor: this.state.cursor}, true); }
  async directoryCatalog(kind, cwd) {
    const sequence = ++this.sequence; this.catalog = {kind, cwd, rows: [], loading: true, error: ''}; this.changed();
    const methods = {skill: 'skills/list', plugin: 'plugin/list', app: 'app/list', mcp: 'mcpServerStatus/list', automations: 'lanpower/automations/list'};
    try {
      let cursor = ''; const all = [], seen = new Set();
      do {
        const params = ['skill', 'plugin'].includes(kind) && cwd ? {cwd} : {}; if (cursor) params.cursor = cursor; if (['app', 'mcp'].includes(kind)) params.limit = 50;
        const result = await this.client.request(methods[kind], params); if (!this.valid() || sequence !== this.sequence) return;
        const page = kind === 'skill' ? (result.data || []).flatMap(entry => entry.skills || []) : kind === 'plugin' ? (result.marketplaces || []).flatMap(entry => (entry.plugins || []).map(row => ({...row, displayName: row.interface && row.interface.displayName || row.name, description: row.description || row.interface && row.interface.shortDescription, marketplace: entry.name}))) : result.data || [];
        all.push(...page); const next = result.nextCursor || ''; if (next && (seen.has(next) || next === cursor)) throw new Error('能力目录游标未推进。'); if (next) seen.add(next); cursor = next;
      } while (cursor);
      this.catalog.rows = Array.from(new Map(all.map(row => [row.path || row.id || row.name, row])).values());
    } catch (error) { if (sequence === this.sequence) this.catalog.error = error.message; }
    finally { if (sequence === this.sequence) { this.catalog.loading = false; this.changed(); } }
  }
  fileView() {
    const state = this.state, parts = state.directory.replace(/\\/g, '/').split('/').filter(part => part !== '.' && part);
    const selected = state.selected, content = selected && selected.content;
    return {...state, files: state.files.map(row => ({name: row.name, path: row.path, directory: !!row.directory})),
      selected: selected ? {path: selected.path, binary: !!selected.binary, tooLarge: !!selected.tooLarge, content: previewText(content, 8000), hasMore: typeof content === 'string' && content.length > 8000} : null,
      parent: parts.slice(0, -1).join('/') || '.', breadcrumbs: parts.map((name, index) => ({name, path: parts.slice(0, index + 1).join('/')}))};
  }
  absolute(path) { return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') ? path : this.state.cwd.replace(/[\\/]+$/, '') + '/' + path; }
}
class ImageCache {
  constructor(wxApi, client) { this.wx = wxApi; this.client = client; this.entries = new Map(); this.generation = 0; this.sequence = 0; }
  async resolve(source, threadId, cwd) {
    const key = threadId + '\0' + source, existing = this.entries.get(key); if (existing) return existing.promise;
    const generation = this.generation, entry = {path: '', size: 0};
    entry.promise = (async () => {
      let result;
      if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(source)) { const split = source.indexOf(','); result = {base64: source.slice(split + 1), contentType: source.slice(5, split).split(';')[0]}; }
      else {
        if (/^https?:/i.test(source)) throw new Error('外部图片请复制链接，在浏览器查看。');
        let path = source;
        if (path.startsWith('/codex-local-image?')) { const match = /[?&]path=([^&]*)/.exec(path); path = match ? decodeURIComponent(match[1]) : ''; }
        if (!/^(file:|[A-Za-z]:[\\/]|\/)/.test(path)) path = cwd.replace(/[\\/]+$/, '') + '/' + path;
        result = await this.client.request('lanpower/image/read', {threadId, path});
      }
      if (generation !== this.generation) throw new Error('连接已变化。');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(result.contentType) || typeof result.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64)) throw new Error('图片格式无效。');
      const bytes = this.wx.base64ToArrayBuffer(result.base64);
      if (bytes.byteLength > 8 * 1048576 || result.size !== undefined && bytes.byteLength !== result.size) throw new Error('图片超限或读取不完整。');
      const fs = this.wx.getFileSystemManager(), path = `${this.wx.env.USER_DATA_PATH}/codex-preview-${generation}-${++this.sequence}.${result.contentType.split('/')[1]}`;
      await new Promise((resolve, reject) => fs.writeFile({filePath: path, data: bytes, success: resolve, fail: reject}));
      if (generation !== this.generation) { fs.unlink({filePath: path, fail: () => {}}); throw new Error('连接已变化。'); }
      entry.path = path; entry.size = bytes.byteLength;
      let total = Array.from(this.entries.values()).reduce((sum, image) => sum + image.size, 0);
      for (const [oldKey, old] of this.entries) { if (this.entries.size <= 24 && total <= 32 * 1048576) break; if (oldKey === key || !old.path) continue; fs.unlink({filePath: old.path, fail: () => {}}); this.entries.delete(oldKey); total -= old.size; }
      return path;
    })().catch(error => { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; });
    this.entries.set(key, entry); return entry.promise;
  }
  clear() { this.generation++; const fs = this.wx.getFileSystemManager && this.wx.getFileSystemManager(); if (fs) for (const entry of this.entries.values()) if (entry.path) fs.unlink({filePath: entry.path, fail: () => {}}); this.entries.clear(); }
}
module.exports = {ResourceBrowser, ImageCache};
