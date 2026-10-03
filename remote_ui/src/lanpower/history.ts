export function mergeHistory(previous: any[], latest: any[]): any[] {
  if (!previous.length) return latest
  if (!latest.length) return previous
  const boundary = previous.findIndex(t => t.id === latest[0]?.id)
  const ids = new Set(latest.map(t => t.id))
  const older = (boundary >= 0 ? previous.slice(0,boundary) : previous).filter(t => !ids.has(t.id))
  return [...older, ...latest]
}
