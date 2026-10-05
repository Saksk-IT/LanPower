const MAX_AGE = 30 * 60 * 1000;
const MAX_THREADS = 300;

function cacheKey(scope, deviceId) { return `${scope}:computer:${encodeURIComponent(deviceId)}`; }

function summary(thread) {
  const value = {};
  for (const key of ['id', 'name', 'preview', 'cwd', 'projectPath', 'projectName', 'control', 'createdAt', 'updatedAt', 'isChat', 'archived'])
    if (['string', 'number', 'boolean'].includes(typeof thread[key])) value[key] = thread[key];
  if (thread.status && typeof thread.status.type === 'string') value.status = {type: thread.status.type};
  return value;
}

function librarySummary(library) {
  const source = library && library.preferences || {}, preferences = {};
  for (const key of ['collapsed', 'pinned', 'hidden', 'order']) preferences[key] = Array.isArray(source[key]) ? source[key].filter(value => typeof value === 'string') : [];
  for (const key of ['aliases', 'sections']) preferences[key] = Object.fromEntries(Object.entries(source[key] || {}).filter(([, value]) => typeof value === 'string'));
  preferences.sort = source.sort === 'created' ? 'created' : 'updated'; preferences.chatsFirst = source.chatsFirst === true;
  return {revision: Number.isSafeInteger(library && library.revision) ? library.revision : 0, preferences};
}

function readShellSnapshot(wxApi, scope, deviceId) {
  if (!wxApi || !scope || !deviceId) return null;
  try {
    const value = wxApi.getStorageSync(cacheKey(scope, deviceId));
    if (!value || value.version !== 1 || value.deviceId !== deviceId || !Array.isArray(value.threads) ||
        typeof value.updatedAt !== 'number' || Date.now() - value.updatedAt > MAX_AGE) return null;
    return {version: 1, deviceId, threadId: typeof value.threadId === 'string' ? value.threadId : '', archived: value.archived === true,
      threads: value.threads.filter(thread => thread && typeof thread.id === 'string').slice(0, MAX_THREADS).map(summary), library: librarySummary(value.library), updatedAt: value.updatedAt};
  } catch (_) { return null; }
}

function writeShellSnapshot(wxApi, scope, snapshot) {
  if (!wxApi || !scope || !snapshot || !snapshot.deviceId) return;
  try {
    wxApi.setStorageSync(cacheKey(scope, snapshot.deviceId), {version: 1, deviceId: snapshot.deviceId,
      threadId: snapshot.threadId || '', archived: snapshot.archived === true,
      threads: (snapshot.threads || []).filter(thread => thread && typeof thread.id === 'string').slice(0, MAX_THREADS).map(summary),
      library: librarySummary(snapshot.library), updatedAt: Date.now()});
  } catch (_) { /* 缓存不可用时继续使用远端原生状态。 */ }
}

module.exports = {readShellSnapshot, writeShellSnapshot};
