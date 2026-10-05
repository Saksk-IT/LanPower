const {markdown, utf8Length, elapsed} = require('../codex-format');
const {timestamp} = require('./model');
const {diffSummary} = require('../codex-format');
const isRunning = status => ['inProgress', 'in_progress', 'running'].includes(status);
function activitySummary(members) {
  const counts = {command: 0, read: 0, list: 0, search: 0, file: 0, tool: 0};
  for (const member of members) counts[member.action || 'tool']++;
  const parts = [];
  if (counts.read) parts.push(`已读取 ${counts.read} 个文件`);
  if (counts.list) parts.push(`已列出 ${counts.list} 个目录`);
  if (counts.search) parts.push(`已执行 ${counts.search} 次搜索`);
  if (counts.file) parts.push(`已修改 ${counts.file} 组文件`);
  if (counts.command) parts.push(`已运行 ${counts.command} 条命令`);
  if (counts.tool) parts.push(`已调用 ${counts.tool} 个工具`);
  return parts.join('，');
}
function commandAction(item) {
  const actions = item.commandActions || [], action = actions.length === 1 ? actions[0] : null;
  const type = action && action.type, name = action && (action.name || action.path || action.query) || '';
  if (type === 'read') return {action: 'read', icon: 'book', label: `${isRunning(item.status) ? '正在读取' : '已读取'} ${name || '文件'}`};
  if (['listFiles', 'list_files'].includes(type)) return {action: 'list', icon: 'folder', label: `${isRunning(item.status) ? '正在列出' : '已列出'} ${name || '目录'}`};
  if (type === 'search') return {action: 'search', icon: 'search', label: `${isRunning(item.status) ? '正在搜索' : '已搜索'} ${name || '项目内容'}`};
  return {action: 'command', icon: 'terminal', label: isRunning(item.status) ? '正在运行命令' : '已运行命令'};
}
function changesSummary(thread) {
  const turn = (thread && thread.turns || []).slice().reverse().find(value => value.diff || (value.items || []).some(item => item.type === 'fileChange' && (item.changes || []).length));
  if (!turn) return {turnId: '', files: [], count: 0, added: 0, removed: 0};
  const files = new Map();
  for (const item of turn.items || []) if (item.type === 'fileChange') for (const file of item.changes || []) {
    if (!file.path) continue;
    const diff = file.diff || '', counts = diffSummary(diff), previous = files.get(file.path);
    files.set(file.path, {path: file.path, kind: typeof file.kind === 'string' ? file.kind : file.kind && file.kind.type || '', diff: (previous ? previous.diff + '\n' : '') + diff,
      added: (previous ? previous.added : 0) + counts.added, removed: (previous ? previous.removed : 0) + counts.removed});
  }
  // A turn diff is authoritative; avoid double-counting its file-change events.
  if (turn.diff) for (const file of diffSummary(turn.diff).files) {
    files.set(file.path, {...(files.get(file.path) || {}), ...file, diff: files.get(file.path) && files.get(file.path).diff || turn.diff});
  }
  const rows = Array.from(files.values());
  return {turnId: turn.id, files: rows, count: rows.length, added: rows.reduce((sum, row) => sum + row.added, 0), removed: rows.reduce((sum, row) => sum + row.removed, 0)};
}
function userContent(content) {
  const blocks = Array.isArray(content) ? content : [], raw = blocks.filter(b => ['text', 'input_text', 'Text'].includes(b.type)).map(b => b.text || '').join('\n');
  const normalized = raw.replace(/\r\n?/g, '\n');
  const match = /^# Files mentioned by the user:[ \t]*\n([\s\S]*?)\n## My request(?: for Codex)?:[ \t]*\n([\s\S]*)$/.exec(normalized);
  const attachments = match ? match[1].split(/^## /m).slice(1).map(part => {
    const lines = part.split('\n'), heading = /^(.+?):[ \t]*(.*)$/.exec(lines.shift());
    if (!heading) return null;
    const path = heading[2].trim() || (lines.find(line => line.trim()) || '').trim();
    return path ? {label: heading[1], path, image: /^Image attachment:[ \t]*true[ \t]*$/m.test(lines.join('\n'))} : null;
  }).filter(Boolean) : [];
  const images = [...blocks.filter(b => ['image', 'localImage', 'input_image', 'image_url'].includes(b.type)).map(b => b.url || b.path || (typeof b.image_url === 'string' ? b.image_url : b.image_url && b.image_url.url)),
    ...attachments.filter(file => file.image).map(file => file.path)].filter(source => typeof source === 'string' && source.trim());
  const sourceKey = source => {
    let path = source; if (/^file:/i.test(path)) { try { path = decodeURIComponent(path.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1')); } catch (_) {} }
    path = path.replace(/\\/g, '/'); return /^[A-Za-z]:/.test(path) ? path.toLowerCase() : path;
  };
  const unique = new Map(images.map(source => [sourceKey(source), source]));
  return {text: match ? match[2] : raw,
    files: attachments.filter(file => !file.image && !unique.has(sourceKey(file.path))).map(({label, path}) => ({label, path})),
    skills: blocks.filter(b => b.type === 'skill').map(b => ({name: b.name, path: b.path})), images: Array.from(unique.values())};
}
function itemRow(item, turn, index) {
  const row = {key: `${turn.id}:${item.id}`, turnId: turn.id, turnIndex: index, itemId: item.id, status: item.status || turn.status || '', text: '', kind: 'activity', label: '', images: [], files: [], skills: []};
  if (item.type === 'userMessage') return {...row, kind: 'user', ...userContent(item.content)};
  if (item.type === 'agentMessage') return {...row, kind: 'assistant', text: item.text || '', phase: item.phase || '', images: Array.from(String(item.text || '').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)).map(match => match[1])};
  if (item.type === 'reasoning') {
    const text = (item.summary || []).map(part => typeof part === 'string' ? part : part && part.text || '').filter(Boolean).join('\n\n');
    return {...row, kind: 'reasoning', icon: 'spark', label: isRunning(row.status) ? '正在思考' : '思考摘要', text};
  }
  if (item.type === 'plan') return {...row, kind: 'plan', label: '计划', text: item.text || ''};
  if (item.type === 'commandExecution') return {...row, ...commandAction({...item, status: row.status}), command: item.command || '', text: item.aggregatedOutput || '', exitCode: item.exitCode, cwd: item.cwd || ''};
  if (item.type === 'fileChange') return {...row, action: 'file', icon: 'file', label: `${isRunning(row.status) ? '正在修改' : '已修改'} ${(item.changes || []).length} 个文件`, files: (item.changes || []).map(c => ({path: c.path, label: c.path, kind: typeof c.kind === 'string' ? c.kind : c.kind && c.kind.type || '', diff: c.diff || ''})), text: (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n\n')};
  if (item.type === 'lanpowerLargeItem') return {...row, kind: 'large', reference: item.reference, characters: item.characters, label: item.wholeTurn ? '读取完整这一轮' : '读取完整内容', text: `${item.characters || 0} 字符，点击继续读取`};
  if (['imageGeneration', 'image_generation'].includes(item.type)) {
    const result = typeof item.result === 'string' ? item.result.trim() : '', source = !result ? '' : /^(data:|https?:|file:|[A-Za-z]:[\\/]|\/)/.test(result) ? result : `data:image/png;base64,${result.replace(/\s/g, '')}`;
    return source ? {...row, kind: 'imageActivity', imageAction: 'generate', label: '已生成 1 张图像', images: [source]} : null;
  }
  if (item.type === 'imageView') {
    const source = [item.path, item.url, item.imagePath, item.image_url].find(value => typeof value === 'string' && value.trim());
    return source ? {...row, kind: 'imageActivity', imageAction: 'view', label: '已查看 1 张图像', images: [source]} : null;
  }
  const labels = {mcpToolCall:'MCP 工具',dynamicToolCall:'动态工具',collabAgentToolCall:'协作任务',webSearch:'网页搜索',contextCompaction:'上下文整理',enteredReviewMode:'开始审查',exitedReviewMode:'审查结果'};
  if (item.type === 'contextCompaction') return {...row, kind: 'compaction', label: '已精简上下文', text: ''};
  if (item.type === 'webSearch') return {...row, action: 'search', icon: 'search', label: `${isRunning(row.status) ? '正在搜索' : '已搜索'} ${previewText(item.query || item.action && item.action.query || '网页', 100)}`, text: JSON.stringify(item.action || {query: item.query}, null, 2)};
  const status = item.error || item.success === false || ['failed','error'].includes(item.status) ? '失败' : ['inProgress','in_progress'].includes(row.status) ? '进行中' : '已完成';
  const title = [labels[item.type] || `新条目（${item.type}）`,item.server,item.tool || item.name,status].filter(Boolean).join(' · ');
  const safe = JSON.stringify(item,function(key,value) { return ['encryptedContent','encrypted_content','reasoningContent','reasoning_content'].includes(key) || this.type === 'reasoning' && key === 'content' ? undefined : value; },2);
  return {...row, action: 'tool', icon: 'tool', label:title,text:safe};
}
function projectConversation(thread, expandedTurns = new Set(), expandedActivities = new Set(), expandedImages = new Set()) {
  const rows = [];
  for (const [index, turn] of (thread && thread.turns || []).entries()) {
    const normalized = (turn.items || []).map(item => itemRow(item, turn, index)).filter(Boolean);
    const answers = normalized.filter(row => row.kind === 'assistant' && row.text.trim());
    const phaseAware = answers.some(row => row.phase), finals = answers.filter(row => row.phase === 'final_answer');
    const last = normalized[normalized.length - 1];
    if (!finals.length && !phaseAware && last && last.kind === 'assistant') finals.push(last);
    const finalIds = new Set([...finals, ...normalized.filter(row => row.imageAction === 'generate' && row.images.length)].map(row => row.key));
    const foldable = turn.status === 'completed' && finalIds.size && normalized.some(row => row.kind !== 'user' && row.kind !== 'large' && !finalIds.has(row.key));
    const start = timestamp(turn.startedAt), end = timestamp(turn.completedAt), duration = turn.durationMs !== undefined ? turn.durationMs : start && end ? end - start : undefined;
    const work = {key: `work:${turn.id}`, kind: 'work', turnId: turn.id, turnIndex: index, text: duration !== undefined ? `用时 ${elapsed(duration / 1000)}` : turn.status === 'inProgress' ? '正在工作' : turn.status === 'interrupted' ? '已停止' : '工作过程', summary: activitySummary(normalized.filter(row => row.kind === 'activity')), foldable: !!foldable, expanded: expandedTurns.has(turn.id), images: [], files: [], skills: []};
    let inserted = false;
    for (let position = 0; position < normalized.length;) {
      const row = normalized[position];
      if (!inserted && row.kind !== 'user') { rows.push(work); inserted = true; }
      if (foldable && !expandedTurns.has(turn.id) && row.kind !== 'user' && row.kind !== 'large' && !finalIds.has(row.key)) { position++; continue; }
      if (row.kind !== 'activity') { rows.push({...row, expanded: row.kind === 'imageActivity' ? expandedImages.has(row.key) : expandedActivities.has(row.key), imagesExpanded: row.kind === 'user' || expandedImages.has(row.key)}); position++; continue; }
      const members = [];
      while (position < normalized.length && normalized[position].kind === 'activity') members.push(normalized[position++]);
      const key = `activity:${row.key}`, failed = members.some(m => m.status === 'failed' || typeof m.exitCode === 'number' && m.exitCode !== 0);
      if (members.length === 1) { rows.push({...row, expanded: expandedActivities.has(row.key), failed}); continue; }
      rows.push({...row, key, itemId: '', command: '', files: [], kind: 'activityGroup', icon: members.some(member => member.action === 'search') ? 'search' : row.icon || 'terminal', label: members.some(member => isRunning(member.status)) ? '正在工作 · ' + activitySummary(members) : activitySummary(members), text: '', count: members.length, expanded: expandedActivities.has(key), failed});
      if (expandedActivities.has(key)) rows.push(...members.map(member => ({...member, expanded: expandedActivities.has(member.key), failed: member.status === 'failed' || typeof member.exitCode === 'number' && member.exitCode !== 0})));
    }
    if (!inserted) rows.push(work);
    if (turn.error) rows.push({key: `error:${turn.id}`, kind: 'error', turnId: turn.id, text: turn.error.message || '任务出错', images: [], files: [], skills: []});
  }
  return rows;
}
function previewText(text, limit = 2600) {
  let value = String(text || ''); if (value.length <= limit) return value;
  value = value.slice(0, limit); if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1); return value;
}
// Raw history is retained in the controller. Only the visible projection crosses setData.
function conversationWindow(rows, offset = null, imageView = () => '') {
  const latest = offset === null, from = latest ? Math.max(0, rows.length - 36) : Math.max(0, Math.min(offset, Math.max(0, rows.length - 1)));
  let selected = [], bytes = 0, start = from;
  const candidates = rows.slice(from, from + 36);
  for (const row of (latest ? candidates.slice().reverse() : candidates)) {
    const visibleText = !['activity', 'reasoning', 'plan'].includes(row.kind) || row.expanded;
    const text = visibleText ? previewText(row.text) : '', value = {...row, text, hasMoreText: visibleText && text.length < String(row.text || '').length,
      label: previewText(row.label, 180), summary: previewText(row.summary, 220),
      command: previewText(row.command, 800),
      domId: 'row-' + encodeURIComponent(row.key).replace(/%/g, '-'),
      images: (row.images || []).map((source, index) => ({key: row.key + ':img:' + index, src: imageView(row.key, index), label: '查看图片'})),
      files: (row.files || []).map(file => ({path: file.path, label: file.label || file.path, kind: file.kind || ''})),
      links: Array.from(String(row.text || '').replace(/!\[[^\]]*\]\([^)]+\)/g, '').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)).map(match => ({label: match[1], target: match[2]}))};
    if (row.kind === 'assistant') value.nodes = markdown(text.replace(/!\[[^\]]*\]\([^)]+\)/g, ''));
    const size = utf8Length(JSON.stringify(value)); if (bytes + size > 380000) break;
    bytes += size; selected.push(value);
  }
  if (latest) { selected.reverse(); start = rows.length - selected.length; }
  return {messages: selected, windowStart: start, windowEnd: start + selected.length, totalMessages: rows.length, hasWindowBefore: start > 0, hasWindowAfter: start + selected.length < rows.length};
}
module.exports = {userContent, itemRow, projectConversation, conversationWindow, previewText, changesSummary};
