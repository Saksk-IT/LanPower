const {markdown, utf8Length, elapsed} = require('../codex-format');
const {timestamp} = require('./model');
function userContent(content) {
  const blocks = Array.isArray(content) ? content : [], raw = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  const match = /^# Files mentioned by the user:\n([\s\S]*?)\n\n## My request for Codex:\n([\s\S]*)$/.exec(raw);
  return {text: match ? match[2] : raw,
    files: match ? match[1].split('\n').map(line => /^## (.*?): (.*)$/.exec(line)).filter(Boolean).map(m => ({label: m[1], path: m[2]})) : [],
    skills: blocks.filter(b => b.type === 'skill').map(b => ({name: b.name, path: b.path})),
    images: blocks.filter(b => ['image', 'localImage'].includes(b.type)).map(b => b.url || b.path)};
}
function itemRow(item, turn, index) {
  const row = {key: `${turn.id}:${item.id}`, turnId: turn.id, turnIndex: index, itemId: item.id, status: item.status || turn.status || '', text: '', kind: 'activity', label: '', images: [], files: [], skills: []};
  if (item.type === 'userMessage') return {...row, kind: 'user', ...userContent(item.content)};
  if (item.type === 'agentMessage') return {...row, kind: 'assistant', text: item.text || '', phase: item.phase || '', images: Array.from(String(item.text || '').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)).map(match => match[1])};
  if (item.type === 'reasoning') return {...row, kind: 'reasoning', label: '思考摘要', text: (item.summary || []).filter(part => typeof part === 'string').join('\n\n')};
  if (item.type === 'plan') return {...row, kind: 'plan', label: '计划', text: item.text || ''};
  if (item.type === 'commandExecution') return {...row, label: '运行命令', command: item.command || '', text: item.aggregatedOutput || '', exitCode: item.exitCode, cwd: item.cwd || ''};
  if (item.type === 'fileChange') return {...row, label: '修改文件', files: (item.changes || []).map(c => ({path: c.path, label: c.path, kind: typeof c.kind === 'string' ? c.kind : c.kind && c.kind.type || '', diff: c.diff || ''})), text: (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n\n')};
  if (item.type === 'lanpowerLargeItem') return {...row, kind: 'large', reference: item.reference, characters: item.characters, label: item.wholeTurn ? '读取完整这一轮' : '读取完整内容', text: `${item.characters || 0} 字符，点击继续读取`};
  if (['imageGeneration', 'image_generation'].includes(item.type)) {
    const result = item.result || '', source = /^(data:|https?:|file:|[A-Za-z]:[\\/]|\/)/.test(result) ? result : `data:image/png;base64,${result.replace(/\s/g, '')}`;
    return {...row, kind: 'assistant', label: '生成的图片', images: source ? [source] : []};
  }
  if (item.type === 'imageView') return null;
  const labels = {mcpToolCall:'MCP 工具',dynamicToolCall:'动态工具',collabAgentToolCall:'协作任务',webSearch:'网页搜索',contextCompaction:'上下文整理',enteredReviewMode:'开始审查',exitedReviewMode:'审查结果'};
  if (item.type === 'contextCompaction') return {...row,label:'上下文整理',text:'会话上下文已整理；仅显示公开提示。'};
  const status = item.error || item.success === false || ['failed','error'].includes(item.status) ? '失败' : ['inProgress','in_progress'].includes(row.status) ? '进行中' : '已完成';
  const title = [labels[item.type] || `新条目（${item.type}）`,item.server,item.tool || item.name,status].filter(Boolean).join(' · ');
  const safe = JSON.stringify(item,function(key,value) { return ['encryptedContent','encrypted_content','reasoningContent','reasoning_content'].includes(key) || this.type === 'reasoning' && key === 'content' ? undefined : value; },2);
  return {...row,label:title,text:safe};
}
function projectConversation(thread, expandedTurns = new Set(), expandedActivities = new Set()) {
  const rows = [];
  for (const [index, turn] of (thread && thread.turns || []).entries()) {
    const normalized = (turn.items || []).map(item => itemRow(item, turn, index)).filter(Boolean);
    const answers = normalized.filter(row => row.kind === 'assistant' && row.text.trim());
    const phaseAware = answers.some(row => row.phase), finals = answers.filter(row => row.phase === 'final_answer');
    const last = normalized[normalized.length - 1];
    if (!finals.length && !phaseAware && last && last.kind === 'assistant') finals.push(last);
    const finalIds = new Set([...finals, ...normalized.filter(row => row.kind === 'assistant' && row.images.length)].map(row => row.key));
    const foldable = turn.status === 'completed' && finalIds.size && normalized.some(row => row.kind !== 'user' && row.kind !== 'large' && !finalIds.has(row.key));
    const start = timestamp(turn.startedAt), end = timestamp(turn.completedAt), duration = turn.durationMs !== undefined ? turn.durationMs : start && end ? end - start : undefined;
    const work = {key: `work:${turn.id}`, kind: 'work', turnId: turn.id, turnIndex: index, text: duration !== undefined ? `用时 ${elapsed(duration / 1000)}` : turn.status === 'inProgress' ? '正在工作' : turn.status === 'interrupted' ? '已停止' : '工作过程', foldable: !!foldable, expanded: expandedTurns.has(turn.id), images: [], files: [], skills: []};
    let inserted = false;
    for (let position = 0; position < normalized.length;) {
      const row = normalized[position];
      if (!inserted && row.kind !== 'user') { rows.push(work); inserted = true; }
      if (foldable && !expandedTurns.has(turn.id) && row.kind !== 'user' && row.kind !== 'large' && !finalIds.has(row.key)) { position++; continue; }
      if (row.kind !== 'activity') { rows.push(row); position++; continue; }
      const members = [];
      while (position < normalized.length && normalized[position].kind === 'activity') members.push(normalized[position++]);
      const key = `activity:${row.key}`, files = members.some(member => member.files.length), commands = members.some(member => member.command);
      rows.push({...row, key, itemId: '', command: '', files: [], kind: 'activityGroup', label: files ? commands ? '编辑了文件，运行了命令' : '编辑了文件' : commands ? '运行了命令' : '调用了工具', text: '', count: members.length, expanded: expandedActivities.has(key), failed: members.some(m => m.status === 'failed' || typeof m.exitCode === 'number' && m.exitCode !== 0)});
      if (expandedActivities.has(key)) rows.push(...members);
    }
    if (!inserted && turn.status !== 'inProgress') rows.push(work);
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
    const text = previewText(row.text), value = {...row, text, hasMoreText: text.length < String(row.text || '').length,
      command: previewText(row.command, 800),
      domId: 'row-' + encodeURIComponent(row.key).replace(/%/g, '-'),
      images: (row.images || []).map((source, index) => ({key: row.key + ':img:' + index, src: imageView(row.key, index), label: '查看图片'})),
      files: (row.files || []).slice(0, 16).map(file => ({path: file.path, label: file.label || file.path, kind: file.kind || ''})),
      links: Array.from(String(row.text || '').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)).slice(0, 12).map(match => ({label: match[1], target: match[2]}))};
    if (row.kind === 'assistant') value.nodes = markdown(text.replace(/!\[[^\]]*\]\([^)]+\)/g, ''));
    const size = utf8Length(JSON.stringify(value)); if (bytes + size > 380000) break;
    bytes += size; selected.push(value);
  }
  if (latest) { selected.reverse(); start = rows.length - selected.length; }
  return {messages: selected, windowStart: start, windowEnd: start + selected.length, totalMessages: rows.length, hasWindowBefore: start > 0, hasWindowAfter: start + selected.length < rows.length};
}
module.exports = {userContent, itemRow, projectConversation, conversationWindow, previewText};
