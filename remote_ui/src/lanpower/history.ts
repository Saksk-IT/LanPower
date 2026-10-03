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

export type LargeDownload = { offset: number; parts: Blob[]; complete: boolean; characters?: number }
export const newDownload = (): LargeDownload => ({offset:0,parts:[],complete:false})
export async function downloadItem(client: RemoteConnection, threadId: string, reference: string, job: LargeDownload, signal?: AbortSignal, progress: (count:number)=>void = () => {}): Promise<Blob> {
  while (!job.complete) {
    await client.paceHistory?.(signal)
    const part = await client.request('lanpower/history/item/read',{threadId,reference,offset:job.offset},signal)
    if (part.offset !== job.offset || typeof part.data !== 'string' || !part.data.length || !Number.isSafeInteger(part.characters) || part.characters < job.offset + part.data.length ||
      job.characters !== undefined && job.characters !== part.characters || part.nextOffset !== null && part.nextOffset !== job.offset + part.data.length ||
      part.nextOffset === null && job.offset + part.data.length !== part.characters) throw new Error('内容分块不连续，请重新读取这轮历史。')
    job.characters = part.characters
    job.parts.push(new Blob([part.data])); job.offset += part.data.length; job.complete = part.nextOffset === null
    progress(job.offset)
  }
  return new Blob(job.parts,{type:'application/json;charset=utf-8'})
}

export type ExportJob = { cursor?: string | null; page?: any; metadata: any; turns: Blob[]; ids: Set<string>; downloads: Map<string,LargeDownload>; complete: boolean }
export function newExport(metadata: any): ExportJob {
  const {turns,historyCursor,...rest} = metadata
  return {metadata:rest,turns:[],ids:new Set(),downloads:new Map(),complete:false}
}
async function turnBlob(client: RemoteConnection, id: string, turn: any, job: ExportJob, signal?: AbortSignal): Promise<Blob> {
  const itemBlob = async (item:any): Promise<Blob> => {
    if (item.type !== 'lanpowerLargeItem') return new Blob([JSON.stringify(item)])
    let download = job.downloads.get(item.reference)
    if (!download) { download = newDownload(); job.downloads.set(item.reference,download) }
    return downloadItem(client,id,item.reference,download,signal)
  }
  const whole = (turn.items || []).find((i:any) => i.type === 'lanpowerLargeItem' && i.wholeTurn)
  if (whole) return itemBlob(whole)
  const {items,...metadata} = turn, parts: BlobPart[] = [JSON.stringify(metadata).slice(0,-1),',"items":[']
  for (const [index,item] of (items || []).entries()) { if (index) parts.push(','); parts.push(await itemBlob(item)) }
  parts.push(']}'); return new Blob(parts)
}
export async function exportHistory(client: RemoteConnection, id: string, job: ExportJob, signal?: AbortSignal, progress: (count:number)=>void = () => {}): Promise<Blob> {
  while (!job.complete) {
    const page = job.page ||= await readPage(client,id,job.cursor || undefined,signal), next = page.nextCursor || null
    if (next && next === job.cursor) throw new Error('历史游标未推进，请重试读取。')
    // Commit one turn only after every large item has finished; a retry cannot leave a hole.
    for (const turn of page.data || []) {
      if (job.ids.has(turn.id)) continue
      const blob = await turnBlob(client,id,turn,job,signal)
      job.turns.push(blob); job.ids.add(turn.id); job.downloads.clear(); progress(job.turns.length)
    }
    job.cursor = next; job.complete = !next; job.page = undefined
  }
  const parts: BlobPart[] = [JSON.stringify(job.metadata).slice(0,-1),',"turns":[']
  for (let index = job.turns.length-1; index >= 0; index--) { if (index !== job.turns.length-1) parts.push(','); parts.push(job.turns[index]!) }
  parts.push(']}')
  return new Blob(parts,{type:'application/json;charset=utf-8'})
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
