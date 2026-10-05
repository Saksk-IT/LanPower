// Isolated native-shaped web activity fixtures. No actual Codex task is submitted.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'http://localhost:8080';
  const password = fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const output = process.env.LANPOWER_UI_OUTPUT || path.resolve(__dirname,'../private/codex-web-search-1.24.1/browser'); fs.mkdirSync(output,{recursive:true});
  const calls = [], errors = [], command = id => ({id,type:'commandExecution',command:'verify public-fixture',status:'completed',exitCode:0,aggregatedOutput:'完整输出末尾'});
  let active = true;
  const search = {id:'web',type:'webSearch',status:'inProgress',action:{type:'search',queries:['公开网页查询与本地开发问题 '.repeat(12),'site:example.com/docs']},encryptedContent:'private-web-fixture'};
  const open = {id:'open',type:'webSearch',action:{type:'openPage',url:'https://example.com/docs/network/very-long-public-page'}};
  const turn = {id:'turn',status:'inProgress',startedAt:Date.now()-30000,items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'对照原生界面检查搜索与命令记录'}]},
    command('c0'),command('c1'),search,...Array.from({length:12},(_,i)=>command('c'+(i+2))),open,
    {id:'comment',type:'agentMessage',phase:'commentary',text:'活动列表中的网页与命令保持原始顺序。'},
  ]};
  const thread = () => ({id:'chat',name:'网页活动展示',cwd:'D:/Fixture/Project',control:'shared',model:'gpt-6',turns:[turn]});
  const rpc = request => { calls.push(request); switch(request.method) {
    case 'lanpower/status': return {projects:[{name:'Project',path:'D:/Fixture/Project'}],desktopControl:true,sharedControl:true,queueSupported:true,activeTurns:active?[{threadId:'chat',turnId:'turn'}]:[],pendingApprovals:[]};
    case 'model/list': return {data:[{id:'gpt-6',isDefault:true}]};
    case 'thread/list': return {data:[thread()],nextCursor:null};
    case 'thread/read': return {thread:thread()};
    case 'thread/queue/list': return {data:[]};
    default: return {};
  }};
  const browser = await chromium.launch({headless:true}), context = await browser.newContext({viewport:{width:1440,height:900}});
  try {
    if (process.env.LANPOWER_UI_STATIC) await context.route('**/static/codex-ui/**',async route => {
      const root = path.resolve(process.env.LANPOWER_UI_STATIC), relative = new URL(route.request().url()).pathname.split('/static/codex-ui/')[1], file = path.resolve(root,relative);
      assert.ok(file.startsWith(root+path.sep)); await route.fulfill({path:file,contentType:relative.endsWith('.css')?'text/css':'application/javascript'});
    });
    await context.exposeBinding('__webRpc',(_,request)=>rpc(request));
    await context.addInitScript(()=>{window.WebSocket=class {static OPEN=1;readyState=1;constructor(){window.__webSocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}frame(value){this.onmessage?.({data:JSON.stringify(value)});}async send(raw){const frame=JSON.parse(raw);if(frame.type==='rpc')this.frame({type:'rpc',payload:{id:frame.payload.id,result:await window.__webRpc(frame.payload)}});}close(){this.readyState=3;}};});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const emit = event => page.evaluate(value=>window.__webSocket.frame({type:'rpc',payload:value}),event);
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('[data-thread-id="chat"] .lp-thread-title').click();
    const group=page.locator('.native-activity-toggle');await group.waitFor();
    assert.equal(await group.count(),1);assert.ok((await group.textContent()).includes('运行了命令，正在搜索网页'));assert.equal(await page.locator('.native-web-search').count(),0);
    await group.click(); assert.equal(await page.locator('.native-web-search').count(),2);assert.equal(await page.locator('.lp-native-tool[data-tool-kind="网页搜索"]').count(),0);
    assert.equal(await page.locator('[data-message-id="open"] .native-web-search').getAttribute('data-status'),'completed');
    const running=page.locator('[data-message-id="web"] .native-web-search');assert.equal(await running.getAttribute('data-status'),'inProgress');
    search.status='completed';await emit({method:'item/completed',params:{threadId:'chat',turnId:'turn',item:search}});
    await page.waitForFunction(()=>document.querySelector('[data-message-id="web"] .native-web-search')?.dataset.status==='completed');
    assert.ok((await group.textContent()).includes('运行了命令，已搜索网页'));
    await emit({method:'thread/status/changed',params:{threadId:'chat',status:{type:'active'}}});await page.waitForTimeout(650);
    assert.equal(await group.getAttribute('aria-expanded'),'true');assert.equal(await running.getAttribute('data-status'),'completed');
    for (const width of [1440,390,320]) for (const dark of [false,true]) {
      await page.setViewportSize({width,height:900});await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
      await group.scrollIntoViewIfNeeded();
      const layout=await page.evaluate(()=>{const list=document.querySelector('.native-activity-block.is-expanded .conversation-block-list'),label=document.querySelector('.native-web-search-label'),style=getComputedStyle(label);return {height:list.clientHeight,scrollHeight:list.scrollHeight,overflow:getComputedStyle(list).overflowY,ellipsis:style.textOverflow,nowrap:style.whiteSpace,long:label.scrollWidth>label.clientWidth,viewportOverflow:document.documentElement.scrollWidth>innerWidth+1};});
      assert.ok(layout.height<=300&&layout.scrollHeight>layout.height);assert.equal(layout.overflow,'auto');assert.equal(layout.ellipsis,'ellipsis');assert.equal(layout.nowrap,'nowrap');assert.equal(layout.long,true);assert.equal(layout.viewportOverflow,false);
      const main=await page.locator('.conversation-list').evaluate(element=>element.scrollTop);
      await page.locator('.conversation-block-list').first().evaluate(element=>element.scrollTop=element.scrollHeight);
      assert.equal(await page.locator('.conversation-list').evaluate(element=>element.scrollTop),main,'内部滚动不移动整个会话');
      await page.locator('.conversation-block-list').first().evaluate(element=>element.scrollTop=0);
      await page.screenshot({path:path.join(output,`web-search-${width}-${dark?'dark':'light'}.png`),fullPage:true});
    }
    await running.locator('button').click(); assert.ok((await running.locator('pre').textContent()).includes('site:example.com/docs'));assert.ok(!(await page.locator('.conversation-root').textContent()).includes('private-web-fixture'));
    active=false;turn.status='completed';turn.durationMs=31000;const final={id:'final',type:'agentMessage',phase:'final_answer',text:'网页与命令展示检查完成。'};turn.items.push(final);
    await emit({method:'item/completed',params:{threadId:'chat',turnId:'turn',item:final}});await emit({method:'turn/completed',params:{threadId:'chat',turn}});
    await page.locator('.turn-process-toggle').waitFor();assert.equal(await page.locator('.native-activity-toggle').count(),0);
    await page.locator('.turn-process-toggle').click();assert.equal(await group.getAttribute('aria-expanded'),'true');assert.equal(await running.getAttribute('data-status'),'completed');
    assert.equal(calls.filter(call=>['turn/start','thread/resume','turn/interrupt'].includes(call.method)).length,0);assert.deepEqual(errors,[]);
    console.log('网页搜索：1440/390/320px 浅深色、混合活动组、内部滚动、完整详情、开始/完成与刷新、整轮折叠通过；真实任务发送 0');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
