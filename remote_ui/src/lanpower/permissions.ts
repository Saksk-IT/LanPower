export type PermissionPreset = 'ask' | 'auto-review' | 'full-access'
export type PermissionMode = PermissionPreset | 'custom' | 'unknown'
export type NativePermissions = { approvalPolicy?: unknown; approvalsReviewer?: unknown; sandbox?: any; activePermissionProfile?: any }
export const permissionLabels: Record<PermissionMode,string> = {ask:'请求批准','auto-review':'帮我批准','full-access':'完全访问权限',custom:'自定义权限',unknown:'权限未提供'}

export function observePermissions(previous: NativePermissions | null, source: any): NativePermissions | null {
  const next = {...previous}; let changed = false
  for (const key of ['approvalPolicy','approvalsReviewer','sandbox','activePermissionProfile'] as const) {
    if (Object.hasOwn(source,key)) { next[key] = source[key]; changed = true }
  }
  if (Object.hasOwn(source,'sandboxPolicy')) { next.sandbox = source.sandboxPolicy; changed = true }
  return changed ? next : previous
}

export function permissionMode(settings: NativePermissions | null, cwd: string): PermissionMode {
  if (!settings?.sandbox || !settings.approvalPolicy || !settings.approvalsReviewer) return 'unknown'
  const policy = settings.sandbox
  if (settings.activePermissionProfile?.id && !settings.activePermissionProfile.id.startsWith(':')) return 'custom'
  if (policy.type === 'dangerFullAccess' && settings.approvalPolicy === 'never') return 'full-access'
  const canonical = (path: string) => path.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()
  if (policy.type === 'workspaceWrite' && policy.networkAccess === false && settings.approvalPolicy === 'on-request' &&
      Array.isArray(policy.writableRoots) && policy.writableRoots.every((path: unknown) => typeof path === 'string' && canonical(path) === canonical(cwd))) {
    if (settings.approvalsReviewer === 'user') return 'ask'
    if (settings.approvalsReviewer === 'auto_review' || settings.approvalsReviewer === 'guardian_subagent') return 'auto-review'
  }
  return 'custom'
}
