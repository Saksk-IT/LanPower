// Native-shaped fixtures; opening details must never submit a real Codex task.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const base=process.env.LANPOWER_DEV_URL || 'http://localhost:8080';
  const password=fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const output=process.env.LANPOWER_UI_OUTPUT || path.resolve(__dirname,'../private/codex-file-changes/browser');fs.mkdirSync(output,{recursive:true});
  const calls=[],errors=[],changes=[
    {path:'src/'+ 'very-long-public-directory/'.repeat(5)+'edited.js',kind:{type:'update'},diff:'@@ -4,2 +4,3 @@\n-old fixture\n+new fixture\n same\n+last fixture'},
    {path:'added.js',kind:{type:'add'},diff:'const newFile = true;\nconst last = 2;\n'},
    {path:'deleted.js',kind:{type:'delete'},diff:'deleted contents\n'},
    {path:'old.js',kind:{type:'update',move_path:'new.js'},diff:''},
  ];
  const turn={id:'turn',status:'inProgress',items:[
    {id:'u',type:'userMessage',content:[{type:'text',text:'检查文件改动及思考过程的展示'}]},
    {id:'reason',type:'reasoning',summary:['公开思考摘要，展开后可完整阅读。']},
    {id:'cmd',type:'commandExecution',status:'completed',command:'verify public fixture',exitCode:0,aggregatedOutput:'verified'},
    {id:'files',type:'fileChange',status:'completed',changes},
    {id:'comment',type:'agentMessage',phase:'commentary',text:'说明保持原始位置。'},
    {id:'files2',type:'fileChange',status:'completed',changes:[{path:'second.js',kind:{type:'update'},diff:'@@ -1 +1 @@\n-second old\n+second new'}]},
  ]};
  const thread=()=>({id:'chat',name:'文件改动与思考过程',cwd:'D:/Fixture/Project',control:'shared',model:'gpt-6',turns:[turn]});
  const rpc=request=>{calls.push(request);switch(request.method){
    case 'lanpower/status':return {projects:[{name:'Project',path:'D:/Fixture/Project'}],desktopControl:true,sharedControl:true,queueSupported:true,activeTurns:[{threadId:'chat',turnId:'turn'}],pendingApprovals:[]};
    case 'model/list':return {data:[{id:'gpt-6',isDefault:true}]};case 'thread/list':return {data:[thread()],nextCursor:null};
    case 'thread/read':return {thread:thread()};case 'thread/queue/list':return {data:[]};default:return {};
  }};
  const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:900}});
  try{
    if(process.env.LANPOWER_UI_STATIC)await context.route('**/static/codex-ui/**',async route=>{
      const root=path.resolve(process.env.LANPOWER_UI_STATIC),relative=new URL(route.request().url()).pathname.split('/static/codex-ui/')[1],file=path.resolve(root,relative);
      assert.ok(file.startsWith(root+path.sep));await route.fulfill({path:file,contentType:relative.endsWith('.css')?'text/css':'application/javascript'});
    });
    await context.exposeBinding('__fileRpc',(_,request)=>rpc(request));
    await context.addInitScript(()=>{window.WebSocket=class{static OPEN=1;readyState=1;constructor(){setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}frame(value){this.onmessage?.({data:JSON.stringify(value)});}async send(raw){const frame=JSON.parse(raw);if(frame.type==='rpc')this.frame({type:'rpc',payload:{id:frame.payload.id,result:await window.__fileRpc(frame.payload)}});}close(){this.readyState=3;}};});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('[data-thread-id="chat"] .lp-thread-title').click();
    const groups=page.locator('.native-activity-toggle');await groups.first().waitFor();
    for(let index=0;index<await groups.count();index++)await groups.nth(index).click();
    const rows=page.locator('.file-change-summary-row');assert.equal(await rows.count(),2);
    assert.equal(await page.locator('.file-change-list').count(),0,'收起时不渲染完整文件列表');
    assert.equal(await rows.first().locator('.file-change-summary-label').textContent(),'已更改 4 个文件');
    assert.equal(await rows.first().locator('.file-change-summary-kinds').textContent(),'1 修改，1 新增，1 删除，1 移动');
    assert.equal(await rows.first().locator('.file-change-summary-status').textContent(),'+4-2');
    const thought=page.locator('[data-message-id="reason"] .thread-work-reasoning');assert.equal(await thought.locator('.thread-work-icon').count(),1);
    assert.ok((await thought.locator('summary').textContent()).includes('思考过程'));
    await thought.locator('summary').click();assert.ok((await thought.textContent()).includes('公开思考摘要'));
    assert.equal(await thought.locator('.thread-work-icon').evaluate(element=>getComputedStyle(element).transform),'none','展开只旋转箭头');
    for(const width of [1440,390,320])for(const dark of [false,true]){
      await page.setViewportSize({width,height:900});await page.evaluate(value=>document.documentElement.classList.toggle('dark',value),dark);
      const styles=await rows.first().evaluate(element=>{const style=getComputedStyle(element),command=getComputedStyle(document.querySelector('.native-command-toggle'));return {background:style.backgroundColor,border:style.borderTopWidth,font:style.fontSize,commandFont:command.fontSize,overflow:document.documentElement.scrollWidth>innerWidth+1};});
      assert.equal(styles.background,'rgba(0, 0, 0, 0)');assert.equal(styles.border,'0px');assert.equal(styles.font,styles.commandFont);assert.equal(styles.overflow,false);
      await rows.first().click();assert.equal(await page.locator('.file-change-item').count(),4);
      await page.locator('.file-change-list .file-change-path-button[title="added.js"]').click();
      await page.locator('.diff-viewer-shell').waitFor();assert.ok((await page.locator('.diff-viewer-shell').textContent()).includes('const newFile = true;'));
      assert.ok(!(await page.locator('.diff-viewer-line-code').allTextContents()).join('\n').includes('new fixture'),'详情只显示所选文件');
      await page.screenshot({path:path.join(output,`file-detail-${width}-${dark?'dark':'light'}.png`),fullPage:true});
      await page.getByRole('button',{name:'Close diff viewer',exact:true}).click();
      await rows.first().click();await page.screenshot({path:path.join(output,`file-rows-${width}-${dark?'dark':'light'}.png`),fullPage:true});
    }
    await rows.nth(1).click();await page.locator('.file-change-list .file-change-path-button').click();
    assert.ok((await page.locator('.diff-viewer-shell').textContent()).includes('second new'));
    await page.getByRole('button',{name:'Close diff viewer',exact:true}).click();
    const reasoning=id=>({id,type:'reasoning',summary:['公开思考内容 '+id],content:['private-reasoning']});
    const command=id=>({id,type:'commandExecution',status:'completed',exitCode:id==='failed'?1:0,command:'verify fixture',aggregatedOutput:'full output'});
    turn.items=[turn.items[0],command('one'),reasoning('r1'),reasoning('r2'),{id:'files',type:'fileChange',status:'completed',changes},reasoning('r3'),command('failed'),reasoning('r4'),reasoning('r5')];
    await page.setViewportSize({width:1440,height:900});
    await page.reload();await page.locator('[data-thread-id="chat"] .lp-thread-title').click();
    const drawer=page.locator('.native-activity-toggle');await drawer.waitFor();assert.equal(await drawer.count(),1);
    assert.equal(await page.locator('.thread-work-reasoning').count(),0);assert.ok((await drawer.textContent()).includes('含失败命令'));
    await drawer.click();assert.equal(await page.locator('.thread-work-reasoning').count(),5);
    assert.equal(await page.locator('.thread-work-icon').count(),5);
    await page.locator('.thread-work-reasoning summary').nth(2).click();
    assert.equal(await page.locator('.thread-work-reasoning[open]').count(),1);assert.ok((await page.locator('.thread-work-reasoning[open]').textContent()).includes('公开思考内容 r3'));
    await page.screenshot({path:path.join(output,'one-work-drawer-with-nested-reasoning.png'),fullPage:true});
    await drawer.click();assert.equal(await page.locator('.thread-work-reasoning').count(),0);
    assert.equal(calls.filter(call=>['turn/start','thread/resume','turn/interrupt','thread/undo','thread/redo'].includes(call.method)).length,0);
    assert.deepEqual(errors,[]);console.log('文件与思考：1440/390/320px 浅深色、透明折叠行、类型/增删统计、逐文件详情和独立图标通过；真实任务发送 0');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
