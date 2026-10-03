// A read begun before a newer event must not replace that event's state.
export class StateClock {
  private clock = 0
  private threads = new Map<string, number>()
  private revisions = new Map<string, number>()
  capture(threadId?: string): number { return threadId ? this.threads.get(threadId) || 0 : this.clock }
  unchanged(stamp: number, threadId?: string): boolean { return stamp === this.capture(threadId) }
  event(threadId: string, revision?: number): boolean {
    if (Number.isSafeInteger(revision) && revision! < (this.revisions.get(threadId) || 0)) return false
    this.clock++; this.threads.set(threadId,this.clock)
    if (Number.isSafeInteger(revision)) this.revisions.set(threadId,revision!)
    return true
  }
  snapshot(threadId: string, revision?: number): boolean {
    if (!Number.isSafeInteger(revision)) return true
    if (revision! < (this.revisions.get(threadId) || 0)) return false
    this.revisions.set(threadId,revision!); return true
  }
  clear(): void { this.clock = 0; this.threads.clear(); this.revisions.clear() }
}
