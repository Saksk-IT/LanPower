const test = require('node:test');
const assert = require('node:assert/strict');
const {CodexController} = require('../mini_program/utils/codex/controller');
const {clone, buildLibrary, defaultPreferences, effectiveSettings, pathKey} = require('../mini_program/utils/codex/model');
const {ReadScope, ContentReader, readThread, findBeginning, newBeginning, mergeHistory} = require('../mini_program/utils/codex/history');
const {projectConversation, conversationWindow} = require('../mini_program/utils/codex/conversation');
const {approvalResult} = require('../mini_program/utils/codex/approvals');
const {ResourceBrowser, ImageCache} = require('../mini_program/utils/codex/resources');
const root = 'C:\\Fixture\\LanPower';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('运行轮次的计时入口在用户输入之后和工作记录之前，尚无回复也保留入口',()=>{
  const user={id:'user',type:'userMessage',content:[{type:'text',text:'开始任务'}]}, comment={id:'comment',type:'agentMessage',phase:'commentary',text:'检查中'};
  const value={id:'running',status:'inProgress',startedAt:Date.now()-18000,items:[user,comment]};
  const rows=projectConversation({turns:[value]});
  assert.deepEqual(rows.map(row=>row.kind),['user','work','assistant']);assert.equal(rows[1].turnId,'running');assert.equal(rows[1].foldable,false);
  assert.deepEqual(projectConversation({turns:[{...value,items:[user]}]}).map(row=>row.kind),['user','work']);
  assert.deepEqual(projectConversation({turns:[{...value,items:[]}]}).map(row=>row.kind),['work']);
});
test('旧历史窗口按稳定轮次分支，新增桌面轮次时拒绝回退并保留阅读位置',async t=>{
  const {c,runtime}=await setup(t);const all=Array.from({length:180},(_,i)=>turn('t'+(i+1)));
  runtime.threads.find(row=>row.id==='a').turns=clone(all);c.current.turns=clone(all.slice(0,4));c.current.historyTailTurnId='t180';c.beginningIndex=0;
  await c.threadAction('fork','t1');assert.equal(runtime.threads.find(row=>row.id==='forked').turns.length,1);
  await c.selectThread('a');c.current.turns=clone(all.slice(0,4));c.current.historyTailTurnId='t180';c.beginningIndex=0;
  runtime.threads.find(row=>row.id==='a').turns.push(turn('t181'));await c.threadAction('rollback','t1');
  assert.equal(c.beginningIndex,0);assert.equal(c.current.turns.length,4);assert.equal(runtime.threads.find(row=>row.id==='a').turns.length,181);assert.match(c.feedback,/历史已变化/);
  c.current.historyTailTurnId='t181';await c.threadAction('rollback','t1');assert.equal(runtime.threads.find(row=>row.id==='a').turns.length,0);
});
test('长文字和文件引用完整发送，仍拒绝无效 Unicode',async t=>{
  const {c}=await setup(t);const draft={text:'🎨'.repeat(16000),images:[],skills:[],files:[]};assert.equal(c.makeInput(draft)[0].text,draft.text);
  assert.ok(c.makeInput({...draft,files:[{label:'资料',path:'D:/data.txt'}]})[0].text.length>16000);assert.throws(()=>c.makeInput({...draft,text:'\ud800'}),/Unicode/);
  c.input('中'.repeat(100000));await c.submit();assert.equal(c.draft.text,'');assert.equal(c.receipt.state,'accepted');
});
test('失效内容引用最多自动恢复三次，随后保留明确的手动重试入口',async t=>{
  const {c,runtime}=await setup(t);let revision=0;
  const descriptor=()=>({id:'large',type:'lanpowerLargeItem',originalType:'agentMessage',characters:100,reference:'expired-'+revision});
  c.current.turns=[{id:'huge',status:'completed',items:[descriptor()]}];
  runtime.overrides['lanpower/history/item/read']=async()=>{throw Object.assign(new Error('引用失效'),{code:'history_reference_expired'});};
  runtime.overrides['thread/turns/list']=async()=>{revision++;return {data:[{id:'huge',status:'completed',items:[descriptor()]}],nextCursor:null};};
  await c.restoreContent();assert.equal(runtime.calls.filter(row=>row.method==='lanpower/history/item/read').length,3);assert.match(Object.values(c.contentProgress).at(-1).error,/已暂停/);
});
const turn = (id, text = id) => ({id, status:'completed', items:[{id:id+'-u',type:'userMessage',content:[{type:'text',text:'任务 '+text}]},{id:id+'-a',type:'agentMessage',text:'回复 '+text,phase:'final_answer'}]});
class Runtime {
  constructor() {
    this.calls=[];this.overrides={};this.queue=[];this.revision=1;this.active=[];this.approvals=[];
    this.threads=[{id:'a',name:'聊天 A',cwd:root,control:'remote',model:'m-a',reasoningEffort:'medium',collaborationMode:'default',turns:[turn('old')]},{id:'b',name:'聊天 B',cwd:root,control:'remote',model:'m-b',reasoningEffort:'high',turns:[turn('b-old')]}];
  }
  async request(method,params={},scope) {
    if(scope)scope.check();this.calls.push({method,params:clone(params)});if(this.overrides[method])return this.overrides[method](params,scope);
    const thread=this.threads.find(row=>row.id===params.threadId);
    if(method==='lanpower/status')return {sharedControl:true,desktopControl:true,queueSupported:true,chatSupported:true,submissionReceipts:true,targetedHistoryActions:true,loggedIn:true,projects:[{name:'LanPower',path:root}],activeTurns:this.active,pendingApprovals:this.approvals,lanpowerRevision:this.revision,library:{revision:1,preferences:defaultPreferences()}};
    if(method==='lanpower/bootstrap')return {status:{sharedControl:true,desktopControl:true,queueSupported:true,chatSupported:true,submissionReceipts:true,targetedHistoryActions:true,loggedIn:true,projects:[{name:'LanPower',path:root}],activeTurns:this.active,pendingApprovals:this.approvals,lanpowerRevision:this.revision,library:{revision:1,preferences:defaultPreferences()}},models:[{id:'m-a',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}],defaultReasoningEffort:'medium'},{id:'m-b',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],planSupported:true,library:{data:this.threads.map(row=>({...row,turns:undefined})),pinned:[],nextCursor:null,revision:1}};
    if(method==='model/list')return {data:[{id:'m-a',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}],defaultReasoningEffort:'medium'},{id:'m-b',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}]};
    if(method==='collaborationMode/list')return {data:[{mode:'plan'}]};
    if(method==='thread/list')return {data:this.threads.map(row=>({...row,turns:undefined})),nextCursor:null};
    if(method==='thread/read')return {thread:clone({...thread,historyTailTurnId:thread.turns.at(-1)?.id,lanpowerRevision:this.revision})};
    if(method==='thread/queue/list')return {data:clone(this.queue),nextCursor:null};
    if(method==='turn/start'){const next={id:'new',status:'inProgress',items:[{id:'new-user',type:'userMessage',content:params.input}]};thread.turns.push(next);this.active=[{threadId:thread.id,turnId:next.id}];return {turn:next};}
    if(method==='turn/steer')return {turnId:params.expectedTurnId};
    if(method==='turn/interrupt'){this.active=[];thread.turns.at(-1).status='interrupted';return {};}
    if(method==='thread/queue/add'){this.queue.push({id:params.clientUserMessageId,input:params.input});return {};}
    if(method==='thread/queue/update'){this.queue.find(row=>row.id===params.queuedSubmissionId).input=params.input;return {};}
    if(method==='thread/queue/delete'){this.queue=this.queue.filter(row=>row.id!==params.queuedSubmissionId);return {};}
    if(method==='thread/queue/start'){this.queue=this.queue.filter(row=>row.id!==params.queuedSubmissionId);return {};}
    if(method==='thread/queue/reorder'){this.queue=params.queuedSubmissionIds.map(id=>this.queue.find(row=>row.id===id));return {};}
    if(method==='thread/start'||method==='lanpower/chat/start'){const value={id:'created',name:'新聊天',cwd:params.cwd||'',isChat:!params.cwd,control:'remote',turns:[]};this.threads.push(value);return {thread:value};}
    if(method==='thread/name/set'){thread.name=params.name;return {};}
    if(method==='thread/fork'){const value=clone({...thread,id:'forked'});this.threads.push(value);return {thread:value};}
    if(method==='thread/rollback'){thread.turns.splice(-params.numTurns);return {thread:clone(thread)};}
    if(method==='lanpower/history/action'){
      const index=thread.turns.findIndex(turn=>turn.id===params.turnId);
      if(index<0||thread.turns.at(-1)?.id!==params.expectedTailTurnId)throw Object.assign(new Error('原窗口历史已变化'),{code:'history_changed',uncertain:false});
      if(params.action==='fork'){const value=clone({...thread,id:'forked',turns:thread.turns.slice(0,index+1)});this.threads.push(value);return {thread:value};}
      thread.turns.splice(index);return {thread:clone({...thread,historyTailTurnId:thread.turns.at(-1)?.id})};
    }

    if(method==='thread/archive'||method==='thread/unarchive')return {};
    if(method==='lanpower/library/update')return {revision:params.revision+1,preferences:params.preferences};
    if(method==='lanpower/submission/read')return {state:'accepted'};
    if(method==='thread/resume')return {};
    throw new Error('测试未提供接口 '+method);
  }
  async paceHistory(scope){if(scope)scope.check();}
  connect(){}
  stop(){}
  reconcileApprovals(){}
  async decide(id,result){this.calls.push({method:'decide',params:{id,result}});this.approvals=this.approvals.filter(row=>row.id!==id);}
}
async function setup(t){const runtime=new Runtime(),c=new CodexController(runtime);t.after(()=>c.dispose());c.deviceId='pc-a';c.state='runtime_ready';await c.restore();await c.selectThread('a');return {c,runtime};}
test('bootstrap 内的首屏聊天直接展示，完整状态确认前不开放控制', async t => {
  const {c, runtime} = await setup(t); c.onState('disconnected'); c.state = 'runtime_ready';
  const before = runtime.calls.filter(row => row.method === 'thread/read').length;
  const status = await runtime.request('lanpower/status'); let confirm;
  runtime.overrides['lanpower/bootstrap'] = async () => ({status: {...status, fast: true, loggedIn: false}, models: [],
    library: {data: [], pinned: [], stale: true, refreshing: true}, thread: clone({...runtime.threads[0], lanpowerRevision: runtime.revision})});
  runtime.overrides['lanpower/status'] = () => new Promise(resolve => {confirm = () => resolve(status);});
  await c.restore(); assert.equal(c.current.id, 'a'); assert.equal(c.synced, true); assert.equal(c.canControl, false);
  assert.equal(runtime.calls.filter(row => row.method === 'thread/read').length, before, '不重复读取 bootstrap 已附带的聊天');
  assert.equal(c.threads.length, 2, '后台目录尚未准备好时保留原列表');
  confirm(); await tick(); assert.equal(c.canControl, true);
});
test('旧 Host 不支持 bootstrap 时恢复为分步加载', async t => {
  const {c, runtime} = await setup(t); c.onState('disconnected'); c.state = 'runtime_ready';
  runtime.overrides['lanpower/bootstrap'] = async () => {throw Object.assign(new Error('旧 Host'), {code: 'unsupported_method'});};
  await c.restore(); assert.equal(c.bootstrapSupported, false); assert.equal(c.current.id, 'a'); assert.equal(c.canControl, true);
});
test('目录预热中的空页不删除缓存条目，也不核验尚未完成的索引', async t => {
  const {c, runtime} = await setup(t); c.libraryCatalog = true;
  runtime.overrides['lanpower/library/list'] = async () => ({data: [], pinned: [], stale: true, refreshing: true});
  await c.loadThreads(); assert.equal(c.threads.length, 2); assert.ok(!runtime.calls.some(row => row.method === 'lanpower/library/check'));
});
test('恢复原窗口模型、思考强度、计划能力与项目',async t=>{const {c}=await setup(t);assert.equal(c.canControl,true);assert.deepEqual(effectiveSettings(c.threadSettings),{model:'m-a',effort:'medium',mode:'default'});assert.equal(c.planSupported,true);assert.equal(c.projects[0].path,root);});
test('未发送参数不被轮询覆盖，成功发送后恢复继承',async t=>{const {c,runtime}=await setup(t);c.chooseSetting('model','m-b');c.chooseSetting('mode','plan');await c.refreshCurrent();assert.equal(effectiveSettings(c.threadSettings).model,'m-b');c.input('开始任务');await c.submit();const call=runtime.calls.find(row=>row.method==='turn/start');assert.equal(call.params.model,'m-b');assert.equal(call.params.effort,'high');assert.equal(call.params.mode,'plan');assert.equal(c.receipt.state,'accepted');assert.deepEqual(c.threadSettings.overrides,{});});
test('不同聊天和电脑隔离草稿、附件与参数',async t=>{const {c}=await setup(t);c.input('A 的草稿');c.addFile(root+'\\README.md');c.addSkill({name:'check',path:root+'\\skill'});c.chooseSetting('mode','plan');await c.selectThread('b');c.input('B 的草稿');assert.equal(c.draft.files.length,0);await c.selectThread('a');assert.equal(c.draft.text,'A 的草稿');assert.equal(c.draft.files.length,1);assert.equal(effectiveSettings(c.threadSettings).mode,'plan');c.chooseDevice('pc-b');assert.equal(c.draft.text,'');assert.equal(c.current,null);assert.equal(c.threads.length,0);});
test('失去确认的提交冻结输入，恢复只查询回执',async t=>{const {c,runtime}=await setup(t);runtime.overrides['turn/start']=async()=>{throw Object.assign(new Error('连接丢失'),{code:'CONNECTION',uncertain:true});};c.input('只能发送一次');await c.submit();assert.equal(c.receipt.state,'uncertain');assert.equal(c.sendBlocked,true);await c.submit();assert.equal(runtime.calls.filter(row=>row.method==='turn/start').length,1);c.onState('disconnected');c.state='runtime_ready';await c.restore();assert.equal(c.receipt.state,'accepted');assert.equal(runtime.calls.filter(row=>row.method==='turn/start').length,1);});
test('明确拒绝恢复文字、文件、技能和图片草稿',async t=>{const {c,runtime}=await setup(t);runtime.overrides['turn/start']=async()=>{throw Object.assign(new Error('拒绝'),{uncertain:false});};c.input('保存输入');c.addFile(root+'\\README.md');c.addSkill({name:'check',path:root+'\\skill'});c.draft.images.push({url:'data:image/png;base64,YQ==',src:'temp.png'});await c.submit();assert.equal(c.receipt.state,'failed');assert.equal(c.draft.text,'保存输入');assert.equal(c.draft.files.length,1);assert.equal(c.draft.skills.length,1);assert.equal(c.draft.images.length,1);});
test('运行中明确选择排队或引导，避免重新启动任务',async t=>{const {c,runtime}=await setup(t);c.activeTurns.set('a','running');runtime.active=[{threadId:'a',turnId:'running'}];c.chooseSetting('model','m-b');c.input('排队任务');await c.submit('queue');assert.equal(c.queue.length,1);const queued=runtime.calls.find(row=>row.method==='thread/queue/add');assert.ok(queued.params.submissionId);assert.ok(!('model'in queued.params));c.input('改当前任务');await c.submit('steer');assert.equal(runtime.calls.find(row=>row.method==='turn/steer').params.expectedTurnId,'running');assert.equal(runtime.calls.filter(row=>row.method==='turn/start').length,0);});
test('编辑排队消息保留原生文件、技能、图片结构，支持排序与删除',async t=>{const {c,runtime}=await setup(t);runtime.queue=[{id:'q1',input:[{type:'text',text:'# Files mentioned by the user:\n## README.md: C:/Fixture/README.md\n\n## My request for Codex:\n检查文件'},{type:'skill',name:'check',path:'C:/Fixture/skill'},{type:'image',url:'data:image/png;base64,YQ=='}]},{id:'q2',input:[{type:'text',text:'第二条'}]}];await c.refreshQueue();c.editQueue('q1');assert.equal(c.draft.text,'检查文件');assert.equal(c.draft.skills.length,1);assert.equal(c.draft.files.length,1);assert.equal(c.draft.images.length,1);c.input('修改后的要求');await c.submit();assert.equal(runtime.calls.find(row=>row.method==='thread/queue/update').params.input[1].type,'image');assert.equal(runtime.queue[0].input[2].type,'skill');await c.queueAction('reorder','q2',-1);assert.equal(c.queue[0].id,'q2');await c.queueAction('delete','q1');assert.equal(c.queue.length,1);await c.queueAction('start','q2');assert.equal(c.queue.length,0);});
test('晚到的读取结果不覆盖实时新任务',async t=>{const {c,runtime}=await setup(t);let release;runtime.overrides['thread/read']=()=>new Promise(resolve=>{release=()=>resolve({thread:clone({...runtime.threads[0],lanpowerRevision:1})});});const syncing=c.refreshCurrent();await tick();c.onEvent({method:'turn/started',params:{threadId:'a',lanpowerRevision:2,turn:{id:'new-live',status:'inProgress',items:[]}}});release();await syncing;assert.equal(c.activeTurn,'new-live');assert.ok(c.current.turns.some(turn=>turn.id==='new-live'));});
test('旧任务结束通知不停止较新的活动任务',async t=>{const {c}=await setup(t);c.activeTurns.set('a','newer');c.onEvent({method:'turn/completed',params:{threadId:'a',lanpowerRevision:2,turn:{id:'older',status:'completed',items:[]}}});assert.equal(c.activeTurn,'newer');});
test('旧电脑的延迟响应不能渗入新电脑',async t=>{const {c,runtime}=await setup(t);let release;runtime.overrides['thread/read']=()=>new Promise(resolve=>{release=()=>resolve({thread:clone(runtime.threads[1])});});const read=c.selectThread('b');await tick();c.chooseDevice('pc-b');release();await read;assert.equal(c.current,null);assert.equal(c.threadId,'');assert.equal(c.messages().messages.length,0);});
test('后台清空审批和控制，保留未发草稿且不重发',async t=>{const {c,runtime}=await setup(t);c.input('尚未发送');c.approvals.set('1',{id:1,method:'item/fileChange/requestApproval',params:{threadId:'a'}});c.onState('disconnected');assert.equal(c.canControl,false);assert.equal(c.approvals.size,0);assert.equal(c.draft.text,'尚未发送');c.state='runtime_ready';await c.restore();assert.equal(c.draft.text,'尚未发送');assert.equal(runtime.calls.filter(row=>row.method==='turn/start').length,0);});
test('状态恢复失败时保留缓存但不开放控制',async t=>{const {c,runtime}=await setup(t);c.onState('disconnected');runtime.overrides['lanpower/status']=async()=>{throw new Error('无法读取原窗口');};runtime.overrides['lanpower/bootstrap']=async()=>{throw new Error('无法读取原窗口');};c.state='runtime_ready';await c.restore();assert.ok(c.current);assert.equal(c.canControl,false);assert.equal(c.recovering,false);});
test('桌面只读与未完成恢复时不允许发送或停止',async t=>{const {c,runtime}=await setup(t);c.sharedControl=false;c.current.control='desktop';c.input('只读');await c.submit();assert.equal(c.canControl,false);assert.equal(runtime.calls.some(row=>row.method==='turn/start'),false);c.sharedControl=true;c.recovering=true;assert.equal(c.canControl,false);});
test('模型与历史接口按能力分页，过大历史自动减小范围',async()=>{const limits=[],client={paceHistory:async()=>{},request:async(method,params)=>{limits.push(params.historyLimit);if(params.historyLimit>2)throw Object.assign(new Error(),{code:'result_too_large'});return {thread:{id:'a'}};}};assert.equal((await readThread(client,'a',new ReadScope())).thread.id,'a');assert.deepEqual(limits,[8,4,2]);});
test('大量聊天分页不再在 200 条截断',async t=>{const {c,runtime}=await setup(t);c.threads=[];runtime.overrides['thread/list']=async params=>{const page=Number(params.cursor||0);return {data:Array.from({length:50},(_,index)=>({id:String(page*50+index),name:'任务',cwd:root})),nextCursor:page<5?String(page+1):null};};await c.loadThreads();for(let index=0;index<5;index++)await c.loadThreads(true);assert.equal(c.threads.length,300);assert.equal(c.listCursor,'');});
test('同名项目依完整路径归属，保留空项目和独立聊天',()=>{const prefs=defaultPreferences(),result=buildLibrary([{name:'同名',path:'C:/Work/X'},{name:'同名',path:'D:/Work/X'},{name:'空项目',path:'D:/Empty'}],[{id:'a',cwd:'c:\\work\\x\\sub',name:'A'},{id:'b',cwd:'D:/Work/X',name:'B'},{id:'chat',cwd:'',isChat:true,name:'独立'}],prefs);assert.equal(result.projects.length,3);assert.equal(result.projects.find(row=>row.path==='C:/Work/X').threads[0].id,'a');assert.equal(result.chats.length,1);assert.equal(pathKey('\\\\?\\C:\\Work\\X'),'c:/work/x');});
test('项目收纳、置顶、排序、展开状态通过电脑端版本更新',async t=>{const {c,runtime}=await setup(t);c.changeLibrary('pinned','a');c.changeLibrary('collapsed',pathKey(root));c.changeLibrary('sort','','created');c.changeLibrary('chatsFirst','',true);await c.flushLibrary();const call=runtime.calls.find(row=>row.method==='lanpower/library/update');assert.equal(call.params.revision,1);assert.deepEqual(call.params.preferences.pinned,['a']);assert.equal(call.params.preferences.chatsFirst,true);assert.equal(c.library.revision,2);});
test('原生重命名、分支、回退、归档、恢复和独立聊天',async t=>{const {c,runtime}=await setup(t);await c.threadAction('rename','新名字');assert.equal(c.current.name,'新名字');await c.threadAction('fork');assert.equal(c.threadId,'forked');c.current.turns.push(turn('rollback'));runtime.threads.find(row=>row.id==='forked').turns.push(turn('rollback'));await c.refreshCurrent();await c.threadAction('rollback','rollback');assert.equal(c.current.turns.length,1);await c.threadAction('archive');assert.equal(c.threadId,'');const id=await c.createThread('',true);assert.equal(id,'created');assert.equal(c.current.isChat,true);await c.toggleArchived();await c.selectThread('a');assert.equal(c.canControl,false);await c.threadAction('unarchive');assert.equal(c.threadId,'');});
test('逐条审批只发一次，服务端状态恢复后才解除等待',async t=>{const {c,runtime}=await setup(t);c.activeTurns.set('a','live');const request={id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'a',turnId:'live'}};runtime.approvals=[request];c.approvals.set(JSON.stringify(request.id),request);await Promise.all([c.decide(JSON.stringify(request.id),true),c.decide(JSON.stringify(request.id),true)]);assert.equal(runtime.calls.filter(row=>row.method==='decide').length,1);assert.deepEqual(runtime.calls.find(row=>row.method==='decide').params.result,{decision:'accept'});});
test('问题支持选项、补充、多选并发送原生答案',()=>{const request={method:'item/tool/requestUserInput',params:{questions:[{id:'mode',options:[{label:'A'},{label:'B'}],multiSelect:true},{id:'note'}]}};const result=approvalResult(request,true,{mode:{selected:[0,1],text:'附加'},note:{text:'说明'}});assert.deepEqual(result.answers.mode.answers,['A','B','附加']);assert.deepEqual(result.answers.note.answers,['说明']);assert.throws(()=>approvalResult(request,true,{}),/每个问题/);});
test('网络授权只限本任务，不接受扩大权限；MCP授权按网页边界在电脑处理',()=>{assert.deepEqual(approvalResult({method:'item/permissions/requestApproval',params:{permissions:{network:{enabled:true}}}},true,{}),{permissions:{network:{enabled:true}},scope:'turn'});assert.throws(()=>approvalResult({method:'item/permissions/requestApproval',params:{permissions:{fileSystem:{}}}},true,{}),/原窗口/);assert.deepEqual(approvalResult({method:'mcpServer/elicitation/request',params:{}},false,{}),{action:'decline',content:null});});
test('完整历史定位可取消并接续，游标循环明确失败',async()=>{const scope=new ReadScope(),job=newBeginning();let calls=0;const client={paceHistory:async()=>{},request:async(method,params)=>{calls++;return {data:[turn(params.cursor||'latest')],nextCursor:params.cursor==='older'?null:'older'};}};await assert.rejects(findBeginning(client,'a',job,scope,()=>scope.cancel()),{code:'CANCELLED'});assert.equal(job.count,1);await findBeginning(client,'a',job,new ReadScope());assert.equal(calls,2);assert.equal(job.count,2);assert.equal(job.complete,true);const cyclic={paceHistory:async()=>{},request:async()=>({data:[],nextCursor:'same'})};await assert.rejects(findBeginning(cyclic,'a',newBeginning(),new ReadScope()),/未推进/);});
test('超大 Unicode 内容分段恢复，保留全文并拒绝串项',async()=>{const item={id:'big',type:'commandExecution',aggregatedOutput:'完整内容🎨'.repeat(80000)},body=JSON.stringify(item),placeholder={id:'big',type:'lanpowerLargeItem',reference:'ref',originalType:'commandExecution',characters:body.length};const client={paceHistory:async()=>{},request:async(method,params)=>{const data=body.slice(params.offset,params.offset+16000);return {offset:params.offset,data,characters:body.length,nextOffset:params.offset+data.length===body.length?null:params.offset+data.length};}};const reader=new ContentReader('a');await reader.read(client,placeholder,new ReadScope());assert.equal(reader.apply([{id:'t',items:[placeholder]}])[0].items[0].aggregatedOutput,item.aggregatedOutput);const broken={...client,request:async()=>({offset:1,data:'x',characters:body.length,nextOffset:2})};await assert.rejects(new ContentReader('a').read(broken,placeholder,new ReadScope()),/不连续/);});
test('窗口投影不删除原始历史或长正文，完整内容仍可访问',()=>{const turns=Array.from({length:180},(_,index)=>turn(String(index),'中文🎨'.repeat(3000))),source={turns},rows=projectConversation(source),before=JSON.stringify(source),view=conversationWindow(rows);assert.ok(view.messages.length<=36);assert.ok(Buffer.byteLength(JSON.stringify(view))<1048576);assert.equal(view.hasWindowBefore,true);assert.equal(JSON.stringify(source),before);assert.ok(view.messages.some(row=>row.hasMoreText));assert.equal(mergeHistory([turn('1'),turn('2')],[turn('2'),turn('3')]).length,3);});
test('工作过程、命令、文件分组不影响最终回复和完整内容',()=>{const value={id:'t',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'任务'}]},{id:'commentary',type:'agentMessage',phase:'commentary',text:'处理中'},{id:'cmd',type:'commandExecution',command:'check',aggregatedOutput:'完整输出'},{id:'file',type:'fileChange',changes:[{path:'x.js',diff:'-old\n+new'}]},{id:'final',type:'agentMessage',phase:'final_answer',text:'完成'}]};assert.ok(!projectConversation({turns:[value]}).some(row=>row.itemId==='commentary'));const rows=projectConversation({turns:[value]},new Set(['t']),new Set(['activity:t:cmd']));assert.equal(rows.filter(row=>row.kind==='activity').length,2);assert.equal(rows.find(row=>row.itemId==='cmd').text,'完整输出');assert.equal(rows.find(row=>row.itemId==='file').files[0].diff,'-old\n+new');});
test('完成后四条查看图片和过程插图一起收起，最终图片与生成结果保留',()=>{
  const views=Array.from({length:4},(_,i)=>({id:'view-'+i,type:'imageView',path:root+'/image-'+i+'.png'}));
  const value={id:'t',status:'completed',durationMs:1557000,items:[{id:'u',type:'userMessage',content:[{type:'text',text:'任务'}]},...views,{id:'comment',type:'agentMessage',phase:'commentary',text:'过程 ![参考](D:/Fixture/process.png)'},{id:'final',type:'agentMessage',phase:'final_answer',text:'完成 ![结果](D:/Fixture/final.png)'}]};
  const before=JSON.stringify(value),collapsed=projectConversation({turns:[value]});
  assert.deepEqual(collapsed.map(row=>row.key),['t:u','work:t','t:final']);assert.equal(collapsed[1].expanded,false);
  const expanded=projectConversation({turns:[value]},new Set(['t']),new Set(),new Set(['t:view-0']));
  assert.equal(expanded.filter(row=>row.imageAction==='view').length,4);assert.equal(expanded.find(row=>row.key==='t:view-0').expanded,true);assert.equal(JSON.stringify(value),before);
  for(const status of ['inProgress','failed','interrupted'])assert.equal(projectConversation({turns:[{...value,status}]}).filter(row=>row.imageAction==='view').length,4);
  const generated={id:'generated',type:'imageGeneration',result:'data:image/png;base64,fixture'};
  assert.ok(projectConversation({turns:[{...value,items:[...value.items,generated]}]}).some(row=>row.key==='t:generated'));
});
test('文件浏览、搜索、预览和技能目录使用目标电脑接口且隔离旧结果',async()=>{const calls=[],client={request:async(method,params)=>{calls.push({method,params});if(method==='lanpower/files/read')return {path:'README.md',content:'正文'.repeat(9000)};if(method==='skills/list')return {data:[{skills:[{name:'skill',path:'x',enabled:true}]}]};return {data:[{name:'README.md',path:'README.md'}],nextCursor:null};}};const resource=new ResourceBrowser(client,()=>true,()=>{});await resource.open(root);await resource.search('README');await resource.files('lanpower/files/read',{path:'README.md'});assert.equal(resource.fileView().selected.hasMore,true);assert.ok(resource.state.selected.content.length>8000);await resource.directoryCatalog('skill',root);assert.equal(resource.catalog.rows[0].name,'skill');assert.ok(calls.every(call=>call.params.cwd===root));let release;client.request=()=>new Promise(resolve=>release=resolve);const old=resource.directory('.');resource.reset();release({data:[{name:'secret'}]});await old;assert.equal(resource.state.files.length,0);});
test('图片认证读取使用会话，临时图片在清理时删除',async()=>{const calls=[],deleted=[],wxApi={env:{USER_DATA_PATH:'/tmp/fixture'},base64ToArrayBuffer:value=>Uint8Array.from(Buffer.from(value,'base64')).buffer,getFileSystemManager:()=>({writeFile:options=>options.success(),unlink:options=>deleted.push(options.filePath)})},client={request:async(method,params)=>{calls.push({method,params});return {contentType:'image/png',base64:'YQ==',size:1};}};const cache=new ImageCache(wxApi,client);const path=await cache.resolve(root+'\\image.png','a',root);assert.equal(calls[0].params.threadId,'a');assert.equal(calls[0].method,'lanpower/image/read');assert.ok(path.includes('codex-preview'));cache.clear();assert.equal(deleted.length,1);});

