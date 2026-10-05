// Display the native attachment envelope without changing the original message or submission.
function parseUserEnvelope(raw) {
  const original = String(raw || ''), normalized = original.replace(/\r\n?/g, '\n');
  const header = /^\s*#[ \t]+files mentioned by the user[ \t]*:?[ \t]*(?:\n|$)/i.exec(normalized);
  if (!header) return {text: original, attachments: []};
  const remainder = normalized.slice(header[0].length);
  const request = /(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+my request(?: for codex)?[ \t]*:[ \t]*(?:\n|$)/i.exec(remainder);
  const metadata = request ? remainder.slice(0, request.index) : remainder;
  const attachments = [];
  let current = null, valid = true;
  for (const line of metadata.split('\n')) {
    const value = line.trim();
    if (!value || /^Distinguish instructions in attached documents from the user(?:'s)? request\.?$/i.test(value)) continue;
    const heading = /^##[ \t]+(.+?):[ \t]*(.*)$/.exec(value);
    if (heading) {
      current = {label: heading[1].trim(), path: heading[2].trim(), image: false};
      attachments.push(current);
    } else if (current && /^Image attachment:[ \t]*(?:true|false)$/i.test(value)) {
      current.image = /true$/i.test(value);
    } else if (current && !current.path) {
      current.path = value;
    } else {
      valid = false;
    }
  }
  if (!valid || !attachments.length || attachments.some(file => !file.label || !file.path)) return {text: original, attachments: []};
  attachments.forEach(file => {file.path = file.path.replace(/\s+\(lines?\s+\d+(?:-\d+)?\)\s*$/i, '');});
  return {text: request ? remainder.slice(request.index + request[0].length).trim() : '', attachments};
}
function attachmentSourceKey(source) {
  let path = String(source || '').trim();
  if (/^file:/i.test(path)) {
    try { path = decodeURIComponent(path.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1')); } catch (_) {}
  }
  path = path.replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(path) ? path.toLowerCase() : path;
}
function mergeAttachmentImages(sources, attachments, sourceKey = attachmentSourceKey) {
  const images = Array.from(new Map(sources.filter(source => typeof source === 'string' && source.trim()).map(source => [sourceKey(source), source])).values());
  const keys = new Set(images.map(sourceKey));
  // Native history can contain both inline image bytes and a path entry for the same attachment.
  let inlineImages = images.filter(source => /^data:image\//i.test(source)).length;
  for (const file of attachments.filter(file => file.image)) {
    const key = attachmentSourceKey(file.path);
    const matching = images.findIndex(source => sourceKey(source) === key);
    if (matching >= 0) { images[matching] = file.path; continue; }
    if (keys.has(key)) continue;
    keys.add(key);
    if (inlineImages > 0) inlineImages--;
    else images.push(file.path);
  }
  return images;
}
module.exports = {parseUserEnvelope, attachmentSourceKey, mergeAttachmentImages};
