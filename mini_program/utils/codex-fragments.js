// Responses are assembled only on the authorized client; the Cloud streams bounded frames.
function utf8Bytes(text) { let size = 0; for (const char of text) { const code = char.codePointAt(0); size += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; } return size; }
class RpcFragments {
  constructor() { this.parts = new Map(); this.bytes = 0; }
  accept(frame) {
    const {id, index, count, data} = frame;
    const rpcId = frame.rpcId === undefined ? id : frame.rpcId;
    if (typeof rpcId !== 'string' && !(typeof rpcId === 'number' && Number.isSafeInteger(rpcId))) throw new Error('invalid_chunk');
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count || typeof data !== 'string' || !data.length || data.length > 65536) throw new Error('invalid_chunk');
    let part = this.parts.get(id);
    if (!part) { if (index !== 0) throw new Error('invalid_chunk'); part = {count, bytes:0, values:[], rpcId}; this.parts.set(id, part); }
    const bytes = utf8Bytes(data);
    if (index !== part.values.length || count !== part.count || rpcId !== part.rpcId) throw new Error('invalid_chunk');
    part.values.push(data); part.bytes += bytes; this.bytes += bytes;
    if (index + 1 !== count) return null;
    const payload = JSON.parse(part.values.join('')); this.drop(id);
    if (!payload || payload.id !== rpcId || typeof payload.method === 'string') throw new Error('invalid_chunk');
    return {...payload, id};
  }
  drop(id) { const part = this.parts.get(id); if (part) this.bytes -= part.bytes; this.parts.delete(id); }
  clear() { this.parts.clear(); this.bytes = 0; }
}
module.exports = {RpcFragments};
