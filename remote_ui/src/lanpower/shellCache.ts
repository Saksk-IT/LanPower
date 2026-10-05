export type ShellThread = {
  id: string
  name?: string
  preview?: string
  cwd?: string
  updatedAt?: string | number
  createdAt?: string | number
  status?: unknown
  control?: string
  archived?: boolean
  [key: string]: unknown
}

export type ShellSnapshot = {
  version: 1
  deviceId: string
  threadId: string
  archived: boolean
  threads: ShellThread[]
  library?: unknown
  updatedAt: number
}

const prefix = 'lanpower-codex-shell-v1:'
const maxAge = 30 * 60 * 1000
const maxThreads = 300

function storageKey(deviceId: string): string { return prefix + encodeURIComponent(deviceId) }

function summary(thread: ShellThread): ShellThread {
  const value: ShellThread = {id: thread.id}
  for (const key of ['name', 'preview', 'cwd', 'projectPath', 'projectName', 'control', 'createdAt', 'updatedAt', 'isChat', 'archived'])
    if (['string', 'number', 'boolean'].includes(typeof thread[key])) value[key] = thread[key]
  const status = thread.status as {type?: unknown} | undefined
  if (status && typeof status.type === 'string') value.status = {type: status.type}
  return value
}

function librarySummary(library: unknown): unknown {
  const value = library as {revision?: unknown, preferences?: Record<string, unknown>} | undefined
  const source = value?.preferences || {}, preferences: Record<string, unknown> = {}
  for (const key of ['collapsed', 'pinned', 'hidden', 'order']) preferences[key] = Array.isArray(source[key]) ? source[key].filter(item => typeof item === 'string') : []
  for (const key of ['aliases', 'sections']) preferences[key] = Object.fromEntries(Object.entries(source[key] || {}).filter(([, item]) => typeof item === 'string'))
  preferences.sort = source.sort === 'created' ? 'created' : 'updated'; preferences.chatsFirst = source.chatsFirst === true
  return {revision: Number.isSafeInteger(value?.revision) ? value!.revision : 0, preferences}
}

export function readShellSnapshot(deviceId: string): ShellSnapshot | null {
  if (!deviceId || typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(storageKey(deviceId))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<ShellSnapshot>
    if (value.version !== 1 || value.deviceId !== deviceId || !Array.isArray(value.threads) ||
        typeof value.updatedAt !== 'number' || Date.now() - value.updatedAt > maxAge) return null
    return {
      version: 1,
      deviceId,
      threadId: typeof value.threadId === 'string' ? value.threadId : '',
      archived: value.archived === true,
      threads: value.threads.filter((thread): thread is ShellThread => Boolean(thread && typeof thread === 'object' && typeof thread.id === 'string')).slice(0, maxThreads).map(summary),
      library: librarySummary(value.library),
      updatedAt: value.updatedAt
    }
  } catch { return null }
}

export function writeShellSnapshot(snapshot: Omit<ShellSnapshot, 'version' | 'updatedAt'>): void {
  if (!snapshot.deviceId || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(storageKey(snapshot.deviceId), JSON.stringify({
      version: 1,
      deviceId: snapshot.deviceId,
      threadId: snapshot.threadId || '',
      archived: snapshot.archived === true,
      threads: snapshot.threads.filter(thread => thread && typeof thread.id === 'string').slice(0, maxThreads).map(summary),
      library: librarySummary(snapshot.library),
      updatedAt: Date.now()
    }))
  } catch { /* Storage may be disabled or full; the remote session remains authoritative. */ }
}
