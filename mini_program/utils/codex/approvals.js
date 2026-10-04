function approvalView(request, answers = {}, changes = []) {
  const params = request.params || {}, method = request.method, labels = {
    'item/commandExecution/requestApproval': '运行命令', 'item/fileChange/requestApproval': '修改文件',
    'item/permissions/requestApproval': '访问网络', 'item/tool/requestUserInput': '需要你的回复', 'mcpServer/elicitation/request': '工具需要确认'
  };
  return {key: JSON.stringify(request.id), title: labels[method] || '需要确认', method,
    detail: String(params.command || params.reason || params.message || '').slice(0, 12000),
    cwd: params.cwd || '', network: method === 'item/permissions/requestApproval', files: changes.map(file => ({path: file.path, kind: typeof file.kind === 'string' ? file.kind : file.kind && file.kind.type || ''})),
    questions: (params.questions || []).map(question => ({id: question.id, header: question.header || '', question: question.question || '', isSecret: !!question.isSecret,
      options: (question.options || []).map((option, index) => ({...option, selected: (answers[question.id] && answers[question.id].selected || []).includes(index)})),
      value: answers[question.id] && answers[question.id].text || '', multi: !!question.multiSelect})),
    elicitation: method === 'mcpServer/elicitation/request', url: params.url || '',
    permissionSupported: !params.permissions || !Object.keys(params.permissions).some(key => key !== 'network')};
}
function approvalResult(request, allow, answers) {
  if (request.method === 'item/tool/requestUserInput') {
    const result = {};
    for (const question of request.params.questions || []) {
      const reply = answers[question.id] || {}, values = (reply.selected || []).map(index => (question.options || [])[index]).filter(Boolean).map(option => option.label);
      if (reply.text && reply.text.trim()) values.push(reply.text.trim());
      if (!values.length) throw new Error('请回答每个问题后再提交。');
      result[question.id] = {answers: values};
    }
    return {answers: result};
  }
  if (request.method === 'item/permissions/requestApproval') {
    if (allow && Object.keys(request.params.permissions || {}).some(key => key !== 'network')) throw new Error('此权限需在原窗口处理。');
    return {permissions: allow && request.params.permissions && request.params.permissions.network ? {network: {enabled: true}} : {}, scope: 'turn'};
  }
  // The same Cloud policy as the browser: MCP authorization is handled on the computer.
  if (request.method === 'mcpServer/elicitation/request') return {action: allow ? 'cancel' : 'decline', content: null};
  return {decision: allow ? 'accept' : 'decline'};
}
module.exports = {approvalView, approvalResult};
