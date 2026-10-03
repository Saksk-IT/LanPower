import { connection } from './connection'

type ImageEntry = { promise: Promise<string>; url?: string; size: number }
const images = new Map<string, ImageEntry>()
let generation = 0, totalBytes = 0
export function resetRemoteImages(): void {
  generation++
  for (const entry of images.values()) if (entry.url) URL.revokeObjectURL(entry.url)
  images.clear(); totalBytes = 0
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
  if (existing) return existing.promise
  const current = generation
  const entry: ImageEntry = { size:0, promise:Promise.resolve('') }
  entry.promise = connection.request('lanpower/image/read',{threadId,path}).then(result => {
    if (current !== generation) throw new Error('连接已变化，请重新打开图片。')
    if (!['image/png','image/jpeg','image/gif','image/webp','image/bmp'].includes(result.contentType) || typeof result.base64 !== 'string' || result.size > 8 * 1024 * 1024) throw new Error('图片格式无效。')
    const data = atob(result.base64), bytes = Uint8Array.from(data,c => c.charCodeAt(0))
    if (bytes.length !== result.size) throw new Error('图片读取不完整。')
    entry.url = URL.createObjectURL(new Blob([bytes],{type:result.contentType})); entry.size = bytes.length; totalBytes += bytes.length
    // Revoke evicted object URLs; conversation rendering requests them again when needed.
    for (const [oldKey,old] of images) {
      if (images.size <= 32 && totalBytes <= 64 * 1024 * 1024) break
      if (oldKey === key || !old.url) continue
      URL.revokeObjectURL(old.url); totalBytes -= old.size; images.delete(oldKey)
    }
    return entry.url
  }).catch(error => { if (images.get(key) === entry) images.delete(key); throw error })
  images.set(key,entry)
  return entry.promise
}
