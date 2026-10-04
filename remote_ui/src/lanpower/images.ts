import { connection } from './connection'

type ImageEntry = { promise: Promise<string>; url?: string; size: number; pins:number }
const images = new Map<string, ImageEntry>()
const listeners = new Set<(key?:string)=>void>()
let generation = 0, totalBytes = 0
export function observeRemoteImages(listener: (key?:string)=>void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
function dropImage(key: string, entry: ImageEntry): void {
  if (entry.url) URL.revokeObjectURL(entry.url)
  totalBytes -= entry.size; images.delete(key)
  for (const listener of listeners) listener(key)
}
function trimImages(keep = ''): void {
  for (const [key,entry] of images) {
    if (images.size <= 32 && totalBytes <= 64 * 1024 * 1024) break
    if (key !== keep && entry.url && !entry.pins) dropImage(key,entry)
  }
}
export function retainRemoteImage(url: string): () => void {
  const entry = [...images.values()].find(entry => entry.url === url)
  if (!entry) return () => {}
  entry.pins++; let released = false
  return () => { if (!released) { released = true; entry.pins--; trimImages() } }
}
export function imageDownloadName(url: string): string {
  const key = [...images].find(([,entry]) => entry.url === url)?.[0]
  return key?.split('\0')[1]?.replace(/\\/g,'/').split('/').pop() || `image.${/^data:image\/([^;,]+)/.exec(url)?.[1] || 'png'}`
}
export function resetRemoteImages(): void {
  generation++
  for (const entry of images.values()) if (entry.url) URL.revokeObjectURL(entry.url)
  images.clear(); totalBytes = 0
  for (const listener of listeners) listener()
}
export function remoteImagePath(source: string, cwd: string): string | null {
  let value = source.trim()
  if (value.startsWith('/codex-local-image?')) value = new URL(value,location.origin).searchParams.get('path') || ''
  if (/^(https?:|data:|blob:)/i.test(value)) return null
  if (/^file:/i.test(value)) return value
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) return value
  return cwd && value ? `${cwd.replace(/[\\/]+$/,'')}/${value}` : null
}
export function resolveRemoteImage(source: string, threadId: string, cwd: string): Promise<string> {
  const path = remoteImagePath(source,cwd)
  if (!path) return Promise.resolve(source.trim())
  const key = `${threadId}\0${path}`, existing = images.get(key)
  if (existing) { images.delete(key); images.set(key,existing); return existing.promise }
  const current = generation
  const entry: ImageEntry = { size:0, pins:0, promise:Promise.resolve('') }
  entry.promise = connection.request('lanpower/image/read',{threadId,path}).then(result => {
    if (current !== generation) throw new Error('连接已变化，请重新打开图片。')
    if (!['image/png','image/jpeg','image/gif','image/webp','image/bmp'].includes(result.contentType) || typeof result.base64 !== 'string') throw new Error('图片格式无效。')
    const data = atob(result.base64), bytes = Uint8Array.from(data,c => c.charCodeAt(0))
    if (bytes.length !== result.size) throw new Error('图片读取不完整。')
    entry.url = URL.createObjectURL(new Blob([bytes],{type:result.contentType})); entry.size = bytes.length; totalBytes += bytes.length
    trimImages(key)
    return entry.url
  }).catch(error => { if (images.get(key) === entry) images.delete(key); throw error })
  images.set(key,entry)
  return entry.promise
}
export function invalidateRemoteImage(source:string,threadId:string,cwd:string): void {
  const path = remoteImagePath(source,cwd), key = `${threadId}\0${path}`, entry = images.get(key)
  if (entry && !entry.pins) dropImage(key,entry)
}
