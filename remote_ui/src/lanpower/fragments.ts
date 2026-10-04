type Parts = { count: number; bytes: number; values: string[]; rpcId: string | number }

export class RpcFragments {
  private parts = new Map<string | number, Parts>()
  private bytes = 0
  accept(frame: any): any | null {
    const { id, index, count, data } = frame
    const rpcId = frame.rpcId === undefined ? id : frame.rpcId
    if (typeof rpcId !== 'string' && !(typeof rpcId === 'number' && Number.isSafeInteger(rpcId))) throw new Error('invalid_chunk')
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 512 || index < 0 || index >= count || typeof data !== 'string' || !data.length || data.length > 65536) throw new Error('invalid_chunk')
    let parts = this.parts.get(id)
    if (!parts) {
      if (index !== 0 || this.parts.size >= 4) throw new Error('invalid_chunk')
      parts = { count, bytes: 0, values: [], rpcId }; this.parts.set(id, parts)
    }
    const bytes = new TextEncoder().encode(data).byteLength
    if (index !== parts.values.length || count !== parts.count || rpcId !== parts.rpcId || parts.bytes + bytes > 16 * 1048576 || this.bytes + bytes > 32 * 1048576) throw new Error('invalid_chunk')
    parts.values.push(data); parts.bytes += bytes; this.bytes += bytes
    if (index + 1 !== count) return null
    const payload = JSON.parse(parts.values.join(''))
    this.drop(id)
    if (!payload || payload.id !== rpcId || typeof payload.method === 'string') throw new Error('invalid_chunk')
    return { ...payload, id }
  }
  drop(id: string | number): void { const part = this.parts.get(id); if (part) this.bytes -= part.bytes; this.parts.delete(id) }
  clear(): void { this.parts.clear(); this.bytes = 0 }
}
