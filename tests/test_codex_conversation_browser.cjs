// Browser acceptance uses isolated RPC fixtures; it never submits a real desktop task.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password = fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const output = process.env.LANPOWER_UI_OUTPUT || path.resolve(__dirname,'../private/codex-process-fold-1.18.3/browser'); fs.mkdirSync(output,{recursive:true});
  const image = process.env.LANPOWER_CONVERSATION_FIXTURE_IMAGE ? fs.readFileSync(process.env.LANPOWER_CONVERSATION_FIXTURE_IMAGE) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=','base64');
  const browser = await chromium.launch({headless:true}), context = await browser.newContext({viewport:{width:1440,height:900}});
  const calls = [], errors = [], startedAt = Date.now()-18000;
  let active = true;
  const command = (id,exitCode=0) => ({id,type:'commandExecution',command:'Get-ChildItem -LiteralPath "D:/Projects/Demo"',cwd:'D:/Projects/Demo',status:'completed',aggregatedOutput:'README.md\nsrc\n完整输出末尾',exitCode});
  const turn = {id:'native-turn',status:'inProgress',startedAt,items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'# Files mentioned by the user:\n\n## native-one.png: D:/Images/native-one.png\nImage attachment: true\n\n## native-two.png: D:/Images/native-two.png\nImage attachment: true\n\n## My request:\n请参照这两张图，完善会话窗口的展示。'},{type:'localImage',path:'D:/Images/native-one.png'},{type:'localImage',path:'D:/Images/native-two.png'}]},
    {id:'answer',type:'agentMessage',phase:'commentary',text:'我会对照原生窗口，检查思考状态、图片和命令的展示。'},
    command('cmd-one'),command('cmd-two',2),
    {id:'file-one',type:'fileChange',status:'completed',changes:[{path:'README.md',kind:{type:'update'},diff:'@@ -1 +1 @@\n-old fixture\n+new fixture'}]},
    command('cmd-three'),
    {id:'reason-one',type:'reasoning',summary:['正在检查会话展示。']},
    ...Array.from({length:4},(_,index)=>({id:`view-${index}`,type:'imageView',path:`D:/Projects/Demo/image-${index}.png`})),
  ]};
  const assertLayout = async page => {
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.thread-composer-shell');
      const footer = document.querySelector('.thread-composer-controls');
      const hiddenInputs = [...document.querySelectorAll('.thread-composer-hidden-input')];
      const command = document.querySelector('.native-command-toggle');
      const icon = document.querySelector('.native-command-icon');
      return {
        radius: parseFloat(getComputedStyle(shell).borderTopLeftRadius),
        footerDisplay: getComputedStyle(footer).display,
        inputCount: hiddenInputs.length,
        hiddenInputs: hiddenInputs.every(input => getComputedStyle(input).display === 'none'),
        icons: [...shell.querySelectorAll('svg')].map(svg => ({width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height})),
        commandDisplay: command && getComputedStyle(command).display,
        commandIcon: icon && {width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height},
      };
    });
    assert.ok(layout.radius >= 12, 'composer must retain its rounded input shell');
    assert.equal(layout.footerDisplay, 'flex', 'composer controls must retain their horizontal layout');
    assert.ok(layout.inputCount >= 3 && layout.hiddenInputs, 'native file inputs must stay hidden');
    assert.ok(layout.icons.every(icon => icon.width <= 24 && icon.height <= 24), 'composer icons must not expand to browser defaults');
    if (layout.commandDisplay) {
      assert.equal(layout.commandDisplay, 'flex', 'command icon, label and arrow must share a row');
      assert.ok(layout.commandIcon.width <= 20 && layout.commandIcon.height <= 20, 'command icons must stay compact');
    }
  };
  const thread = id => ({id,name:id==='native-chat'?'会话展示验收':'另一条工作会话',cwd:'D:/Projects/Demo',createdAt:1700000000,updatedAt:1700000100,control:'shared',status:{type:'active'},turns:id==='native-chat'?[{...turn,status:active?'inProgress':'completed'}]:[{id:'other-turn',status:'inProgress',items:[{id:'other-user',type:'userMessage',content:[{type:'text',text:'另一条任务'}]}]}]});
  const rpc = request => {
    calls.push(request); const p = request.params || {};
    switch (request.method) {
      case 'lanpower/status': return {projects:[{name:'Demo',path:'D:/Projects/Demo'}],desktopControl:true,sharedControl:true,queueSupported:true,activeTurns:[...(active?[{threadId:'native-chat',turnId:'native-turn'}]:[]),{threadId:'other-chat',turnId:'other-turn'}],pendingApprovals:[]};
      case 'model/list': return {data:[{id:'gpt-6',isDefault:true}]};
      case 'thread/list': return {data:['native-chat','other-chat'].map(thread),nextCursor:null};
      case 'thread/read': return {thread:thread(p.threadId)};
      case 'thread/queue/list': return {data:[]};
      case 'lanpower/image/read': return {contentType:'image/png',base64:image.toString('base64'),size:image.length};
      default: return {};
    }
  };
  try {
    if (process.env.LANPOWER_UI_STATIC) await context.route('**/static/codex-ui/**', async route => {
      const root = path.resolve(process.env.LANPOWER_UI_STATIC);
      const relative = new URL(route.request().url()).pathname.split('/static/codex-ui/')[1];
      const file = path.resolve(root, relative);
      assert.ok(file.startsWith(root + path.sep));
      await route.fulfill({path: file, contentType: relative.endsWith('.css') ? 'text/css' : 'application/javascript'});
    });
    await context.exposeBinding('__conversationRpc',(_,request)=>rpc(request));
    await context.addInitScript(() => {
      window.WebSocket=class {
        static OPEN=1;readyState=1;
        constructor(){window.__fixtureSocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}
        frame(value){this.onmessage?.({data:JSON.stringify(value)});}
        async send(raw){const frame=JSON.parse(raw);if(frame.type!=='rpc')return;const request=frame.payload,result=await window.__conversationRpc(request);this.frame({type:'rpc',payload:{id:request.id,result}});}
        close(){this.readyState=3;setTimeout(()=>this.onclose?.({code:1000}),0);}
      };
    });
    const page=await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
    const emit = payload => page.evaluate(value=>window.__fixtureSocket.frame({type:'rpc',payload:value}),payload);
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('[data-thread-id="native-chat"] .lp-thread-title').click();
    await page.getByRole('status').filter({hasText:'正在思考'}).waitFor();
    const assertTimingAtStart = async () => {
      assert.equal(await page.locator('.thread-work-elapsed').count(),1);
      assert.ok(await page.evaluate(()=>{
        const user=document.querySelector('.conversation-item[data-message-id="user"]'), timer=document.querySelector('.thread-work-elapsed'), process=document.querySelector('.conversation-item[data-message-id="answer"]');
        return !!(user.compareDocumentPosition(timer)&Node.DOCUMENT_POSITION_FOLLOWING) && !!(timer.compareDocumentPosition(process)&Node.DOCUMENT_POSITION_FOLLOWING);
      }),'live timing must follow the user prompt and precede all commentary and tools');
      assert.equal(await page.locator('.conversation-item-overlay .thread-work-elapsed').count(),0,'live timing is separate from the trailing status');
    };
    await assertTimingAtStart();
    assert.equal(await page.locator('.native-activity-toggle').count(),1);
    assert.equal(await page.locator('.native-command-toggle').count(),0,'the whole activity sequence starts collapsed');
    assert.ok((await page.locator('.native-activity-toggle').textContent()).includes('含失败命令'));
    assert.ok((await page.locator('.native-activity-toggle').textContent()).includes('编辑了文件，运行了命令'));
    await page.locator('.native-activity-toggle').click();
    assert.equal(await page.locator('.native-command-toggle').count(),3);
    await assertLayout(page);
    assert.equal(await page.locator('.command-activity').count(),0,'commands must not disappear inside aggregate cards');
    assert.equal(await page.locator('.native-command-output').count(),0,'collapsed commands avoid mounting full output');
    assert.equal(await page.getByRole('button',{name:'命令运行失败',exact:true}).count(),1);
    await page.locator('.native-command-toggle').first().click();
    await page.locator('.file-change-summary-row').click();
    await page.locator('.file-change-path-button').first().click();
    await page.locator('.diff-viewer-shell').waitFor();
    assert.ok((await page.locator('.diff-viewer-shell').textContent()).includes('new fixture'));
    await page.getByRole('button',{name:'Close diff viewer',exact:true}).click();
    assert.equal(await page.locator('.diff-viewer-shell').count(),0);
    assert.ok((await page.locator('.native-command-details').first().textContent()).includes('完整输出末尾'));
    assert.ok((await page.locator('.native-command-details').first().textContent()).includes('D:/Projects/Demo'));
    await page.locator('.native-command-toggle').first().click();
    await page.locator('.native-activity-toggle').click();
    assert.equal(await page.locator('.native-command-toggle').count(),0,'the whole command sequence can be collapsed again');
    await page.locator('.native-activity-toggle').click();
    const before = await page.locator('.thread-work-elapsed').textContent();
    await page.waitForFunction(old=>document.querySelector('.thread-work-elapsed')?.textContent!==old,before);
    assert.ok(!(await page.locator('.conversation-root').textContent()).includes('Files mentioned by the user'));
    assert.equal(await page.locator('.message-file-chip').count(),0,'image metadata must not be duplicated as file chips');
    await page.waitForFunction(()=>[...document.querySelectorAll('.lp-image-thumbnail img')].every(img=>img.naturalWidth>0));
    assert.equal(await page.locator('.lp-image-thumbnail').count(),2);
    assert.equal(await page.locator('.native-image-toggle').count(),4,'running turn shows all viewed-image records');
    await page.locator('.lp-image-thumbnail').first().click();await page.locator('.image-modal-image').waitFor();
    await page.keyboard.press('Escape');assert.equal(await page.locator('.image-modal-image').count(),0);
    await page.locator('.lp-image-thumbnail').first().evaluate(el=>el.blur());
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:900});await page.mouse.move(0,0);
      const sizes = await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,thumbs:[...document.querySelectorAll('.lp-image-thumbnail')].map(img=>({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height})),composer:document.querySelector('.thread-composer').getBoundingClientRect().bottom}));
      assert.ok(sizes.scroll<=sizes.width+1,'horizontal overflow at '+width);
      assert.ok(sizes.composer<=901,'composer remains visible');
      assert.ok(sizes.thumbs.every(thumb=>thumb.width<=104 && thumb.width===thumb.height),'small square thumbnails at '+width);
      await assertLayout(page);
      await page.screenshot({path:path.join(output,'conversation-light-'+width+'.png'),fullPage:true,animations:'disabled'});
      await page.evaluate(()=>document.documentElement.classList.add('dark'));
      await assertLayout(page);
      await page.screenshot({path:path.join(output,'conversation-dark-'+width+'.png'),fullPage:true,animations:'disabled'});
      await page.evaluate(()=>document.documentElement.classList.remove('dark'));
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.is-working').evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await emit({method:'item/started',params:{threadId:'native-chat',turnId:'native-turn',item:{id:'cmd-running',type:'commandExecution',command:'fixture-running',status:'inProgress',aggregatedOutput:'',exitCode:null}}});
    await page.getByRole('button',{name:'正在运行命令',exact:true}).last().waitFor();
    await page.getByRole('status').filter({hasText:'正在运行命令'}).waitFor();
    await emit({method:'item/completed',params:{threadId:'native-chat',turnId:'native-turn',item:{...command('cmd-running'),status:'completed'}}});
    await emit({method:'item/reasoning/summaryTextDelta',params:{threadId:'native-chat',turnId:'native-turn',itemId:'reason-one',summaryIndex:0,delta:'正在确认响应式布局。'}});
    await page.locator('.thread-work-reasoning summary').click();
    assert.ok((await page.locator('.thread-work-summary').textContent()).includes('正在检查会话展示。正在确认响应式布局。'));
    await emit({id:'approval-fixture',method:'item/tool/requestUserInput',params:{threadId:'native-chat',turnId:'native-turn',questions:[{id:'choice',header:'选择',question:'选择颜色',options:[{label:'浅色',description:'使用浅色'}]}]}});
    await page.getByRole('status').filter({hasText:'等待你的回复'}).waitFor();
    assert.equal(await page.locator('.is-working').count(),0,'approval waits must not look like active thinking');
    await emit({method:'serverRequest/resolved',params:{threadId:'native-chat',requestId:'approval-fixture'}});
    await page.getByRole('status').filter({hasText:'正在思考'}).waitFor();
    await page.setViewportSize({width:1440,height:900});
    await page.locator('[data-thread-id="other-chat"] .lp-thread-title').click();
    await page.waitForFunction(()=>document.querySelector('.lp-chat-header h1')?.textContent==='另一条工作会话');
    assert.equal(await page.locator('.thread-work-elapsed').count(),0,'missing native start time must not use another thread clock');
    assert.equal(await page.locator('.thread-work-summary').count(),0,'reasoning stays within its conversation');
    await page.locator('[data-thread-id="native-chat"] .lp-thread-title').click();
    await page.getByRole('status').filter({hasText:'正在思考'}).waitFor();
    await assertTimingAtStart();
    await page.evaluate(()=>window.__fixtureSocket.onclose({code:1006}));
    await page.waitForFunction(()=>!document.querySelector('.is-working'));
    assert.ok(!(await page.locator('.lp-chat-status').textContent()).includes('已同步'));
    await page.waitForFunction(()=>document.querySelector('.lp-connection')?.textContent.includes('已连接'));
    await page.getByRole('status').filter({hasText:'正在思考'}).waitFor();
    active=false;turn.completedAt=Date.now();
    const final = {id:'final-answer',type:'agentMessage',phase:'final_answer',text:'已完成会话展示优化。最终结果保持可见。'};
    turn.items.push(final);
    await emit({method:'item/completed',params:{threadId:'native-chat',turnId:'native-turn',item:final}});
    await emit({method:'turn/completed',params:{threadId:'native-chat',turn:{id:'native-turn',status:'completed',completedAt:turn.completedAt}}});
    await page.waitForFunction(()=>!document.querySelector('.is-working'));
    await page.locator('.turn-process-toggle').waitFor();
    assert.equal(await page.locator('.thread-work-elapsed').count(),0,'completed turn replaces live timing with the process header');
    assert.ok((await page.locator('.worked-separator-text').textContent()).includes('用时'));
    assert.equal(await page.locator('.turn-process-toggle').getAttribute('aria-expanded'),'false');
    assert.ok((await page.locator('.conversation-root').textContent()).includes(final.text));
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    await page.getByRole('button',{name:'Copy response',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),final.text,'copy final answer without hidden commentary or tools');
    assert.ok(!(await page.locator('.conversation-root').textContent()).includes('我会对照原生窗口'));
    assert.equal(await page.locator('.native-activity-toggle').count(),0,'finished turn hides every intermediate activity');
    assert.equal(await page.locator('.native-image-toggle').count(),0,'viewed images belong inside the completed process');
    // A reconciliation refresh must preserve the completed projection.
    await emit({method:'thread/status/changed',params:{threadId:'native-chat',status:{type:'idle'}}});
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.turn-process-toggle').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('.native-image-toggle').count(),0,'refresh keeps viewed images folded with the process');
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:900});await page.mouse.move(0,0);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
      await assertLayout(page);
      await page.screenshot({path:path.join(output,'completed-light-'+width+'.png'),fullPage:true,animations:'disabled'});
      await page.evaluate(()=>document.documentElement.classList.add('dark'));
      await assertLayout(page);
      await page.screenshot({path:path.join(output,'completed-dark-'+width+'.png'),fullPage:true,animations:'disabled'});
      await page.evaluate(()=>document.documentElement.classList.remove('dark'));
    }
    await page.setViewportSize({width:1440,height:900});
    await page.locator('.turn-process-toggle').click();
    assert.equal(await page.locator('.turn-process-toggle').getAttribute('aria-expanded'),'true');
    assert.ok((await page.locator('.conversation-root').textContent()).includes('我会对照原生窗口'));
    assert.equal(await page.locator('.native-activity-toggle').count(),1);
    assert.equal(await page.locator('.native-image-toggle').count(),4,'expanding the process restores all viewed images');
    await page.locator('.native-image-toggle').first().click();await page.locator('.native-image-previews img').waitFor();
    const preview=page.locator('.native-image-previews .lp-remote-image');const bounds=await preview.boundingBox();assert.ok(bounds.width<=141&&bounds.height<=141);
    await preview.click();await page.locator('.image-modal-image').waitFor();await page.keyboard.press('Escape');
    if (await page.locator('.native-activity-toggle').getAttribute('aria-expanded')==='false') await page.locator('.native-activity-toggle').click();
    await page.locator('.native-command-toggle').first().click();
    assert.ok((await page.locator('.native-command-details').textContent()).includes('完整输出末尾'));
    await page.locator('.turn-process-toggle').click();
    assert.equal(await page.locator('.native-command-output').count(),0);
    assert.ok((await page.locator('.conversation-root').textContent()).includes(final.text));
    assert.equal(calls.filter(call=>call.method==='turn/start').length,0,'presentation and reconnect must never submit a task');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({composerLayout:true,hiddenFileInputs:true,compactCommandIcons:true,activityGroupCollapse:true,individualCommands:true,fullCommandDetails:true,completedTurnCollapse:true,expandFullProcess:true,refreshPreservesCollapse:true,thinkingAnimation:true,elapsedTimer:true,elapsedBeforeProcess:true,approvalWait:true,compactImages:true,imageModal:true,cleanUserText:true,threadIsolation:true,reconnectNoResend:true,completedDuration:true,reducedMotion:true,widths:[1440,390,320],lightAndDark:true,browserErrors:0}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
