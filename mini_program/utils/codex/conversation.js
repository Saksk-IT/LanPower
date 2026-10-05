const {markdown, utf8Length, elapsed} = require('../codex-format');
const {timestamp} = require('./model');
const {diffSummary} = require('../codex-format');
const {webSearchView} = require('./web-search');
const {fileChangeSummary, fileChangeView} = require('./file-changes');
const {parseUserEnvelope, attachmentSourceKey, mergeAttachmentImages} = require('./user-content');
const {markdownBlocks, markdownLinks} = require('./document');
const isRunning = status => ['inProgress', 'in_progress', 'running'].includes(status);
function activitySummary(members) {
  // Match remote_ui/src/lanpower/conversationPresentation.ts, including single commands.
  const commands = members.filter(member => member.activityType === 'command');
  const hasFiles = members.some(member => member.activityType === 'file');
  const searches = members.filter(member => member.activityType === 'web');
  const running = commands.some(member => isRunning(member.status));
  const failed = commands.some(member => member.status === 'failed' || member.status === 'completed' && typeof member.exitCode === 'number' && member.exitCode !== 0);
  const stopped = commands.some(member => ['interrupted', 'declined'].includes(member.status));
  const commandLabel = running ? '正在运行命令' : hasFiles ? commands.length ? '编辑了文件，运行了命令' : '编辑了文件' : commands.length ? '运行了命令' : '';
  const searchLabel = !searches.length ? '' : searches.some(member => isRunning(member.status)) ? '正在搜索网页'
    : searches.every(member => member.status === 'failed') ? '网页搜索失败'
    : searches.every(member => member.status === 'interrupted') ? '网页搜索已停止' : '已搜索网页';
  const searchNotice = searches.some(member => member.status === 'failed') ? '含失败搜索' : searches.some(member => member.status === 'interrupted') ? '含停止的搜索' : '';
  return {label: [commandLabel, searchLabel].filter(Boolean).join('，') || '思考过程', icon: hasFiles ? 'file-pencil' : commands.length ? 'terminal' : searches.length ? 'globe' : 'reasoning',
    failed: failed || searches.some(member => member.status === 'failed'), notice: [failed ? '含失败命令' : stopped ? '含停止或拒绝的命令' : '', searchNotice].filter(Boolean).join('，')};
}
function commandAction(item) {
  const actions = item.commandActions || [], action = actions.length === 1 ? actions[0] : null;
  const type = action && action.type, name = action && (action.name || action.path || action.query) || '';
  if (type === 'read') return {action: 'read', icon: 'book', label: `${isRunning(item.status) ? '正在读取' : '已读取'} ${name || '文件'}`};
  if (['listFiles', 'list_files'].includes(type)) return {action: 'list', icon: 'folder', label: `${isRunning(item.status) ? '正在列出' : '已列出'} ${name || '目录'}`};
  if (type === 'search') return {action: 'search', icon: 'search', label: `${isRunning(item.status) ? '正在搜索' : '已搜索'} ${name || '项目内容'}`};
  return {action: 'command', icon: 'terminal', label: isRunning(item.status) ? '正在运行命令' : item.status === 'failed' || item.status === 'completed' && typeof item.exitCode === 'number' && item.exitCode !== 0 ? '命令运行失败' : item.status === 'declined' ? '命令已拒绝' : item.status === 'interrupted' ? '命令已停止' : '已运行命令'};
}
function changesSummary(thread) {
  const turn = (thread && thread.turns || []).slice().reverse().find(value => value.diff || (value.items || []).some(item => item.type === 'fileChange' && (item.changes || []).length));
  if (!turn) return {turnId: '', files: [], count: 0, added: 0, removed: 0};
  const files = new Map();
  for (const item of turn.items || []) if (item.type === 'fileChange') for (const file of item.changes || []) {
    if (!file.path) continue;
    const view = fileChangeView(file), diff = view.diff, counts = view, previous = files.get(file.path);
    files.set(file.path, {...view, diff: (previous ? previous.diff + '\n' : '') + diff,
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
  const {text, attachments} = parseUserEnvelope(raw);
  const images = mergeAttachmentImages(blocks.filter(b => ['image', 'localImage', 'input_image', 'image_url'].includes(b.type)).map(b => b.url || b.path || (typeof b.image_url === 'string' ? b.image_url : b.image_url && b.image_url.url)), attachments);
  const imageKeys = new Set(images.map(attachmentSourceKey));
  return {text,
    files: attachments.filter(file => !file.image && !imageKeys.has(attachmentSourceKey(file.path))).map(({label, path}) => ({label, path})),
    skills: blocks.filter(b => b.type === 'skill').map(b => ({name: b.name, path: b.path})), images};
}
function itemRow(item, turn, index) {
  const row = {key: `${turn.id}:${item.id}`, turnId: turn.id, turnIndex: index, itemId: item.id, status: item.status || turn.status || '', text: '', kind: 'activity', label: '', images: [], files: [], skills: []};
  if (item.type === 'userMessage') return {...row, kind: 'user', ...userContent(item.content)};
  if (item.type === 'agentMessage') return {...row, kind: 'assistant', text: item.text || '', phase: item.phase || '', images: Array.from(String(item.text || '').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)).map(match => match[1])};
  if (item.type === 'reasoning') {
    const text = (item.summary || []).map(part => typeof part === 'string' ? part : part && part.text || '').filter(Boolean).join('\n\n');
    return text ? {...row, kind: 'reasoning', activityType: 'reasoning', icon: 'reasoning', label: '思考过程', text} : null;
  }
  if (item.type === 'plan') return {...row, kind: 'plan', label: '计划', text: item.text || ''};
  if (item.type === 'commandExecution') return {...row, activityType: 'command', ...commandAction({...item, status: row.status}), command: item.command || '', text: item.aggregatedOutput || '', exitCode: item.exitCode, cwd: item.cwd || ''};
  if (item.type === 'fileChange') {
    const summary = fileChangeSummary(item.changes, row.status);
    return {...row, activityType: 'file', action: 'file', icon: 'file-diff', label: summary.label, fileKinds: summary.kinds,
      added: summary.added, removed: summary.removed, files: summary.files, text: summary.files.map(file => `${file.path}\n${file.diff}`).join('\n\n')};
  }
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
  if (item.type === 'webSearch') return {...row, ...webSearchView(item, turn.status), activityType: 'web', action: 'search', icon: 'globe',
    text: JSON.stringify(item, function(key, value) { return ['encryptedContent', 'encrypted_content', 'reasoningContent', 'reasoning_content'].includes(key) ? undefined : value; }, 2)};
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
    const toolbarAnswer = normalized.filter(row => row.kind === 'assistant' && (!foldable || finalIds.has(row.key))).pop();
    normalized.forEach(row => { row.showActions = row.kind === 'user' || row === toolbarAnswer; });
    const start = timestamp(turn.startedAt), end = timestamp(turn.completedAt), duration = turn.durationMs !== undefined ? turn.durationMs : start && end ? end - start : undefined;
    const work = {key: `work:${turn.id}`, kind: 'work', turnId: turn.id, turnIndex: index, text: duration !== undefined ? `用时 ${elapsed(duration / 1000)}` : turn.status === 'inProgress' ? '正在工作' : turn.status === 'interrupted' ? '已停止' : '查看工作过程', visible: duration !== undefined || !!foldable || isRunning(turn.status) && !!start || turn.status === 'interrupted', foldable: !!foldable, expanded: expandedTurns.has(turn.id), images: [], files: [], skills: []};
    let inserted = false;
    for (let position = 0; position < normalized.length;) {
      const row = normalized[position];
      if (!inserted && row.kind !== 'user') { rows.push(work); inserted = true; }
      if (foldable && !expandedTurns.has(turn.id) && row.kind !== 'user' && row.kind !== 'large' && !finalIds.has(row.key)) { position++; continue; }
      if (!row.activityType || row.activityType === 'file' && !row.files.length) { rows.push({...row, expanded: row.kind === 'imageActivity' ? expandedImages.has(row.key) : expandedActivities.has(row.key), imagesExpanded: row.kind === 'user' || expandedImages.has(row.key)}); position++; continue; }
      const members = [];
      while (position < normalized.length && normalized[position].activityType && (normalized[position].activityType !== 'file' || normalized[position].files.length)) members.push(normalized[position++]);
      const key = `activity:${row.key}`, summary = activitySummary(members);
      rows.push({...row, key, itemId: '', command: '', files: [], kind: 'activityGroup', ...summary, text: '', activityType: '', count: members.length, expanded: expandedActivities.has(key)});
      if (expandedActivities.has(key)) rows.push(...members.map(member => ({...member, activityGroupKey: key, expanded: expandedActivities.has(member.key), failed: member.status === 'failed' || typeof member.exitCode === 'number' && member.exitCode !== 0})));
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
function conversationWindow(rows, offset = null, imageView = () => '', limit = 36) {
  const latest = offset === null, from = latest ? Math.max(0, rows.length - 36) : Math.max(0, Math.min(offset, Math.max(0, rows.length - 1)));
  let selected = [], bytes = 0, start = from;
  const candidates = rows.slice(from, from + limit);
  for (const row of (latest ? candidates.slice().reverse() : candidates)) {
    const visibleText = !['activity', 'reasoning', 'plan'].includes(row.kind) || row.expanded;
    const text = visibleText && row.activityType !== 'file' ? previewText(row.text) : '', value = {...row, text, hasMoreText: visibleText && row.activityType !== 'file' && text.length < String(row.text || '').length,
      label: previewText(row.label, 180), summary: previewText(row.summary, 220),
      command: previewText(row.command, 800),
      domId: 'row-' + encodeURIComponent(row.key).replace(/%/g, '-'),
      images: (row.images || []).map((source, index) => ({key: row.key + ':img:' + index, src: imageView(row.key, index), label: '查看图片'})),
      files: (row.activityType === 'file' && !row.expanded ? [] : row.files || []).map((file, index) => ({path: file.path, label: file.label || file.path, kind: file.kind || '',
        kindLabel: file.kindLabel || '', movedToPath: file.movedToPath || '', added: file.added || 0, removed: file.removed || 0, index})),
      fileListHeight: row.activityType === 'file' ? Math.min(320, (row.files || []).length * 36) : 0,
      links: [], blocks: []};
    if (row.kind === 'assistant' || row.kind === 'user' || ['reasoning', 'plan'].includes(row.kind) && row.expanded) {
      const nodes = markdown(text.replace(/!\[[^\]]*\]\([^)]+\)/g, ''));
      if (['assistant', 'user'].includes(row.kind)) value.links = markdownLinks(nodes);
      if (row.kind === 'assistant' && value.links.length) value.blocks = markdownBlocks(nodes);
      else if (row.kind !== 'user') value.nodes = nodes;
    }
    const size = utf8Length(JSON.stringify(value)); if (bytes + size > 380000) break;
    bytes += size; selected.push(value);
  }
  if (latest) { selected.reverse(); start = rows.length - selected.length; }
  const groups = new Set(selected.filter(row => row.kind === 'activityGroup').map(row => row.key));
  selected.forEach(row => { row.nestedActivity = !!row.activityGroupKey && groups.has(row.activityGroupKey); });
  selected.filter(row => row.kind === 'activityGroup').forEach(group => {
    const members = selected.filter(row => row.activityGroupKey === group.key);
    group.activityListHeight = Math.min(272, members.some(row => row.expanded) ? 272 : members.reduce((height, row) => height + (row.activityType === 'file' ? 54 : 30), 0));
  });
  return {messages: selected, windowStart: start, windowEnd: start + selected.length, totalMessages: rows.length, hasWindowBefore: start > 0, hasWindowAfter: start + selected.length < rows.length};
}
module.exports = {userContent, itemRow, projectConversation, conversationWindow, previewText, changesSummary};
