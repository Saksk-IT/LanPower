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
  const nodes = [], pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+)\*|~~([^~]+)~~/g;
  let offset = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > offset) nodes.push(textNode(text.slice(offset, match.index)));
    if (match[1]) nodes.push({name: 'strong', children: [textNode(match[1])]});
    else if (match[2]) nodes.push({name: 'code', attrs: {style: 'background:rgba(128,128,128,.12);padding:2px 4px;border-radius:4px;'}, children: [textNode(match[2])]});
    else if (match[3]) nodes.push(textNode(match[3] + ' (' + match[4] + ')'));
    else if (match[5]) nodes.push({name: 'em', children: [textNode(match[5])]});
    else nodes.push({name: 'del', children: [textNode(match[6])]});
    offset = pattern.lastIndex;
  }
  if (offset < text.length) nodes.push(textNode(text.slice(offset)));
  return nodes;
}
// Text nodes only: model output cannot insert HTML, images, scripts or active links.
function markdown(text) {
  const nodes = [], lines = String(text || '').split('\n');
  let code = null, list = null;
  const endList = () => { if (list) { nodes.push(list); list = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      if (code !== null) { nodes.push({name: 'pre', attrs: {style: 'white-space:pre-wrap;word-break:break-all;background:rgba(128,128,128,.1);padding:12px;border-radius:12px;font-family:monospace;font-size:13px;'}, children: [textNode(code.join('\n'))]}); code = null; }
      else { endList(); code = []; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')) {
      endList(); const split = value => value.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const cell = (value, heading) => ({name: heading ? 'th' : 'td', attrs: {style: 'border:1px solid rgba(128,128,128,.25);padding:6px;text-align:left;word-break:break-word;'}, children: inline(value)});
      const rows = [{name: 'tr', children: split(line).map(value => cell(value, true))}]; index++;
      while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) rows.push({name: 'tr', children: split(lines[++index]).map(value => cell(value, false))});
      nodes.push({name: 'table', attrs: {style: 'width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px;margin:10px 0;'}, children: [{name: 'tbody', children: rows}]}); continue;
    }
    const bullet = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const kind = bullet[2] ? 'ol' : 'ul'; if (list && list.name !== kind) endList();
      if (!list) list = {name: kind, attrs: {style: 'padding-left:22px;margin:8px 0;'}, children: []};
      const content = bullet[3].replace(/^\[([ xX])\]\s*/, (_, checked) => checked.trim() ? '✓ ' : '○ ');
      list.children.push({name: 'li', attrs: {style: 'margin:4px 0;'}, children: inline(content)}); continue;
    }
    endList();
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { nodes.push({name: 'div', attrs: {style: 'border-top:1px solid rgba(128,128,128,.25);margin:12px 0;'}, children: []}); continue; }
    if (/^\s*>\s?/.test(line)) { nodes.push({name: 'div', attrs: {style: 'border-left:3px solid rgba(128,128,128,.25);padding-left:10px;margin:6px 0;'}, children: inline(line.replace(/^\s*>\s?/, ''))}); continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    nodes.push({name: 'div', attrs: {style: heading ? 'font-weight:600;margin:12px 0 6px;' : 'min-height:8px;margin:4px 0;'}, children: inline(heading ? heading[2] : line)});
  }
  endList(); if (code !== null) nodes.push({name: 'pre', attrs: {style: 'white-space:pre-wrap;word-break:break-all;font-family:monospace;'}, children: [textNode(code.join('\n'))]});
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
