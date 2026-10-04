import { RemoteError, type RemoteConnection } from './connection'

export function mergeHistory(previous: any[], latest: any[]): any[] {
  if (!previous.length) return latest
  if (!latest.length) return previous
  const boundary = previous.findIndex(t => t.id === latest[0]?.id)
  const ids = new Set(latest.map(t => t.id))
  const older = (boundary >= 0 ? previous.slice(0,boundary) : previous).filter(t => !ids.has(t.id))
  return [...older, ...latest]
}

export async function readPage(client: RemoteConnection, threadId: string, cursor?: string, signal?: AbortSignal): Promise<any> {
  for (let limit = 8; ; limit = Math.max(1,Math.floor(limit / 2))) {
    try { await client.paceHistory?.(signal); return await client.request('thread/turns/list',{threadId,...(cursor ? {cursor} : {}),limit},signal) }
    catch (error) { if (!(error instanceof RemoteError) || error.code !== 'result_too_large' || limit === 1) throw error }
  }
}
export async function readThread(client: RemoteConnection, threadId: string): Promise<any> {
  for (let historyLimit = 8; ; historyLimit = Math.max(1,Math.floor(historyLimit / 2))) {
    try { return await client.request('thread/read',{threadId,includeTurns:true,historyLimit}) }
    catch (error) { if (!(error instanceof RemoteError) || error.code !== 'result_too_large' || historyLimit === 1) throw error }
  }
}

type ContentRead = { offset: number; parts: string[]; characters?: number; complete: boolean; value?: any }

// One selected conversation only. Chunking is a transport detail, never a file download.
export class HistoryContentReader {
  private reads = new Map<string,ContentRead>()
  constructor(private threadId: string) {}

  async read(client: RemoteConnection, item: any, signal?: AbortSignal, progress: (count:number)=>void = () => {}): Promise<void> {
    let job = this.reads.get(item.reference)
    if (!job) { job = {offset:0,parts:[],complete:false}; this.reads.set(item.reference,job) }
    while (!job.complete) {
      await client.paceHistory?.(signal)
      signal?.throwIfAborted()
      const part = await client.request('lanpower/history/item/read',{threadId:this.threadId,reference:item.reference,offset:job.offset},signal)
      signal?.throwIfAborted()
      if (part.offset !== job.offset || typeof part.data !== 'string' || !part.data.length || part.data.length > 65536 ||
        !Number.isSafeInteger(part.characters) || part.characters !== item.characters || part.characters < job.offset + part.data.length ||
        job.characters !== undefined && job.characters !== part.characters || part.nextOffset !== null && part.nextOffset !== job.offset + part.data.length ||
        part.nextOffset === null && job.offset + part.data.length !== part.characters) throw new Error('内容分段不连续，正在重新读取。')
      job.characters = part.characters
      job.parts.push(part.data); job.offset += part.data.length; job.complete = part.nextOffset === null
      progress(job.offset)
    }
    if (!job.value) {
      const value = JSON.parse(job.parts.join(''))
      if (!value || value.id !== item.id || (item.wholeTurn ? !Array.isArray(value.items) : value.type !== item.originalType)) {
        this.reads.delete(item.reference); throw new Error('会话内容不匹配，正在重新读取。')
      }
      job.value = value; job.parts = []
    }
  }

  apply(turns: any[]): any[] {
    let changed = false
    const result = turns.map(turn => {
      const whole = (turn.items || []).find((item:any) => item.type === 'lanpowerLargeItem' && item.wholeTurn)
      const restored = whole && this.reads.get(whole.reference)?.value
      if (restored) { changed = true; return {...restored,...turn,items:restored.items,lanpowerContentReference:whole.reference} }
      const items = (turn.items || []).map((item:any) => {
        const value = item.type === 'lanpowerLargeItem' && !item.wholeTurn && this.reads.get(item.reference)?.value
        if (!value) return item
        changed = true; return {...value,lanpowerContentReference:item.reference}
      })
      return items.some((item:any,index:number) => item !== turn.items[index]) ? {...turn,items} : turn
    })
    return changed ? result : turns
  }

  prune(turns: any[]): void {
    const references = new Set<string>()
    for (const turn of turns) {
      if (turn.lanpowerContentReference) references.add(turn.lanpowerContentReference)
      for (const item of turn.items || []) {
        if (item.type === 'lanpowerLargeItem') references.add(item.reference)
        if (item.lanpowerContentReference) references.add(item.lanpowerContentReference)
      }
    }
    for (const reference of this.reads.keys()) if (!references.has(reference)) this.reads.delete(reference)
  }
  forget(reference: string): void { this.reads.delete(reference) }
}

export async function refreshHistoryTurn(client: RemoteConnection, threadId: string, turnId: string, signal?: AbortSignal): Promise<any> {
  const seen = new Set<string>(); let cursor: string | undefined
  while (true) {
    const page = await readPage(client,threadId,cursor,signal)
    const turn = (page.data || []).find((value:any) => value.id === turnId)
    if (turn) return turn
    const next = page.nextCursor
    if (!next) throw new Error('这轮内容已变化，正在刷新会话。')
    if (seen.has(next)) throw new Error('历史游标未推进，正在重新读取。')
    seen.add(next); cursor = next
  }
}

export type BeginningJob = { cursor?: string; pages: Array<string | undefined>; lastPage: any; count: number; complete: boolean }
export const newBeginning = (): BeginningJob => ({pages:[],lastPage:null,count:0,complete:false})
export async function findBeginning(client: RemoteConnection, id: string, job: BeginningJob, signal?: AbortSignal, progress: (count:number)=>void = () => {}): Promise<any> {
  while (!job.complete) {
    const page = await readPage(client,id,job.cursor,signal), next = page.nextCursor || ''
    if (next && (next === job.cursor || job.pages.includes(next))) throw new Error('历史游标未推进，请重试读取。')
    job.pages.push(job.cursor); job.lastPage = page; job.count += (page.data || []).length; job.cursor = next; job.complete = !next; progress(job.count)
  }
  return job.lastPage
}
