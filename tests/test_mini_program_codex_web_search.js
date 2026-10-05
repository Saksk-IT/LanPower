const test = require('node:test'), assert = require('node:assert/strict');
const {webSearchView, updateWebSearchStatus} = require('../mini_program/utils/codex/web-search');
const {projectConversation, conversationWindow} = require('../mini_program/utils/codex/conversation');
const {CodexController} = require('../mini_program/utils/codex/controller');

test('网页历史缺少状态时显示已搜索，结束回合清除残留运行状态并保留失败', () => {
  assert.equal(webSearchView({query:'公开查询'}, 'inProgress').status, 'completed');
  for (const status of ['inProgress', 'in_progress', 'running', 'started', 'searching']) {
    assert.equal(webSearchView({status}, 'inProgress').status, 'inProgress');
    assert.equal(webSearchView({status}, 'completed').status, 'completed');
    assert.equal(webSearchView({status}, 'interrupted').status, 'interrupted');
    assert.equal(webSearchView({status}, 'failed').status, 'interrupted');
  }
  assert.equal(webSearchView({status:'failed',error:'公开错误'}, 'completed').status, 'failed');
});

test('原生搜索、多查询、网页打开及查找保留可读的完整摘要', () => {
  for (const [item, summary] of [
    [{query:'公开查询'}, '公开查询'],
    [{action:{type:'search',queries:['问题一','问题二','问题一']}}, '问题一 | 问题二'],
    [{query:'旧摘要',action:{type:'openPage',url:'https://example.com/docs'}}, 'https://example.com/docs'],
    [{action:{type:'findInPage',pattern:'设置',url:'https://example.com/docs'}}, '设置 | https://example.com/docs'],
  ]) assert.equal(webSearchView(item, 'completed').label, '已搜索网页：' + summary);
});

test('连续命令与网页共用活动组，说明及回合边界隔开，展开保留详情与窗口容器', () => {
  const command = id => ({id,type:'commandExecution',status:'completed',command:'verify',aggregatedOutput:'输出末尾',exitCode:0});
  const search = {id:'web',type:'webSearch',action:{type:'search',queries:['问题'.repeat(500),'问题二']},encryptedContent:'private-search-secret'};
  const thread = {turns:[{id:'t',status:'inProgress',items:[command('c'),search,command('c2'),{id:'comment',type:'agentMessage',text:'继续核对'}, {...search,id:'after'}]}, {id:'other',status:'completed',items:[{...search,id:'next'}]}]};
  const before = JSON.stringify(thread), collapsed = projectConversation(thread), groups = collapsed.filter(row => row.kind === 'activityGroup');
  assert.deepEqual(groups.map(row => row.label), ['运行了命令，已搜索网页','已搜索网页','已搜索网页']);
  assert.deepEqual(groups.map(row => row.count), [3,1,1]);
  const expanded = projectConversation(thread, new Set(), new Set([groups[0].key,'t:web']));
  const web = expanded.find(row => row.key === 't:web');
  assert.equal(web.icon, 'globe'); assert.equal(web.status, 'completed');
  assert.ok(web.label.length > 1000); assert.ok(!web.text.includes('private-search-secret'));
  const window = conversationWindow(expanded);
  assert.equal(window.messages.find(row => row.key === 't:web').nestedActivity, true);
  assert.equal(window.messages.find(row => row.key === groups[0].key).activityListHeight, 272);
  assert.equal(conversationWindow(expanded, 2).messages[0].nestedActivity, false, '裁剪掉标题时活动仍可阅读');
  assert.equal(JSON.stringify(thread), before);
});

test('搜索完成事件在整轮继续运行时立即更新，刷新也不借用回合运行状态', t => {
  const c = new CodexController({request:async()=>({}),stop:()=>{}}); t.after(()=>c.dispose());
  Object.assign(c,{state:'runtime_ready',deviceId:'pc',threadId:'chat',sharedControl:true,synced:true,current:{id:'chat',turns:[{id:'t',status:'inProgress',items:[]}]}});
  c.activeTurns.set('chat','t'); c.reconcile = () => {};
  const item = {id:'web',type:'webSearch',action:{query:'公开查询'}};
  c.onEvent({method:'item/started',params:{threadId:'chat',turnId:'t',item}});
  assert.equal(projectConversation(c.current).find(row=>row.kind==='activityGroup').label,'正在搜索网页');
  c.onEvent({method:'item/completed',params:{threadId:'chat',turnId:'t',item:{id:'web',type:'webSearch',action:{query:'公开查询'}}}});
  assert.equal(projectConversation(c.current).find(row=>row.kind==='activityGroup').label,'已搜索网页');
  assert.equal(c.current.turns[0].status,'inProgress');
  const failed = {type:'webSearch',status:'failed'}; updateWebSearchStatus(failed,'item/completed'); assert.equal(failed.status,'failed');
});
