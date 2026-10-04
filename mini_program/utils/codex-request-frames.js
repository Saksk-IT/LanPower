// WeChat sends original inputs in pieces; repeated image selections have no draft ceiling.
function* requestFrames(raw, id) {
  const size = 64 * 1024;
  if (raw.length <= size) { yield raw; return; }
  const parts = [];
  for (let start = 0; start < raw.length;) {
    let end = Math.min(raw.length, start + size);
    if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1]) && /[\uDC00-\uDFFF]/.test(raw[end])) end--;
    parts.push(raw.slice(start, end)); start = end;
  }
  for (let index = 0; index < parts.length; index++) yield JSON.stringify({type:'rpc_upload', id, index, count:parts.length, data:parts[index]});
}
module.exports = {requestFrames};
