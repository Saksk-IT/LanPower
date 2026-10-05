const runningStatuses = ['inProgress', 'in_progress', 'running', 'started', 'searching'];

// A restored web record has no item status in some native protocol versions.
// Only a start event or an explicit running status proves that it is still active.
/** @param {any} item @param {string | undefined} turnStatus
 * @returns {{status: 'inProgress'|'completed'|'failed'|'interrupted', summary: string, label: string}} */
function webSearchView(item, turnStatus) {
  const rawStatus = item.status;
  /** @type {'inProgress'|'completed'|'failed'|'interrupted'} */
  let status = item.error || item.success === false || ['failed', 'error', 'declined'].includes(rawStatus) ? 'failed'
    : ['interrupted', 'cancelled', 'canceled'].includes(rawStatus) ? 'interrupted'
    : runningStatuses.includes(rawStatus) ? 'inProgress' : 'completed';
  if (status === 'inProgress' && ['completed', 'failed', 'interrupted'].includes(turnStatus)) {
    status = turnStatus === 'completed' ? 'completed' : 'interrupted';
  }
  const action = item.action || {}, strings = value => (Array.isArray(value) ? value : [value]).filter(part => typeof part === 'string' && part.trim()).map(part => part.trim());
  const queries = strings(action.queries);
  const query = strings(action.query).length ? action.query : item.query;
  const urls = strings(action.urls).length ? action.urls : action.url || action.refId || action.ref_id || item.url;
  const parts = ['openPage', 'open_page', 'open'].includes(action.type) ? strings(urls)
    : ['findInPage', 'find_in_page', 'find'].includes(action.type) ? [...strings(action.pattern || action.term), ...strings(urls)]
    : queries.length ? queries : strings(query).length ? strings(query) : strings(urls);
  const summary = [...new Set(parts)].join(' | ');
  const labels = {inProgress: '正在搜索网页', completed: '已搜索网页', failed: '网页搜索失败', interrupted: '网页搜索已停止'};
  return {status, summary, label: labels[status] + (summary ? '：' + summary : '')};
}

/** @param {any} item @param {string} method */
function updateWebSearchStatus(item, method) {
  if (!item || item.type !== 'webSearch') return;
  if (method === 'item/started') item.status = 'inProgress';
  else if (method === 'item/completed') item.status = webSearchView(item, 'completed').status;
}

module.exports = {webSearchView, updateWebSearchStatus};