test('完整聊天库独立读取置顶、查询未加载会话并可靠同步归档',async t=>{
  const {c,runtime}=await setup(t);c.libraryCatalog=true;
  const all=Array.from({length:180},(_,i)=>({id:'chat-'+i,name:i===170?'目标聊天':'聊天 '+i,cwd:root,updatedAt:180-i}));
  let archived=new Set();runtime.overrides['lanpower/library/list']=async p=>{const rows=all.filter(row=>archived.has(row.id)===!!p.archived&&(!p.query||row.name.includes(p.query))),offset=Number(p.cursor||0);return {data:rows.slice(offset,offset+50),pinned:rows.filter(row=>row.id==='chat-170'),nextCursor:offset+50<rows.length?String(offset+50):null};};
  runtime.overrides['lanpower/library/check']=async p=>({data:all.filter(row=>p.threadIds.includes(row.id)&&archived.has(row.id)===!!p.archived)});
  await c.loadThreads();assert.ok(c.threads.some(row=>row.id==='chat-170'));await c.loadThreads(true);await c.loadThreads(true);await c.loadThreads(true);
  archived.add('chat-1');await c.loadThreads();assert.ok(!c.threads.some(row=>row.id==='chat-1'));assert.ok(c.threads.some(row=>row.id==='chat-150'));
  c.searchLibrary('目标');await tick();assert.deepEqual(c.threads.map(row=>row.id),['chat-170']);assert.ok(runtime.calls.some(row=>row.method==='lanpower/library/list'&&row.params.query==='目标'));
});
