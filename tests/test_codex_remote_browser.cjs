// Browser layout and interaction checks against the local HTTPS development instance.
// Runtime responses are controlled fixtures; real Host/Relay checks are separate.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const loginFile = process.env.LANPOWER_DEV_LOGIN_FILE || path.resolve(__dirname, '../deploy/docker/private/dev-login.txt');
  const password = fs.readFileSync(loginFile, 'utf8').match(/^Password: (.+)$/m)[1].trim();
  const output = path.resolve(__dirname, '../private/codex-remote-1.9');
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext(), page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/login');
    await page.locator('[name=username]').fill('admin'); await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'), page.locator('form[action="/login"] button').click()]);
    await page.evaluate(async () => { const cache=await caches.open('lanpower-static-1.8.0'); await cache.put('/static/remote.js?v=1.8.0',new Response('stale-script')); });
    await page.addInitScript(() => {
      const root = 'C:\\RemoteFixture\\LanPower', other = 'C:\\RemoteFixture\\Ti';
      const turns = [{id:'history-turn',status:'completed',items:[
        {id:'history-user',type:'userMessage',content:[{type:'text',text:'检查登录流程'}]},
        {id:'history-ai',type:'agentMessage',text:'已检查登录流程。<img src=x onerror=window.remoteXss=true>\n**验证完成**\n[安全链接](https://example.com/)\n[不可执行](javascript:alert(1))\n```\n示例代码\n```'},
        {id:'history-file',type:'fileChange',status:'completed',changes:[{path:'login.js',diff:'-old\n+new'}]}
      ]}];
      const threads = [{id:'session-a',name:'检查登录流程',cwd:root,projectPath:root,projectName:'LanPower',updatedAt:1790928000,status:{type:'idle'},control:'available'},
        {id:'session-b',name:'桌面任务进度',cwd:other,projectPath:other,projectName:'Ti',updatedAt:1790927999,status:{type:'notLoaded'},control:'desktop'}];
      window.remoteFixtureCalls = []; let activeTurn = null;
      window.WebSocket = class {
        constructor() { this.readyState=1; setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},30); }
        frame(data) { this.onmessage?.({data:JSON.stringify(data)}); }
        event(method,params) { this.frame({type:'rpc',payload:{method,params}}); }
        close() { this.readyState=3; }
        send(raw) {
          const message=JSON.parse(raw); if(message.type!=='rpc') return;
          const {id,method,params}=message.payload; window.remoteFixtureCalls.push({method,params});
          let result={};
          if(method==='lanpower/status') result={loggedIn:true,projects:[{name:'LanPower',path:root},{name:'Ti',path:other}],activeTurn,activeThread:activeTurn?'session-a':null};
          if(method==='thread/list') result={data:threads,nextCursor:null};
          if(method==='model/list') result={data:[]};
          if(method==='thread/read' || method==='thread/resume') result={thread:{...threads.find(t=>t.id===params.threadId),turns}};
          if(method==='thread/start') result={thread:{id:'new-session',name:'新会话',cwd:params.cwd,projectPath:params.cwd,control:'remote',turns:[]}};
          if(method==='turn/start') { activeTurn='active-turn'; result={turn:{id:activeTurn,status:'inProgress'}}; }
          if(method==='turn/steer') result={turnId:activeTurn};
          setTimeout(()=>{
            this.frame({type:'rpc',payload:{id,result}});
            if(method==='turn/start') {
              this.event('turn/started',{threadId:'session-a',turn:{id:activeTurn,status:'inProgress'}});
              this.event('turn/plan/updated',{threadId:'session-a',plan:[{step:'定位问题',status:'completed'},{step:'修复并验证',status:'inProgress'}]});
              this.event('item/agentMessage/delta',{threadId:'session-a',itemId:'live-message',delta:'正在检查实际行为。'});
              this.event('turn/diff/updated',{threadId:'session-a',diff:'--- a/login.js\n+++ b/login.js\n-old\n+new'});
            }
            if(method==='turn/steer') this.event('item/agentMessage/delta',{threadId:'session-a',itemId:'live-message',delta:'已收到引导。'});
            if(method==='turn/interrupt') { activeTurn=null; this.event('turn/completed',{threadId:'session-a',turn:{id:'active-turn',status:'interrupted'}}); }
          },20);
        }
      };
    });
    await page.setViewportSize({width:390,height:900}); await page.goto(base + '/remote');
    await page.waitForFunction(()=>document.querySelector('#remote-threads [data-thread="session-a"]'));
    assert.equal(await page.locator('#remote-state').innerText(),'Codex 已连接');
    assert.equal(await page.locator('#remote-workspace').inputValue(),'');
    assert.equal(await page.locator('.remote-project-group').count(),2);
    assert.equal(await page.locator('.remote-main').isVisible(),false);
    await page.locator('[data-thread=session-a]').first().click();
    await page.locator('.remote-main').waitFor({state:'visible'});
    assert.equal(await page.locator('.remote-main').isVisible(),true);
    assert.equal(await page.locator('.remote-sessions').isVisible(),false);
    assert.ok((await page.locator('#remote-transcript').innerText()).includes('已检查登录流程'));
    assert.equal(await page.locator('#remote-transcript img').count(),0);
    assert.equal(await page.locator('#remote-transcript strong').innerText(),'验证完成');
    assert.equal(await page.locator('#remote-transcript a[href^="javascript:"]').count(),0);
    await page.locator('#remote-prompt').fill('继续修复登录'); await page.locator('#remote-send').click();
    await page.waitForFunction(()=>document.querySelector('#remote-send').textContent==='引导');
    assert.equal(await page.locator('#remote-interrupt').isEnabled(),true);
    await page.locator('#remote-prompt').fill('只处理登录页面'); await page.locator('#remote-send').click();
    await page.waitForFunction(()=>document.querySelector('#remote-transcript').textContent.includes('已收到引导'));
    const calls=await page.evaluate(()=>window.remoteFixtureCalls);
    const steer=calls.find(c=>c.method==='turn/steer'); assert.equal(steer.params.expectedTurnId,'active-turn');
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    assert.ok((await page.locator('#remote-plan').innerText()).includes('修复并验证'));
    assert.equal(await page.locator('#remote-diff-summary').innerText(),'+1 −1');
    await page.locator('#remote-interrupt').click();
    await page.waitForFunction(()=>document.querySelector('#remote-send').textContent==='发送');
    assert.ok((await page.locator('#remote-transcript').innerText()).includes('已暂停'));
    assert.ok((await page.locator('#remote-feedback').innerText()).includes('已暂停'));
    await page.locator('#remote-back').click();
    assert.equal(await page.locator('.remote-sessions').isVisible(),true);
    await page.locator('[data-thread=session-b]').first().click();
    await page.waitForFunction(()=>document.querySelector('#remote-task-state').textContent.includes('桌面占用'));
    assert.equal(await page.locator('#remote-send').isDisabled(),true);
    assert.ok((await page.locator('#remote-control-hint').innerText()).includes('桌面释放'));
    for(const width of [1440,390,320]) {
      await page.setViewportSize({width,height:960});
      if(width<760) await page.locator('#remote-back').click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'library overflow at '+width);
      await page.screenshot({path:path.join(output,'library-'+width+'.png'),fullPage:true});
      await page.locator('[data-thread=session-a]').first().click();
      await page.waitForFunction(()=>document.querySelector('#remote-title').textContent==='检查登录流程');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'thread overflow at '+width);
      await page.screenshot({path:path.join(output,'thread-'+width+'.png'),fullPage:true});
    }
    await page.waitForFunction(async()=>!(await caches.keys()).includes('lanpower-static-1.8.0'));
    assert.equal(await page.evaluate(()=>!!window.remoteXss),false);
    assert.deepEqual(errors,[]);
    const result={autoConnect:true,nativeBrowserDefaults:true,projectGroups:2,history:true,steer:true,interrupt:true,
      desktopReadOnly:true,oldCacheRemoved:true,widths:[1440,390,320],browserErrors:errors.length};
    fs.writeFileSync(path.join(output,'browser-result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
  } finally {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      try { await page.locator('form[action="/logout"]').evaluate(async form => {
        await fetch('/logout',{method:'POST',body:new URLSearchParams(new FormData(form)),credentials:'same-origin'});
      }); } catch { /* Cleanup must never print authenticated request details. */ }
    }
    await browser.close();
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
