function projectName(path) { const parts = String(path || '').split(/[\\/]/).filter(Boolean); return parts[parts.length - 1] || '本机项目'; }
function elapsed(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  return seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
}
function relativeTime(value) {
  const seconds = Math.max(0, Date.now() / 1000 - Number(value || 0));
  return seconds < 60 ? '刚刚' : seconds < 3600 ? Math.floor(seconds / 60) + ' 分钟前' : seconds < 86400 ? Math.floor(seconds / 3600) + ' 小时前' : new Date(value * 1000).toLocaleDateString();
}
function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
function textNode(text) { return {type: 'text', text}; }
function inline(text) {
  const nodes = [], pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let offset = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > offset) nodes.push(textNode(text.slice(offset, match.index)));
    if (match[1]) nodes.push({name: 'strong', children: [textNode(match[1])]});
    else if (match[2]) nodes.push({name: 'code', attrs: {style: 'background:rgba(128,128,128,.12);padding:2px 4px;border-radius:4px;'}, children: [textNode(match[2])]});
    else nodes.push(textNode(match[3] + ' (' + match[4] + ')'));
    offset = pattern.lastIndex;
  }
  if (offset < text.length) nodes.push(textNode(text.slice(offset)));
  return nodes;
}
// Text nodes only: model output cannot insert HTML, images, scripts or active links.
function markdown(text) {
  const nodes = [], lines = String(text || '').slice(-12000).split('\n').slice(0, 200);
  let code = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code !== null) { nodes.push({name: 'pre', attrs: {style: 'white-space:pre-wrap;word-break:break-all;background:rgba(128,128,128,.1);padding:12px;border-radius:12px;font-family:monospace;font-size:13px;'}, children: [textNode(code.join('\n'))]}); code = null; }
      else code = [];
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    nodes.push({name: 'div', attrs: {style: heading ? 'font-weight:600;margin:12px 0 6px;' : 'min-height:8px;margin:4px 0;'}, children: inline(heading ? heading[2] : line)});
  }
  if (code !== null) nodes.push({name: 'pre', attrs: {style: 'white-space:pre-wrap;word-break:break-all;font-family:monospace;'}, children: [textNode(code.join('\n'))]});
  return nodes;
}
function diffSummary(diff, changes = []) {
  let added = 0, removed = 0;
  const files = new Map();
  for (const file of changes.slice(0, 32)) {
    if (file.path) files.set(file.path, {path: file.path, added: 0, removed: 0});
  }
  let current = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '');
      if (path !== '/dev/null') { current = files.get(path) || {path, added: 0, removed: 0}; if (files.size < 32 || files.has(path)) files.set(path, current); }
    } else if (line.startsWith('--- ')) {
      const path = line.slice(4).replace(/^a\//, '');
      if (path !== '/dev/null') { current = files.get(path) || {path, added: 0, removed: 0}; if (files.size < 32 || files.has(path)) files.set(path, current); }
    } else if (line.startsWith('+')) { added++; if (current) current.added++; }
    else if (line.startsWith('-')) { removed++; if (current) current.removed++; }
  }
  return {files: Array.from(files.values()), added, removed};
}
module.exports = {projectName, elapsed, relativeTime, markdown, diffSummary, utf8Length};
