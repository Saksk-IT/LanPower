// Shared file-change labels and counts for the Web and mini-program clients.
const kindLabels = {add: '新增', delete: '删除', update: '修改', move: '移动'};
function fileChangeKind(change) {
  const kind = change.operation || (typeof change.kind === 'string' ? change.kind : change.kind && change.kind.type) || 'update';
  return kind === 'update' && (change.movedToPath || change.kind && change.kind.move_path) ? 'move' : kind;
}
function contentLines(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function fileChangeView(change) {
  const kind = fileChangeKind(change), diff = String(change.diff || '');
  const lines = contentLines(diff);
  const added = Number.isFinite(change.addedLineCount) ? change.addedLineCount : kind === 'add' ? lines.length : kind === 'delete' ? 0 : lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = Number.isFinite(change.removedLineCount) ? change.removedLineCount : kind === 'delete' ? lines.length : kind === 'add' ? 0 : lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return {path: change.path || '', label: change.path || '', movedToPath: change.movedToPath || change.kind && change.kind.move_path || '', kind,
    kindLabel: kind === 'move' && (added || removed) ? '移动并修改' : kindLabels[kind] || '修改', added, removed, diff};
}
function fileChangeSummary(changes, status = 'completed') {
  const files = (changes || []).filter(change => change.path).map(fileChangeView);
  const kinds = ['update', 'add', 'delete', 'move'].map(kind => {
    const count = files.filter(file => file.kind === kind).length;
    return count ? `${count} ${kindLabels[kind]}` : '';
  }).filter(Boolean).join('，');
  const verb = ['inProgress', 'in_progress', 'running'].includes(status) ? '正在更改' : status === 'failed' ? '更改失败' : status === 'declined' ? '已拒绝更改' : status === 'interrupted' ? '已停止更改' : '已更改';
  return {files, count: files.length, label: `${verb} ${files.length} 个文件`, kinds,
    added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0)};
}
function fileDiffLines(diff, kind = 'update') {
  const lines = contentLines(diff);
  let oldLine = 1, newLine = 1;
  return lines.map((line, index) => {
    const row = {key: index, kind: 'meta', oldLine: '', newLine: '', marker: '', text: line};
    if (kind === 'add' || kind === 'delete') return {...row, kind: kind === 'add' ? 'add' : 'remove',
      oldLine: kind === 'delete' ? index + 1 : '', newLine: kind === 'add' ? index + 1 : '', marker: kind === 'add' ? '+' : '-'};
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return {...row, kind: 'hunk'}; }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) return row;
    if (line.startsWith('+')) return {...row, kind: 'add', newLine: newLine++, marker: '+', text: line.slice(1)};
    if (line.startsWith('-')) return {...row, kind: 'remove', oldLine: oldLine++, marker: '-', text: line.slice(1)};
    if (line.startsWith(' ')) return {...row, kind: 'context', oldLine: oldLine++, newLine: newLine++, text: line.slice(1)};
    return row;
  });
}
module.exports = {fileChangeKind, fileChangeView, fileChangeSummary, fileDiffLines};
