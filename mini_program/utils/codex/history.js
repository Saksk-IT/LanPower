class ReadScope {
  constructor() { this.cancelled = false; this.listeners = new Set(); }
  check() { if (this.cancelled) { const error = new Error('已取消读取，可以继续。'); error.code = 'CANCELLED'; throw error; } }
  subscribe(callback) { this.check(); this.listeners.add(callback); return () => this.listeners.delete(callback); }
  cancel() { if (this.cancelled) return; this.cancelled = true; for (const listener of Array.from(this.listeners)) listener(); this.listeners.clear(); }
}
async function adaptiveRead(client, method, params, name, scope) {
  for (let limit = 8; ; limit = Math.max(1, Math.floor(limit / 2))) {
    if (scope) scope.check();
    try { await client.paceHistory(scope); return await client.request(method, {...params, [name]: limit}, scope); }
    catch (error) { if (error.code !== 'result_too_large' || limit === 1) throw error; }
  }
}
const readThread = (client, threadId, scope) => adaptiveRead(client, 'thread/read', {threadId, includeTurns: true}, 'historyLimit', scope);
const readPage = (client, threadId, cursor, scope) => adaptiveRead(client, 'thread/turns/list', {threadId, ...(cursor ? {cursor} : {})}, 'limit', scope);
function mergeHistory(previous, latest) {
  if (!latest.length) return previous;
  const boundary = previous.findIndex(turn => turn.id === latest[0].id), ids = new Set(latest.map(t => t.id));
  return [...(boundary >= 0 ? previous.slice(0, boundary) : previous).filter(t => !ids.has(t.id)), ...latest];
}
function advanceCursor(current, next, seen) {
  if (next && (next === current || seen.has(next))) throw new Error('历史游标未推进，请刷新后重试。');
  if (next) seen.add(next); return next || '';
}
const newBeginning = () => ({cursor: '', pages: [], count: 0, complete: false, lastPage: null});
async function findBeginning(client, id, job, scope, progress = () => {}) {
  while (!job.complete) {
    scope.check(); const page = await readPage(client, id, job.cursor, scope); scope.check();
    const next = advanceCursor(job.cursor, page.nextCursor, new Set(job.pages));
    job.pages.push(job.cursor); job.count += (page.data || []).length; job.lastPage = page; job.cursor = next; job.complete = !next; progress(job.count);
  }
  return job.lastPage;
}
class ContentReader {
  constructor(threadId) { this.threadId = threadId; this.jobs = new Map(); }
  async read(client, item, scope, progress = () => {}) {
    let job = this.jobs.get(item.reference);
    if (!job) { job = {offset: 0, parts: [], complete: false}; this.jobs.set(item.reference, job); }
    while (!job.complete) {
      scope.check(); await client.paceHistory(scope);
      const part = await client.request('lanpower/history/item/read', {threadId: this.threadId, reference: item.reference, offset: job.offset}, scope); scope.check();
      const end = job.offset + (typeof part.data === 'string' ? part.data.length : 0);
      if (part.offset !== job.offset || typeof part.data !== 'string' || !part.data.length || part.data.length > 65536 || !Number.isSafeInteger(part.characters) || part.characters !== item.characters || part.characters < end || part.nextOffset !== null && part.nextOffset !== end || part.nextOffset === null && end !== part.characters) {
        this.jobs.delete(item.reference); throw new Error('内容分段不连续，请重新读取。');
      }
      job.parts.push(part.data); job.offset = end; job.complete = part.nextOffset === null; progress(end);
    }
    if (!job.value) {
      try {
        const value = JSON.parse(job.parts.join(''));
        if (!value || value.id !== item.id || (item.wholeTurn ? !Array.isArray(value.items) : value.type !== item.originalType)) throw new Error('内容与会话不匹配，请刷新。');
        job.value = value; job.parts = [];
      } catch (error) { this.jobs.delete(item.reference); throw error; }
    }
    return job.value;
  }
  forget(reference) { this.jobs.delete(reference); }
  apply(turns) {
    return turns.map(turn => {
      const whole = (turn.items || []).find(item => item.type === 'lanpowerLargeItem' && item.wholeTurn), restored = whole && this.jobs.get(whole.reference);
      if (restored && restored.value) return {...restored.value, ...turn, items: restored.value.items};
      return {...turn, items: (turn.items || []).map(item => item.type === 'lanpowerLargeItem' && this.jobs.get(item.reference) && this.jobs.get(item.reference).value || item)};
    });
  }
}
async function refreshTurn(client, threadId, turnId, scope) {
  let cursor = ''; const seen = new Set();
  while (true) { const page = await readPage(client, threadId, cursor, scope), turn = (page.data || []).find(t => t.id === turnId); if (turn) return turn; cursor = advanceCursor(cursor, page.nextCursor, seen); if (!cursor) throw new Error('这一轮已变化，请刷新会话。'); }
}
module.exports = {ReadScope, readThread, readPage, mergeHistory, advanceCursor, newBeginning, findBeginning, ContentReader, refreshTurn};
