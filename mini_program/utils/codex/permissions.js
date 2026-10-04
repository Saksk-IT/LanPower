// Keep the mobile projection consistent with the website and confirmed native settings.
const permissionOptions = [
  {value: 'ask', name: '请求批准', description: '编辑外部文件和使用互联网前先询问', icon: 'hand'},
  {value: 'auto-review', name: '替我批准', description: '检测到可能不安全的操作时询问', icon: 'shield'},
  {value: 'full-access', name: '完全访问', description: '完全访问计算机（风险较高）', icon: 'warning'},
  {value: 'custom', name: '自定义（config.toml）', description: '使用电脑配置中定义的权限', icon: 'settings'}
];
const permissionLabels = Object.fromEntries([...permissionOptions.map(row => [row.value, row.name]), ['unknown', '批准状态待确认']]);
function observePermissions(previous, source) {
  const next = {...previous}; let changed = false;
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile']) {
    if (Object.prototype.hasOwnProperty.call(source, key)) { next[key] = source[key]; changed = true; }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sandboxPolicy')) { next.sandbox = source.sandboxPolicy; changed = true; }
  return changed ? next : previous;
}
function permissionMode(settings, cwd = '') {
  if (!settings || !settings.sandbox || !settings.approvalPolicy || !settings.approvalsReviewer) return 'unknown';
  if (settings.activePermissionProfile && settings.activePermissionProfile.id && !settings.activePermissionProfile.id.startsWith(':')) return 'custom';
  const policy = settings.sandbox;
  if (policy.type === 'dangerFullAccess' && settings.approvalPolicy === 'never') return 'full-access';
  const canonical = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (policy.type === 'workspaceWrite' && policy.networkAccess === false && settings.approvalPolicy === 'on-request'
      && Array.isArray(policy.writableRoots) && policy.writableRoots.every(path => typeof path === 'string' && canonical(path) === canonical(cwd))) {
    if (settings.approvalsReviewer === 'user') return 'ask';
    if (['auto_review', 'guardian_subagent'].includes(settings.approvalsReviewer)) return 'auto-review';
  }
  return 'custom';
}
module.exports = {permissionOptions, permissionLabels, observePermissions, permissionMode};
