// Piece size controls transport buffering, never the size of a Codex input.
export function* requestFrames(raw: string, id: string | number): Generator<string> {
  const piece = 64 * 1024
  if (raw.length <= piece) { yield raw; return }
  const parts: string[] = []
  for (let start = 0; start < raw.length;) {
    let end = Math.min(raw.length, start + piece)
    if (end < raw.length && /[\uD800-\uDBFF]/u.test(raw[end - 1]!) && /[\uDC00-\uDFFF]/u.test(raw[end]!)) end--
    parts.push(raw.slice(start, end)); start = end
  }
  for (let index = 0; index < parts.length; index++) yield JSON.stringify({type:'rpc_upload', id, index, count:parts.length, data:parts[index]})
}
