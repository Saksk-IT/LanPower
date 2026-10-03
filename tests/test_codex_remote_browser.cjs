// Browser checks for the reused Vue conversation/composer against local HTTPS.
// RPC fixtures are separate from the real original-window verification.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password = fs.readFileSync(process.env.LANPOWER_DEV_LOGIN_FILE || path.resolve(__dirname, '../deploy/docker/private/dev-login.txt'), 'utf8').match(/^Password: (.+)$/m)[1].trim();
  const output = path.resolve(__dirname, '../private/codex-remote-1.14/browser'); fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext(), page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/login');
    await page.locator('[name=username]').fill('admin'); await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'), page.locator('form[action="/login"] button').click()]);
    await page.addInitScript(() => {
      const calls = window.__fixtureCalls = [];
      let active = true, pending = true, sequence = 0;
      let queue = [{id:'queue-one',input:[{type:'text',text:'原生队列消息一'}]},{id:'queue-two',input:[{type:'text',text:'原生队列消息二'}]}];
      const turn = {id:'native-turn',status:'inProgress',items:[{id:'user-one',type:'userMessage',content:[{type:'text',text:'检查项目并整理修改'}]},{id:'answer-one',type:'agentMessage',text:'已读取项目。\n\n**修改内容**\n\n\u0060\u0060\u0060js\nconst safe = true\n\u0060\u0060\u0060\n\n- 支持原窗口\n- 支持原生队列'},{id:'command-one',type:'commandExecution',command:'Get-ChildItem',cwd:'D:/Projects/Demo',status:'completed',aggregatedOutput:'README.md\nsrc',exitCode:0}]};
      const thread = () => ({id:'native-chat',name:'成熟网页验收',preview:'检查项目',cwd:'D:/Projects/Demo',createdAt:1700000000,updatedAt:1700000100,status:{type:active?'active':'idle'},control:'shared',turns:[{...turn,status:active?'inProgress':'completed'}],historyCursor:'older'});
      const approval = () => ({id:'lp-approval-fixture',method:'item/commandExecution/requestApproval',params:{threadId:'native-chat',turnId:'native-turn',command:'Get-ChildItem',reason:'读取项目目录'}});
      window.WebSocket = class {
        static OPEN=1; static CLOSED=3; readyState=1;
        constructor() { window.__fixtureSocket=this; setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20); }
        frame(value) { this.onmessage?.({data:JSON.stringify(value)}); }
        send(raw) {
          const frame=JSON.parse(raw); if(frame.type!=='rpc')return;
          const p=frame.payload; calls.push(p); let result={};
          if(!p.method) { pending=false;setTimeout(()=>this.frame({type:'rpc',payload:{method:'serverRequest/resolved',params:{requestId:p.id,threadId:'native-chat'}}}),10);return; }
          const args=p.params;
          switch(p.method) {
            case 'lanpower/status': result={projects:[{name:'Demo',path:'D:/Projects/Demo'}],desktopControl:true,sharedControl:true,queueSupported:true,activeTurns:active?[{threadId:'native-chat',turnId:'native-turn'}]:[],pendingApprovals:pending?[approval()]:[]};break;
            case 'model/list': result={data:[{id:'gpt-6',model:'gpt-6',isDefault:true}],nextCursor:null};break;
            case 'thread/list': result={data:[thread()],nextCursor:null};break;
            case 'thread/read': result={thread:thread()};break;
            case 'thread/turns/list': result={data:[{id:'older-turn',status:'completed',items:[{id:'older-message',type:'agentMessage',text:'更早的原窗口消息'}]}],nextCursor:null};break;
            case 'thread/queue/list': result={data:queue,nextCursor:null};break;
            case 'thread/queue/add': queue.push({id:'queue-'+(++sequence),input:args.input}); result={};break;
            case 'thread/queue/delete': queue=queue.filter(q=>q.id!==args.queuedSubmissionId);break;
            case 'thread/queue/update': queue=queue.map(q=>q.id===args.queuedSubmissionId?{...q,input:args.input}:q);break;
            case 'thread/queue/reorder': queue=args.queuedSubmissionIds.map(id=>queue.find(q=>q.id===id));break;
            case 'turn/start': active=true;result={turn:{id:'native-turn',status:'inProgress',items:[]}};break;
            case 'turn/interrupt': active=false;setTimeout(()=>this.frame({type:'rpc',payload:{method:'turn/completed',params:{threadId:'native-chat',turn:{id:'native-turn',status:'interrupted'}}}}),20);break;
          }
          setTimeout(()=>this.frame({type:'rpc',payload:{id:p.id,result}}),5);
        }
        close(){this.readyState=3;setTimeout(()=>this.onclose?.({code:1000}),0);}
      };
    });
    await page.goto(base + '/remote'); await page.locator('.lp-thread').first().click();
    await page.locator('.thread-pending-request-primary').click();
    await page.locator('.thread-composer-input').waitFor({state:'visible'});
    assert.equal(await page.locator('.thread-pending-request-option').count(),0);
    assert.ok((await page.locator('.conversation-root').textContent()).includes('支持原窗口'));
    assert.equal(await page.locator('.queued-row').count(),2);
    await page.locator('.thread-composer-input').fill('网页添加排队消息'); await page.locator('.thread-composer-input').press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.queued-row').length===3);
    await page.locator('.queued-row-delete').last().click(); await page.waitForFunction(()=>document.querySelectorAll('.queued-row').length===2);
    await page.locator('.queued-row-edit').first().click(); await page.locator('.thread-composer-input').fill('修改原生队列消息'); await page.locator('.thread-composer-input').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.queued-row-text')?.textContent.includes('修改原生队列'));
    if (!(await page.locator('.conversation-root').textContent()).includes('更早的原窗口消息')) await page.locator('.load-more-button').first().click();
    await page.waitForFunction(()=>document.querySelector('.conversation-root')?.textContent.includes('更早的原窗口消息'));
    await page.locator('.thread-composer-stop').click(); await page.waitForFunction(()=>window.__fixtureCalls.some(c=>c.method==='turn/interrupt'));
    await page.waitForFunction(()=>document.querySelector('.lp-chat-status span')?.textContent === '已同步');
    await page.locator('.thread-composer-input').fill('继续原窗口会话'); await page.locator('.thread-composer-input').press('Enter');
    await page.waitForFunction(()=>window.__fixtureCalls.some(c=>c.method==='turn/start'));
    const before = await page.evaluate(()=>window.__fixtureCalls.filter(c=>c.method==='turn/start').length);
    await page.evaluate(()=>window.__fixtureSocket.onclose({code:1006}));
    await page.waitForFunction(()=>document.querySelector('.lp-connection')?.textContent.includes('已连接'));
    assert.equal(await page.evaluate(()=>window.__fixtureCalls.filter(c=>c.method==='turn/start').length),before,'reconnect must not resend a task');
    for(const width of [1440,390,320]) {
      await page.setViewportSize({width,height:900});
      assert.ok(await page.locator('.thread-composer-input').isVisible());
      const sizes = await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,composer:document.querySelector('.thread-composer').getBoundingClientRect().bottom}));
      assert.ok(sizes.scroll<=sizes.width+1,'horizontal overflow at '+width);
      assert.ok(sizes.composer<=901,'composer must stay visible at '+width);
      await page.screenshot({path:path.join(output,'light-'+width+'.png'),fullPage:true,animations:'disabled'});
      await page.evaluate(()=>document.documentElement.classList.add('dark'));
      await page.screenshot({path:path.join(output,'dark-'+width+'.png'),fullPage:true,animations:'disabled'});
      await page.evaluate(()=>document.documentElement.classList.remove('dark'));
    }
    await page.locator('.lp-back').click(); assert.ok(await page.locator('.lp-library').isVisible()); await page.locator('.lp-thread').first().click();
    const sent = await page.evaluate(()=>window.__fixtureCalls);
    assert.ok(sent.some(c=>!c.method&&c.id==='lp-approval-fixture'&&c.result.decision==='accept'),'preserve approval identity');
    assert.ok(sent.some(c=>c.method==='thread/queue/update'),'edit native queue');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({matureComponents:true,nativeQueueActions:true,approvalIdentity:true,historyPaging:true,reconnectNoResend:true,widths:[1440,390,320],darkAndLight:true,browserErrors:0}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
