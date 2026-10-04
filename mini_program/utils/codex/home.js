const {timestamp} = require('./model');

const HOME_ORDERS = ['project', 'updated', 'priority'];
function homePreferences(value) {
  return {order: HOME_ORDERS.includes(value && value.order) ? value.order : 'project', recentFirst: !value || value.recentFirst !== false};
}

function homeLibrary(library, preferences, filter, pendingIds, pinnedIds) {
  const groups = filter === 'chats' ? [] : library.projects;
  const unique = new Map();
  for (const row of [...library.chats, ...groups.flatMap(group => group.threads)]) if (!unique.has(row.id)) unique.set(row.id, row);
  const pending = new Set(pendingIds), pinned = new Set(pinnedIds);
  const priority = row => pending.has(row.id) ? 0 : row.running ? 1 : pinned.has(row.id) ? 2 : 3;
  const recent = [...unique.values()].sort((a, b) =>
    (preferences.order === 'priority' ? priority(a) - priority(b) : 0) ||
    (timestamp(b.updatedAt) || timestamp(b.createdAt) || 0) - (timestamp(a.updatedAt) || timestamp(a.createdAt) || 0) || a.id.localeCompare(b.id));
  return {groups, recent, timeline: preferences.order !== 'project' || filter === 'chats'};
}

function quotaSummary(snapshots) {
  return snapshots.flatMap((snapshot, index) => [snapshot.primary, snapshot.secondary].filter(Boolean).map((window, slot) => {
    const minutes = window.windowDurationMins;
    const label = minutes === 10080 ? '每周' : minutes && minutes % 60 === 0 ? minutes / 60 + ' 小时' : minutes ? minutes + ' 分钟' : '当前窗口';
    return {id: (snapshot.limitId || String(index)) + ':' + slot,
      label: snapshots.length > 1 ? (snapshot.limitName || snapshot.limitId || '额度') + ' · ' + label : label,
      remaining: Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))};
  }));
}

module.exports = {homePreferences, homeLibrary, quotaSummary};
