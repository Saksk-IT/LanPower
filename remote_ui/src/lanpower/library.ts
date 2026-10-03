import { isProjectlessChatPath, normalizePathForComparison } from '../pathUtils'

export type LibraryThread = { id: string; title: string; cwd: string; projectPath?: string; projectName?: string; isChat?: boolean; createdAt: number; updatedAt: number; status?: any }
export type LibraryProject = { name: string; path: string; kind?: string }
export type LibraryGroup = { id: string; name: string; path: string; threads: LibraryThread[] }
export type LibraryPreferences = { collapsed: string[]; pinned: string[]; hidden: string[]; order: string[]; aliases: Record<string, string>; sections: Record<string, boolean>; sort: 'created' | 'updated'; chatsFirst: boolean }
export function defaultLibraryPreferences(): LibraryPreferences { return { collapsed: [], pinned: [], hidden: [], order: [], aliases: {}, sections: {}, sort: 'updated', chatsFirst: false } }
export function libraryKey(path: string): string { return normalizePathForComparison(path).replace(/\/$/u, '') }
export function isChatThread(thread: LibraryThread): boolean { return thread.isChat === true || !thread.cwd || isProjectlessChatPath(thread.cwd) }
export function libraryThread(native: any): LibraryThread {
  return { ...native, title: native.name?.trim() || native.preview?.trim().split('\n')[0] || '新聊天', cwd: native.cwd || '', createdAt: native.createdAt || 0, updatedAt: native.updatedAt || native.createdAt || 0 }
}
export function buildLibrary(projects: LibraryProject[], threads: LibraryThread[], preferences: LibraryPreferences, query = ''): { projects: LibraryGroup[]; chats: LibraryThread[]; pinned: LibraryThread[] } {
  const groups = new Map<string, LibraryGroup>()
  for (const project of projects) if (project.kind !== 'chat' && !isProjectlessChatPath(project.path)) {
    const id = libraryKey(project.path)
    if (!groups.has(id)) groups.set(id, { id, name: preferences.aliases[id] || project.name, path: project.path, threads: [] })
  }
  const chats: LibraryThread[] = []
  for (const thread of threads) {
    if (isChatThread(thread)) { chats.push(thread); continue }
    const cwd = libraryKey(thread.cwd)
    const explicit = thread.projectPath && libraryKey(thread.projectPath)
    let group = explicit && groups.get(explicit)
    if (!group) group = [...groups.values()].filter(p => cwd === p.id || cwd.startsWith(p.id + '/')).sort((a,b) => b.id.length - a.id.length)[0]
    if (!group) {
      const path = thread.projectPath || thread.cwd, id = libraryKey(path)
      group = { id, name: preferences.aliases[id] || thread.projectName || path.replace(/\\/g, '/').split('/').pop() || '项目', path, threads: [] }; groups.set(id, group)
    }
    group.threads.push(thread)
  }
  const matches = (t: LibraryThread) => `${t.title} ${t.cwd} ${t.projectName || ''}`.toLowerCase().includes(query.trim().toLowerCase())
  const sort = (a: LibraryThread, b: LibraryThread) => (preferences.sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)
  let result = [...groups.values()].filter(g => !preferences.hidden.includes(g.id) || Boolean(query))
  for (const group of result) { if (query && !group.name.toLowerCase().includes(query.toLowerCase())) group.threads = group.threads.filter(matches); group.threads.sort(sort) }
  if (query) result = result.filter(g => g.threads.length || g.name.toLowerCase().includes(query.toLowerCase()))
  const rank = (id: string) => { const index = preferences.order.indexOf(id); return index < 0 ? preferences.order.length : index }
  result.sort((a,b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name, 'zh-CN'))
  return { projects: result, chats: chats.filter(matches).sort(sort), pinned: preferences.pinned.map(id => threads.find(t => t.id === id)).filter((t): t is LibraryThread => Boolean(t && matches(t))) }
}
