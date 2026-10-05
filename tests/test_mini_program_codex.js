const assert = require('node:assert/strict');
const {CodexConnection} = require('../mini_program/utils/codex-remote');
const {markdown, diffSummary} = require('../mini_program/utils/codex-format');
const {CLIENT_KEY} = require('../mini_program/utils/cloud');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 600; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('页面未到达预期状态');
}
class Socket {
  constructor(send) { this.transport = send; this.frames = []; }
  onOpen(fn) { this.openHandler = fn; }
  onMessage(fn) { this.messageHandler = fn; }
  onClose(fn) { this.closeHandler = fn; }
  onError(fn) { this.errorHandler = fn; }
  frame(value) { this.messageHandler({data: JSON.stringify(value)}); }
  send(options) { this.frames.push(JSON.parse(options.data)); options.success(); if (this.transport) this.transport(this, this.frames.at(-1)); }
  close() { this.closed = true; }
}
function timerHarness() { const jobs = new Map(); let sequence = 0; return {
  jobs, timer: (fn, delay) => { const id = ++sequence; jobs.set(id, {fn, delay}); return id; }, clearTimer: id => jobs.delete(id)
}; }

async function main() {
  const timers = timerHarness(), sockets = [], states = [], events = [], cloud = {
    session: {url: 'https://power.example.com', access_token: 'fixture-only', access_expires_at: Date.now() / 1000 + 3600}, call: async () => ({})};
  let handshake;
  const connection = new CodexConnection({cloud, wxApi: {connectSocket: options => {
    handshake = options; const socket = new Socket(); sockets.push(socket); return socket;
  }}, state: state => states.push(state), event: event => events.push(event), ...timers});
  connection.connect('pc-a'); await tick(); const socket = sockets[0]; socket.openHandler();
  assert.equal(handshake.url, 'wss://power.example.com/api/v2/remote/mobile/pc-a');
  assert.deepEqual(handshake.protocols, ['lanpower.codex.v1']); assert.equal(handshake.header.Authorization, 'Bearer fixture-only');
  const request = connection.request('thread/list'); const rpc = socket.frames.at(-1).payload;
  socket.frame({type: 'rpc', payload: {id: rpc.id, result: {data: []}}}); assert.deepEqual(await request, {data: []});
  const large = connection.request('thread/turns/list', {threadId: 'native'}), largeId = socket.frames.at(-1).payload.id;
  const fullText = '完整历史🎨'.repeat(90000), body = JSON.stringify({id: largeId, result: {text: fullText}}), chunks = body.match(/[\s\S]{1,16000}/g);
  chunks.forEach((data, index) => socket.frame({type: 'rpc_chunk', id: largeId, index, count: chunks.length, data}));
  assert.equal((await large).text, fullText); assert.equal(connection.fragments.parts.size, 0);
  socket.frame({type: 'ping'}); assert.deepEqual(socket.frames.at(-1), {type: 'pong'});
  const lostTask = connection.request('turn/start', {threadId: 'chat', input: [{type: 'text', text: 'change'}]});
  socket.closeHandler({code: 1006}); await assert.rejects(lostTask, {code: 'CONNECTION'});
  assert.equal(connection.pending.size, 0);
  const retry = Array.from(timers.jobs.values()).find(job => job.delay === 1000); retry.fn(); await tick();
  const second = sockets[1]; second.openHandler();
  socket.frame({type: 'state', state: 'runtime_ready'}); assert.notEqual(states.at(-1), 'runtime_ready');
  assert.equal(second.frames.filter(f => f.payload?.method === 'turn/start').length, 0, 'lost task must never replay');
  connection.stop(); assert.equal(timers.jobs.size, 0);
  const forbidden = new CodexConnection({cloud: {...cloud, call: async () => { const error = new Error(); error.code = 'FORBIDDEN'; throw error; }},
    wxApi: {connectSocket: () => assert.fail('forbidden client opened a socket')}, event: () => {}, state: s => states.push(s), ...timers});
  forbidden.connect('pc-a'); await tick(); assert.equal(states.at(-1), 'forbidden'); forbidden.stop();
  const lateCloud = {...cloud, call: () => new Promise(resolve => {lateCloud.resolve = resolve;})};
  const late = new CodexConnection({cloud: lateCloud, wxApi: {connectSocket: () => assert.fail('hidden page opened a socket')},
    event: () => {}, state: () => {}, ...timers});
  late.connect('pc-a'); late.stop(); lateCloud.resolve({}); await tick();

  const unsafe = markdown('**正常** <img src=x onerror=alert(1)> [链接](javascript:alert(1))\n```\n<div>代码</div>\n```');
  const validate = nodes => { for (const node of nodes) {
    assert.ok(['text', undefined].includes(node.type)); assert.ok([undefined, 'div', 'pre', 'strong', 'code'].includes(node.name));
    assert.ok(!node.attrs?.href && !node.attrs?.src); if (node.children) validate(node.children);
  }}; validate(unsafe);
  assert.deepEqual(diffSummary('--- a/a.js\n+++ b/a.js\n-old\n+new\n+next'), {files: [{path: 'a.js', added: 2, removed: 1}], added: 2, removed: 1});


  global.Page = definition => {global.definition = definition;};
  require('../mini_program/pages/codex/codex');
  const {clone} = require('../mini_program/utils/codex/model');
  const session = {url: 'https://power.example.com', client_id: '12345678-1234-1234-1234-123456789012',
    access_token: 'a'.repeat(43), refresh_token: 'b'.repeat(43), access_expires_at: Math.floor(Date.now() / 1000) + 3600};
  const storage = {[CLIENT_KEY]: session}, calls = [], pageSockets = [], root = 'C:\\Fixture\\LanPower';
  let active = null, latestSocket, readDelay, approvals = [];
  const queued = [], threads = [{id:'a',name:'优化小程序布局',cwd:root,control:'remote',model:'m-a',reasoningEffort:'medium',updatedAt:Date.now()/1000,
    turns:[{id:'old',status:'completed',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'检查布局'}]},{id:'answer',type:'agentMessage',phase:'final_answer',text:'**布局检查通过**'}]}]},
    {id:'b',name:'另一段聊天',cwd:root,control:'remote',model:'m-a',turns:[]}];
  global.wx = {getStorageSync:key=>storage[key],setStorageSync:(key,value)=>{storage[key]=value;},removeStorageSync:key=>delete storage[key],
    getAppBaseInfo:()=>({theme:'light'}),setNavigationBarColor:()=>{},getFileSystemManager:()=>({unlink:()=>{}}),
    request:options=>options.success({statusCode:200,data:options.url.endsWith('/devices')?
      [{device_id:'pc-a',device_type:'windows',name:'开发电脑'},{device_id:'pc-b',device_type:'windows',name:'另一台电脑'}]:{}}),
    connectSocket:()=>{
      const socket = new Socket((s,frame)=>{
        if(frame.type!=='rpc')return;
        const {id,method,params}=frame.payload;
        if(!method){approvals=approvals.filter(request=>request.id!==id);setImmediate(()=>s.frame({type:'rpc',payload:{method:'serverRequest/resolved',params:{requestId:id}}}));return;}
        calls.push({method,params});let result={};
        const status={sharedControl:true,desktopControl:true,submissionReceipts:true,queueSupported:true,chatSupported:true,loggedIn:true,projects:[{name:'LanPower',path:root}],pendingApprovals:approvals,activeTurns:active?[{threadId:'a',turnId:active}]:[]};
        if(method==='lanpower/status')result=status;
        if(method==='lanpower/bootstrap')result={status,models:[{id:'m-a',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],planSupported:true,library:{data:threads.map(thread=>({...thread,turns:undefined})),pinned:[],nextCursor:null,revision:0}};
        if(method==='thread/list')result={data:threads.map(thread=>({...thread,turns:undefined})),nextCursor:null};
        if(method==='model/list')result={data:[{id:'m-a',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]};
        if(method==='collaborationMode/list')result={data:[{mode:'plan'}]};
        if(method==='thread/read'){
          result={thread:clone(threads.find(thread=>thread.id===params.threadId))};
          if(readDelay){readDelay(s,{type:'rpc',payload:{id,result}});return;}
        }
        if(method==='thread/queue/list')result={data:queued,nextCursor:null};
        if(method==='turn/start'){active='active';const next={id:active,status:'inProgress',startedAt:Date.now(),items:[{id:'sent-'+id,type:'userMessage',content:params.input}]};threads[0].turns.push(next);result={turn:next};}
        if(method==='thread/queue/add')queued.push({id:params.clientUserMessageId,input:params.input});
        if(method==='turn/steer'){result={turnId:active};threads[0].turns.at(-1).items.push({id:'steer-'+id,type:'userMessage',content:params.input});}
        if(method==='turn/interrupt'){threads[0].turns.at(-1).status='interrupted';active=null;}
        setImmediate(()=>s.frame({type:'rpc',payload:{id,result}}));
      });pageSockets.push(socket);latestSocket=socket;
      setImmediate(()=>{socket.openHandler();socket.frame({type:'state',state:'runtime_ready'});});return socket;
    }};
  let maxPayload=0;
  const makePage=()=>{const value={...global.definition,data:clone(global.definition.data)};value.setData=changes=>{const size=Buffer.byteLength(JSON.stringify(changes));maxPayload=Math.max(size,maxPayload);assert.ok(size<1048576,'native setData exceeds 1 MiB');Object.assign(value.data,changes);};return value;};
  let page=makePage();
  try{
    page.onLoad();page.onShow();await until(()=>page.controller.ready&&!page.controller.recovering&&page.controller.threads.length===2);
    await until(()=>page.data.ready&&page.data.recent.length===2&&page.data.groups.length===1);
    assert.equal(page.data.deviceName,'开发电脑');assert.equal(page.data.homeOrder,'project');assert.equal(page.data.homeMenu,false);
    assert.deepEqual(page.data.recent.map(row=>row.id),['a','b']);assert.equal(page.data.groups[0].threads.length,2);
    assert.equal(calls.filter(call=>call.method==='lanpower/bootstrap').length,1,'首次进入通过一次 bootstrap 恢复首屏，不再串行读取多组列表');
    await page.readThread('a');page.paint();assert.equal(page.data.selectedModel,'m-a');assert.equal(page.data.canControl,true);
    const albumBytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXdwAAAAASUVORK5CYII=','base64')).buffer;
    wx.getFileSystemManager=()=>({unlink:()=>{},readFile:options=>options.success({data:albumBytes})});
    wx.arrayBufferToBase64=value=>Buffer.from(value).toString('base64');
    wx.chooseMedia=options=>{page.onHide();options.success({tempFiles:[{tempFilePath:'/tmp/album.png'}]});};
    await page.addImages();assert.equal(page.controller.draft.images.length,1,'相册切后台返回应保留当前聊天附件');
    page.onShow();await until(()=>page.controller.ready&&!page.controller.recovering);assert.equal(page.controller.draft.images[0].src,'/tmp/album.png');
    page.removeAttachment({currentTarget:{dataset:{kind:'images',index:0}}});
    page.input({detail:{value:'请优化布局'}});await page.send();assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
     await until(()=>!page.controller.syncing);await page.controller.refreshCurrent();page.paint();assert.equal(page.data.canInterrupt,true);assert.equal(page.controller.rows.filter(row=>row.kind==='user'&&row.text==='请优化布局').length,1);
    page.chooseSendMode({currentTarget:{dataset:{mode:'queue'}}});page.input({detail:{value:'结束后检查'}});await page.send();assert.equal(calls.filter(call=>call.method==='thread/queue/add').length,1);assert.equal(page.data.queue.length,1);
    page.chooseSendMode({currentTarget:{dataset:{mode:'steer'}}});page.input({detail:{value:'只改输入栏'}});await page.send();assert.equal(calls.find(call=>call.method==='turn/steer').params.expectedTurnId,'active');assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
    page.input({detail:{value:'A 未发的内容'}});await page.readThread('b');assert.equal(page.controller.draft.text,'');page.input({detail:{value:'B 未发的内容'}});await page.readThread('a');assert.equal(page.controller.draft.text,'A 未发的内容');
    const request={id:'approve',method:'item/fileChange/requestApproval',params:{threadId:'a',turnId:active}};approvals=[request];latestSocket.frame({type:'rpc',payload:request});page.openApproval({currentTarget:{dataset:{key:JSON.stringify('approve')}}});
    await Promise.all([page.decide({currentTarget:{dataset:{allow:'yes'}}}),page.decide({currentTarget:{dataset:{allow:'yes'}}})]);page.paint();assert.equal(latestSocket.frames.filter(frame=>frame.payload?.id==='approve'&&frame.payload?.result).length,1);assert.equal(page.data.sheet,'');
    await page.interrupt();page.paint();assert.equal(page.data.running,false);
    page.changeTheme({currentTarget:{dataset:{value:'dark'}}});assert.equal(page.data.theme,'dark');assert.equal(storage.lanpower_codex_theme_v1,'dark');
    const full='长中文🎨'.repeat(60000);page.controller.current.turns.push({id:'huge',status:'completed',items:[{id:'huge-ai',type:'agentMessage',text:full,phase:'final_answer'}]});page.paint();assert.equal(page.controller.rows.at(-1).text,full);assert.ok(page.data.messages.some(row=>row.hasMoreText));page.openDetail({currentTarget:{dataset:{key:'huge:huge-ai'}}});assert.equal(page.detailText,full);assert.ok(page.data.detailPages>1);
    const starts=calls.filter(call=>call.method==='turn/start').length, originalController=page.controller;
    let auxiliary;wx.navigateTo=options=>{auxiliary=options.url;};
    page.setData({view:'chat'});page.navigate({currentTarget:{dataset:{page:'help'}}});
    assert.equal(auxiliary,'/pages/help/help?computer=pc-a');assert.equal(page.controller,originalController);assert.equal(page.controller.threadId,'a');
    page.controller.notify('等待返回刷新');
    page.onHide();assert.equal(page.connection.opened,true,'短暂切后台保留连接，返回时恢复原窗口状态');assert.equal(page.controller.draft.text,'A 未发的内容');
    threads[0].name='返回后自动更新的聊天';page.onShow();await until(()=>page.controller.ready&&!page.controller.recovering);
    await until(()=>page.data.ready&&page.data.title===threads[0].name&&page.data.recent.some(row=>row.name===threads[0].name));
    page.input({detail:{value:'返回后继续编辑草稿'}});await until(()=>page.data.prompt==='返回后继续编辑草稿');
    page.input({detail:{value:'A 未发的内容'}});
    assert.equal(calls.filter(call=>call.method==='turn/start').length,starts);assert.equal(page.data.view,'chat');assert.equal(page.controller.threadId,'a');
    let stale;readDelay=(s,frame)=>{stale=()=>s.frame(frame);};const oldRead=page.controller.refreshCurrent();await until(()=>stale);
    page.chooseDevice(page.data.devices[1]);stale();await oldRead;readDelay=null;assert.equal(page.controller.current,null);assert.equal(page.data.messages.length,0);
    const {saveDeviceSelection,selectedDevice}=require('../mini_program/utils/device-selection');
    assert.equal(selectedDevice(wx,page.client),'pc-b');page.onHide();saveDeviceSelection(wx,page.client,page.data.devices,'pc-a');page.onShow();await until(()=>page.controller.deviceId==='pc-a'&&page.controller.ready&&!page.controller.recovering);
    assert.equal(page.data.deviceName,'开发电脑');assert.equal(page.controller.current.id,'a','返回同一台电脑可先恢复本机快照');await page.readThread('a');assert.equal(page.controller.draft.text,'A 未发的内容');assert.equal(calls.filter(call=>call.method==='turn/start').length,starts);
    assert.equal(Object.keys(storage).filter(key=>/thread|prompt|approval|history/.test(key)).length,0);assert.ok(maxPayload<1048576);
    const retainedController=page.controller, socketCount=pageSockets.length, bootstrapCount=calls.filter(call=>call.method==='lanpower/bootstrap').length;
    page.onUnload();assert.equal(retainedController.ready,true,'返回设备首页卸载页面时仍保留短期 Cloud 会话');
    page=makePage();page.onLoad({computer:'pc-a'});assert.equal(page.controller,retainedController);assert.equal(page.data.view,'chat');assert.equal(page.controller.current.id,'a');assert.equal(page.controller.canControl,false,'重新进入先确认完整状态');
    page.onShow();await until(()=>page.controller.canControl&&page.data.deviceName==='开发电脑');
    assert.equal(pageSockets.length,socketCount,'重新进入同一电脑复用原连接');assert.equal(calls.filter(call=>call.method==='lanpower/bootstrap').length,bootstrapCount);assert.equal(calls.filter(call=>call.method==='turn/start').length,starts);
  }finally{page.onUnload();require('../mini_program/utils/codex/session-cache').discardRetainedSession();}
  console.log('小程序原生页面与传输：首次列表自动显示、返回后自动刷新、授权、回执、草稿、队列/引导/停止、单次审批、长内容、后台恢复及电脑隔离检查通过');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
