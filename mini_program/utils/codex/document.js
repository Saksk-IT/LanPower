function utf8Length(text) {
  let bytes = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Links are data for native tap handlers; model text never becomes HTML or a URL request.
function linkTarget(value) {
  if (typeof value !== 'string') return null;
  let target = value.trim().replace(/^<([\s\S]*)>$/, '$1');
  if (!target || /[\u0000-\u001f\u007f]/.test(target)) return null;
  if (/^https?:\/\//i.test(target) || /^codex:/i.test(target)) return {target, external: true};
  if (/^file:/i.test(target)) {
    if (!/^file:\/\/(?:\/[A-Za-z]:[\/\\]|\/[^\/]|localhost\/)/i.test(target)) return null;
    target = target.replace(/^file:\/\/(?:localhost)?\//i, '/').replace(/^\/([A-Za-z]:[\/\\])/, '$1');
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[A-Za-z]:[\/\\]/.test(target)) return null;
  if (/%[\da-f]{2}/i.test(target)) { try { target = decodeURIComponent(target); } catch { return null; } }
  if (/[\u0000-\u001f\u007f]/.test(target) || target.replace(/^[A-Za-z]:/, '').includes(':') && !/:\d+(?::\d+)?$/.test(target)) return null;
  target = target.replace(/:\d+(?::\d+)?$/, '').replace(/#.*$/, '');
  if (!target || target.replace(/^[A-Za-z]:/, '').includes(':') || /^(?:\/\/|\\\\)/.test(target)) return null;
  return {target: target.replace(/\\/g, '/'), external: false};
}

function fileTarget(value, base = '') {
  const link = linkTarget(value);
  if (!link || link.external || !base || /^(?:[A-Za-z]:\/|\/)/.test(link.target)) return link;
  const directory = base.replace(/\\/g, '/').replace(/[^/]*$/, '');
  return {...link, target: directory + link.target};
}

function inlineParts(nodes) {
  return (nodes || []).flatMap(node => {
    if (node.type === 'text') return [{text: node.text, kind: 'text'}];
    if (node.link) return [{text: node.link.label, kind: 'link', target: node.link.target}];
    return inlineParts(node.children).map(part => ({...part, kind: part.kind === 'link' ? 'link' : node.name}));
  });
}

function markdownBlocks(nodes) {
  return nodes.map(node => {
    if (node.name === 'pre') return {kind: 'code', text: (node.children || []).map(child => child.text || '').join('')};
    if (['ul', 'ol'].includes(node.name)) return {kind: 'list', rows: node.children.map((row, index) => ({marker: node.name === 'ol' ? `${index + 1}.` : '•', parts: inlineParts(row.children)}))};
    if (node.name === 'table') return {kind: 'table', rows: node.children[0].children.map(row => ({cells: row.children.map(cell => ({heading: cell.name === 'th', parts: inlineParts(cell.children)}))}))};
    const style = node.attrs && node.attrs.style || '';
    return {kind: /border-top:/.test(style) ? 'rule' : /border-left:/.test(style) ? 'quote' : /font-weight:600/.test(style) ? 'heading' : 'paragraph', parts: inlineParts(node.children)};
  });
}

function markdownLinks(nodes) {
  const links = [], seen = new Set();
  const walk = values => { for (const node of values || []) { if (node.link && !seen.has(node.link.target)) { seen.add(node.link.target); links.push({label: node.link.label, target: node.link.target}); } walk(node.children); } };
  walk(nodes); return links;
}

function splitText(text, length = 4000) {
  const chunks = []; let start = 0;
  while (start < text.length) { let end = Math.min(text.length, start + length); if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--; chunks.push(text.slice(start, end)); start = end; }
  return chunks.length ? chunks : [''];
}

function splitParts(parts) {
  const rows = []; let current = [], size = 0;
  for (const part of parts) for (const text of splitText(part.text)) {
    const value = {...part, text}, bytes = utf8Length(JSON.stringify(value));
    if (current.length && size + bytes > 16000) { rows.push(current); current = []; size = 0; }
    current.push(value); size += bytes;
  }
  if (current.length || !rows.length) rows.push(current);
  return rows;
}

function documentPages(text, isMarkdown = true) {
  if (!isMarkdown) return splitText(text).map(content => ({content, blocks: []}));
  const {markdown} = require('../codex-format');
  const blocks = markdownBlocks(markdown(text)), pieces = [];
  for (const block of blocks) {
    if (utf8Length(JSON.stringify(block)) <= 16000) { pieces.push(block); continue; }
    if (block.kind === 'code') pieces.push(...splitText(block.text).map(text => ({...block, text})));
    else if (block.parts) pieces.push(...splitParts(block.parts).map(parts => ({...block, parts})));
    else if (block.kind === 'list') for (const row of block.rows) splitParts(row.parts).forEach((parts, index) => pieces.push({kind: 'list', rows: [{marker: index ? '' : row.marker, parts}]}));
    else if (block.kind === 'table') for (const row of block.rows) {
      const cells = row.cells.map(cell => splitParts(cell.parts)), count = Math.max(1, ...cells.map(parts => parts.length));
      for (let index = 0; index < count; index++) pieces.push({kind: 'table', rows: [{cells: row.cells.map((cell, cellIndex) => ({...cell, parts: cells[cellIndex][index] || []}))}]});
    }
    else pieces.push(block);
  }
  const pages = []; let current = [], size = 0;
  for (const block of pieces) {
    const bytes = utf8Length(JSON.stringify(block));
    if (current.length && size + bytes > 24000) { pages.push({blocks: current, content: ''}); current = []; size = 0; }
    current.push(block); size += bytes;
  }
  if (current.length || !pages.length) pages.push({blocks: current, content: ''});
  return pages;
}

module.exports = {linkTarget, fileTarget, markdownBlocks, markdownLinks, documentPages};
