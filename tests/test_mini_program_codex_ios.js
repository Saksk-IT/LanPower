const test = require('node:test'), assert = require('node:assert/strict');
const {CodexController} = require('../mini_program/utils/codex/controller');
const {newSettings, observeSettings, effectiveSettings} = require('../mini_program/utils/codex/model');
const {permissionMode} = require('../mini_program/utils/codex/permissions');
const {projectConversation, conversationWindow, changesSummary} = require('../mini_program/utils/codex/conversation');
const root = 'C:/Fixture/Project';
const ask = {approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[root]}};
const full = {approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};
function setup(t) {
  const calls=[], connection={request:async(method,params)=>{calls.push({method,params});return {};},stop:()=>{}};
  const c=new CodexController(connection);Object.assign(c,{state:'runtime_ready',deviceId:'pc',threadId:'a',current:{id:'a',cwd:root,control:'remote',turns:[]},sharedControl:true,synced:true,permissionsSupported:true});
  observeSettings(c.threadSettings,{id:'a',model:'m',...ask},'m');c.reconcile=()=>{};t.after(()=>c.dispose());return {c,connection,calls};
}
test('批准状态使用电脑的完整设置，配置缺失不假定完全访问',()=>{
  assert.equal(permissionMode(ask,root),'ask');assert.equal(permissionMode({...ask,approvalsReviewer:'guardian_subagent'},root),'auto-review');assert.equal(permissionMode(full,root),'full-access');
  assert.equal(permissionMode({...ask,sandbox:{...ask.sandbox,writableRoots:['C:/Other']}},root),'custom');
  assert.equal(permissionMode({...full,activePermissionProfile:{id:'personal'}},root),'custom');assert.equal(permissionMode({approvalPolicy:'never'},root),'unknown');
  const settings=newSettings();observeSettings(settings,{id:'a',...full},'m');observeSettings(settings,{id:'a',model:'m'},'m');assert.equal(permissionMode(settings.permissions,root),'unknown');
});
test('权限切换等待原生确认，冻结发送并保留当前任务审批',async t=>{
  const {c,connection,calls}=setup(t);let resolve;connection.request=(method,params)=>{calls.push({method,params});return new Promise(done=>resolve=done);};
  c.activeTurns.set('a','running');c.approvals.set('pending',{id:'pending',params:{threadId:'a',turnId:'running'}});c.input('跟进任务');
  const pending=c.changePermissions('full-access');assert.equal(c.changingPermissions,true);assert.equal(permissionMode(c.threadSettings.permissions,root),'ask');
  await c.submit();await c.changePermissions('ask');assert.equal(calls.length,1);assert.deepEqual(calls[0],{method:'lanpower/permissions/set',params:{threadId:'a',permissionMode:'full-access'}});
  resolve({thread:{id:'a',...full}});await pending;assert.equal(c.changingPermissions,false);assert.equal(permissionMode(c.threadSettings.permissions,root),'full-access');assert.equal(c.activeTurn,'running');assert.equal(c.approvals.size,1);assert.match(c.feedback,/后续任务/);
});
test('原生权限更改未确认时保留实际状态，旧版本和自定义不会发送切换请求',async t=>{
  const {c,connection,calls}=setup(t);connection.request=async()=>{throw new Error('电脑未确认');};await c.changePermissions('full-access');assert.equal(permissionMode(c.threadSettings.permissions,root),'ask');assert.match(c.feedback,/未确认/);assert.equal(c.changingPermissions,false);
  c.permissionsSupported=false;await c.changePermissions('ask');c.permissionsSupported=true;await c.changePermissions('custom');assert.equal(calls.length,0);
});
test('切换会话后迟到的权限结果不进入新会话',async t=>{
  const {c,connection}=setup(t);let resolve;connection.request=()=>new Promise(done=>resolve=done);const pending=c.changePermissions('full-access');
  c.selection++;c.threadId='b';c.current={id:'b',cwd:root,turns:[]};observeSettings(c.threadSettings,{id:'b',...ask},'m');resolve({thread:{id:'a',...full}});await pending;
  assert.equal(permissionMode(c.threadSettings.permissions,root),'ask');assert.equal(c.changingPermissions,false);assert.equal(c.feedback,'');
});
test('断线后的旧权限确认不清除新请求的等待状态',async t=>{
  const {c,connection}=setup(t);const resolvers=[];connection.request=()=>new Promise(done=>resolvers.push(done));const old=c.changePermissions('full-access');
  c.onState('disconnected');Object.assign(c,{state:'runtime_ready',synced:true,permissionsSupported:true});const current=c.changePermissions('auto-review');
  resolvers[0]({thread:{id:'a',...full}});await old;assert.equal(c.changingPermissions,true);assert.equal(permissionMode(c.threadSettings.permissions,root),'ask');
  resolvers[1]({thread:{id:'a',...ask,approvalsReviewer:'auto_review'}});await current;assert.equal(c.changingPermissions,false);assert.equal(permissionMode(c.threadSettings.permissions,root),'auto-review');
});
test('电脑设置通知兼容 threadSettings，模型草稿和其他聊天权限分别同步',t=>{
  const {c}=setup(t);c.chooseSetting('effort','max');c.onEvent({method:'thread/settings/updated',params:{threadId:'a',threadSettings:{effort:'high',...full}}});
  assert.equal(permissionMode(c.threadSettings.permissions,root),'full-access');assert.equal(c.threadSettings.native.effort,'high');assert.equal(effectiveSettings(c.threadSettings).effort,'max');
  c.onEvent({method:'thread/settings/updated',params:{threadId:'b',threadSettings:ask}});assert.equal(permissionMode(c.threadSettings.permissions,root),'full-access');assert.equal(permissionMode(c.settings.get('pc:b').permissions,root),'ask');
});
test('单条命令和思考摘要默认折叠，全文保留且长命令不会撑大投影',()=>{
  const thread={turns:[{id:'t',status:'inProgress',items:[{id:'think',type:'reasoning',summary:['**检查布局**','只显示公开摘要']},{id:'cmd',type:'commandExecution',command:'node check '+ '界'.repeat(50000),aggregatedOutput:'完整输出',status:'completed',exitCode:1}]}]};
  const before=JSON.stringify(thread),rows=projectConversation(thread);assert.equal(rows.find(row=>row.kind==='reasoning').expanded,false);assert.equal(rows.find(row=>row.kind==='activity').expanded,false);assert.equal(rows.find(row=>row.kind==='activity').failed,true);
  const expanded=projectConversation(thread,new Set(),new Set(['t:think','t:cmd']));assert.equal(expanded.find(row=>row.key==='t:cmd').text,'完整输出');assert.equal(expanded.find(row=>row.key==='t:think').expanded,true);
  assert.ok(Buffer.byteLength(JSON.stringify(conversationWindow(expanded)))<1048576);assert.equal(JSON.stringify(thread),before);
});
test('命令按原生活动提示区分读取、目录、搜索；精简上下文独立显示',()=>{
  const thread={turns:[{id:'t',status:'inProgress',items:[{id:'read',type:'commandExecution',command:'read',commandActions:[{type:'read',name:'README.md'}],status:'completed'},{id:'list',type:'commandExecution',commandActions:[{type:'listFiles',path:'docs'}]},{id:'search',type:'webSearch',query:'布局'},{id:'compact',type:'contextCompaction'}]}]};
  const rows=projectConversation(thread);assert.match(rows.find(row=>row.kind==='activityGroup').label,/读取 1 个文件.*列出 1 个目录.*1 次搜索/);assert.equal(rows.find(row=>row.kind==='compaction').label,'已精简上下文');
});
test('更改摘要按最后一次有更改的任务读取，原生 diff 不重复累计',()=>{
  const thread={turns:[{id:'old',items:[{type:'fileChange',changes:[{path:'old.js',diff:'+ old'}]}]},{id:'current',diff:'--- a/new.js\n+++ b/new.js\n-old\n+new\n+next',items:[{type:'fileChange',changes:[{path:'new.js',diff:'-old\n+new\n+next'}]}]}]};
  const before=JSON.stringify(thread),summary=changesSummary(thread);assert.equal(summary.turnId,'current');assert.equal(summary.count,1);assert.equal(summary.added,2);assert.equal(summary.removed,1);assert.equal(JSON.stringify(thread),before);assert.equal(changesSummary({turns:[]}).count,0);
});
test('用户图片与回复内图片独立折叠，图片地址不重复进入普通链接区',()=>{
  const thread={turns:[{id:'t',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'image',url:'data:image/png;base64,YQ=='}]},{id:'a',type:'agentMessage',phase:'final_answer',text:'预览 ![图片](C:/Fixture/image.png) 与 [文档](C:/Fixture/README.md)'}]}]};
  const rows=projectConversation(thread);assert.equal(rows.find(row=>row.kind==='user').imagesExpanded,false);assert.equal(rows.find(row=>row.kind==='assistant').imagesExpanded,false);
  const visible=conversationWindow(projectConversation(thread,new Set(),new Set(),new Set(['t:a'])));assert.equal(visible.messages.find(row=>row.key==='t:a').imagesExpanded,true);assert.deepEqual(visible.messages.find(row=>row.key==='t:a').links,[{label:'文档',target:'C:/Fixture/README.md'}]);
});
let pageDefinition;global.Page=value=>pageDefinition=value;require('../mini_program/pages/codex/codex');delete global.Page;
function pageFor(c) {const page={...pageDefinition,data:structuredClone(pageDefinition.data),controller:c,connection:c.connection,visible:true,follow:false,imagePaths:new Map(),libraryOffset:0,groupOffsets:{},chatOffset:0};page.setData=patch=>Object.assign(page.data,patch);page.paint();return page;}
test('原生多图预览可左右切换，切换会话时不弹出旧图',async t=>{
  const {c}=setup(t),page=pageFor(c),opened=[];global.wx={previewImage:value=>opened.push(value)};c.rows=[{key:'images',images:['one','two']}];page.images={resolve:async source=>'/tmp/'+source};
  page.paint=()=>{};await page.viewImage({currentTarget:{dataset:{key:'images',index:1}}});assert.deepEqual(opened[0],{current:'/tmp/two',urls:['/tmp/one','/tmp/two']});
  let release;page.images.resolve=()=>new Promise(done=>release=done);c.rows=[{key:'images',images:['old']}];const pending=page.viewImage({currentTarget:{dataset:{key:'images',index:0}}});c.selection++;c.threadId='b';release('/tmp/old');await pending;assert.equal(opened.length,1);
});
test('相机和相册使用独立原生入口，选中的图片加入内存草稿',async t=>{
  const {c}=setup(t),page=pageFor(c),sources=[];const bytes=Uint8Array.from([137,80,78,71]).buffer;
  global.wx={chooseMedia:options=>{sources.push(options.sourceType);options.success({tempFiles:[{tempFilePath:'/tmp/photo.png'}]});},getFileSystemManager:()=>({readFile:options=>options.success({data:bytes})}),arrayBufferToBase64:bytes=>Buffer.from(bytes).toString('base64')};
  await page.addImages({currentTarget:{dataset:{source:'camera'}}});await page.addImages({currentTarget:{dataset:{source:'album'}}});assert.deepEqual(sources,[['camera'],['album']]);assert.equal(c.draft.images.length,2);
});
test('文件选择临时切后台后等待恢复，同一草稿只上传一次',async t=>{
  const {c,connection}=setup(t),page=pageFor(c),uploads=[];page.paint=()=>{};
  global.wx={chooseMessageFile:options=>{c.synced=false;setTimeout(()=>c.synced=true,20);options.success({tempFiles:[{name:'notes.md',path:'/tmp/notes.md'}]});},getFileSystemManager:()=>({readFile:options=>options.success({data:Uint8Array.from([65]).buffer})}),arrayBufferToBase64:bytes=>Buffer.from(bytes).toString('base64')};
  connection.request=async(method,params)=>{uploads.push({method,params});return {path:root+'/notes.md'};};const pending=page.addFiles();await page.addFiles();await pending;
  assert.equal(uploads.length,1);assert.equal(uploads[0].method,'lanpower/files/upload');assert.equal(c.draft.files[0].path,root+'/notes.md');assert.equal(page.data.uploadingAttachment,false);
});
test('电脑文件选择在会话弹窗中完成，添加引用后返回同一聊天',async t=>{
  const {c,connection}=setup(t),page=pageFor(c);page.data.view='chat';connection.request=async()=>({data:[{name:'README.md',path:'README.md'}]});page.openFileSheet();await new Promise(resolve=>setImmediate(resolve));page.paintResources();
  assert.equal(page.data.view,'chat');assert.equal(page.data.sheet,'files');assert.equal(page.data.fileState.files[0].name,'README.md');c.resources.state.selected={path:'README.md',content:'文档'};page.attachFile();assert.equal(page.data.sheet,'');assert.equal(c.draft.files[0].path,root+'/README.md');
});
