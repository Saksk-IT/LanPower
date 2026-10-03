type TurnTiming = { startedAt?: unknown; completedAt?: unknown; durationMs?: unknown }

export function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function turnDurationMs(turn: TurnTiming): number | undefined {
  if (typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs >= 0) return turn.durationMs
  const start = timestampMs(turn.startedAt), end = timestampMs(turn.completedAt)
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined
}

export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60
  return `${hours ? `${hours}小时 ` : ''}${minutes ? `${minutes}分钟 ` : ''}${rest}秒`
}

// Only a summary exposed by the original window is displayed; never infer hidden reasoning.
export function reasoningSummary(item: { summary?: unknown }): string {
  return Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n') : ''
}
