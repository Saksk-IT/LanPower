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
  const output = path.resolve(__dirname, '../private/codex-remote-1.11');
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
      const turns = [{id:'history-turn',status:'completed',startedAt:1790928000,completedAt:1790928050,durationMs:50000,items:[
        {id:'history-user',type:'userMessage',content:[{type:'text',text:'检查登录流程'}]},
        {id:'history-ai',type:'agentMessage',text:'已检查登录流程。<img src=x onerror=window.remoteXss=true>\n**验证完成**\n[安全链接](https://example.com/)\n[不可执行](javascript:alert(1))\n```\n示例代码\n```'},
        {id:'history-file',type:'fileChange',status:'completed',changes:[{path:'login.js',diff:'-old\n+new'}]}
      ]}];
      const threads = [{id:'session-a',name:'检查登录流程',cwd:root,projectPath:root,projectName:'LanPower',updatedAt:1790928000,status:{type:'idle'},control:'available'},
        {id:'session-b',name:'桌面任务进度',cwd:other,projectPath:other,projectName:'Ti',updatedAt:1790927999,status:{type:'notLoaded'},control:'desktop'}];
      window.remoteFixtureCalls = []; let activeTurn = null;
      window.WebSocket = class {
        constructor() { this.readyState=1; window.remoteFixtureSocket=this; setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},30); }
        frame(data) { this.onmessage?.({data:JSON.stringify(data)}); }
        event(method,params) { this.frame({type:'rpc',payload:{method,params}}); }
        close() { this.readyState=3; }
        send(raw) {
          const message=JSON.parse(raw); if(message.type!=='rpc') return;
          const {id,method,params}=message.payload; window.remoteFixtureCalls.push({method,params});
          let result={};
          if(method==='lanpower/status') result={loggedIn:true,sessionHandoff:true,projects:[{name:'LanPower',path:root},{name:'Ti',path:other}],activeTurn,activeThread:activeTurn?'session-a':null,activeTurns:[...(activeTurn?[{threadId:'session-a',turnId:activeTurn}]:[]),...(window.remoteFixtureOtherActive?[{threadId:'other-session',turnId:'other-turn'}]:[])]};
          if(method==='thread/list') result={data:threads,nextCursor:null};
          if(method==='model/list') result={data:[]};
          if(method==='thread/read' || method==='thread/resume') {
            if(method==='thread/resume') threads.find(t=>t.id===params.threadId).control='remote';
            const desktop = params.threadId==='session-b', finished = window.remoteFixtureDesktopDone;
            const desktopTurns = [{id:'previous-paused-turn',status:'interrupted',items:[]},{id:'desktop-current',startedAt:Math.floor(Date.now()/1000)-180,status:finished?'completed':'inProgress',items:[{id:'desktop-progress',type:'agentMessage',text:window.remoteFixtureDesktopProgress?'这是桌面新增的实时进度。':'这是桌面正在进行的任务。'}]}];
            result={thread:{...threads.find(t=>t.id===params.threadId),turns:desktop?desktopTurns:turns,...(desktop?{live:{state:finished?'idle':'running',turnId:'desktop-current',startedAt:Math.floor(Date.now()/1000)-180}}:{})}};
          }
          if(method==='thread/start') result={thread:{id:'new-session',name:'新会话',cwd:params.cwd,projectPath:params.cwd,control:'remote',turns:[]}};
          if(method==='turn/start') { activeTurn='active-turn'; result={turn:{id:activeTurn,status:'inProgress'}}; }
          if(method==='turn/steer') result={turnId:activeTurn};
          if(method==='lanpower/session/release') { threads.find(t=>t.id===params.threadId).control='available';result={released:true}; }
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
            if(method==='lanpower/session/release') this.event('lanpower/session/released',{threadId:params.threadId});
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
    await page.waitForFunction(()=>document.querySelector('#remote-send').getAttribute('aria-label')==='引导当前任务');
    assert.equal(await page.locator('#remote-interrupt').isEnabled(),true);
    await page.evaluate(()=>{window.remoteFixtureOtherActive=true;window.remoteFixtureSocket.event('turn/started',{threadId:'other-session',turn:{id:'other-turn',status:'inProgress'}});});
    assert.equal(await page.locator('#remote-interrupt').isEnabled(),true,'another chat must not steal the current task controls');
    await page.locator('#remote-prompt').fill('只处理登录页面'); await page.locator('#remote-send').click();
    await page.waitForFunction(()=>document.querySelector('#remote-transcript').textContent.includes('已收到引导'));
    const calls=await page.evaluate(()=>window.remoteFixtureCalls);
    const steer=calls.find(c=>c.method==='turn/steer'); assert.equal(steer.params.expectedTurnId,'active-turn');
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    assert.ok((await page.locator('#remote-plan').textContent()).includes('修复并验证'));
    assert.equal(await page.locator('#remote-diff-summary').innerText(),'+1 −1');
    await page.locator('#remote-interrupt').click();
    await page.waitForFunction(()=>document.querySelector('#remote-send').getAttribute('aria-label')==='发送消息');
    assert.ok((await page.locator('#remote-transcript').innerText()).includes('该轮已暂停'));
    assert.ok((await page.locator('#remote-feedback').innerText()).includes('已暂停'));
    await page.locator('#remote-menu-toggle').click();
    assert.equal(await page.locator('#remote-release').isEnabled(),true);
    await page.locator('#remote-release').click();
    await page.waitForFunction(()=>document.querySelector('#remote-feedback').textContent.includes('会话已交还'));
    assert.equal(await page.locator('#remote-release').isDisabled(),true);
    assert.equal(await page.locator('#remote-prompt').isEnabled(),true,'a different running chat does not block this idle chat');
    assert.ok((await page.evaluate(()=>window.remoteFixtureCalls)).some(c=>c.method==='lanpower/session/release'&&c.params.threadId==='session-a'));
    await page.locator('#remote-back').click();
    assert.equal(await page.locator('.remote-sessions').isVisible(),true);
    await page.locator('[data-thread=session-b]').first().click();
    await page.waitForFunction(()=>document.querySelector('#remote-task-state').textContent.includes('桌面正在运行'));
    assert.equal(await page.locator('#remote-send').isDisabled(),true);
    assert.ok((await page.locator('#remote-control-hint').innerText()).includes('无法向桌面任务发送'));
    assert.ok(!(await page.locator('#remote-feedback').textContent()).includes('已暂停'));
    await page.evaluate(()=>{window.remoteFixtureDesktopProgress=true;});
    await page.waitForFunction(()=>document.querySelector('#remote-transcript').textContent.includes('桌面新增的实时进度'));
    assert.ok((await page.locator('#remote-task-state').innerText()).includes('桌面正在运行'));
    await page.screenshot({path:path.join(output,'desktop-running-390.png'),fullPage:true});
    await page.evaluate(()=>{window.remoteFixtureDesktopDone=true;});
    await page.waitForFunction(()=>document.querySelector('#remote-task-state').textContent.includes('本轮已结束'));
    for(const width of [1440,390,320]) {
      await page.setViewportSize({width,height:960});
      if(width<760) await page.locator('#remote-back').click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'library overflow at '+width);
      await page.screenshot({path:path.join(output,'library-'+width+'.png'),fullPage:true});
      await page.locator('[data-thread=session-a]').first().click();
      await page.waitForFunction(()=>document.querySelector('#remote-shell').dataset.view==='thread');
      await page.waitForFunction(()=>document.querySelector('#remote-title').textContent==='检查登录流程');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'thread overflow at '+width);
      const geometry=await page.evaluate(()=>{const composer=document.querySelector('#remote-task').getBoundingClientRect(),header=document.querySelector('.remote-conversation-heading').getBoundingClientRect();return {bottom:composer.bottom,top:header.top,height:innerHeight,scroll:document.documentElement.scrollHeight};});
      assert.ok(geometry.bottom<=geometry.height && geometry.bottom>geometry.height-90,'fixed composer at '+width+' '+JSON.stringify(geometry));
      assert.ok(geometry.top<=25,'fixed header at '+width); assert.ok(geometry.scroll<=geometry.height+1,'page scroll at '+width);
      await page.screenshot({path:path.join(output,'thread-'+width+'.png'),fullPage:true});
    }
    await page.waitForFunction(async()=>!(await caches.keys()).includes('lanpower-static-1.8.0'));
    assert.equal(await page.evaluate(()=>!!window.remoteXss),false);
    assert.deepEqual(errors,[]);
    const result={autoConnect:true,nativeBrowserDefaults:true,projectGroups:2,history:true,steer:true,interrupt:true,
      desktopReadOnly:true,desktopLiveProgress:true,historicalPauseIsNotCurrentStatus:true,sessionHandoff:true,independentChatControls:true,fixedComposer:true,oldCacheRemoved:true,widths:[1440,390,320],browserErrors:errors.length};
    fs.writeFileSync(path.join(output,'browser-result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
    // A separate, clearly named layout example for review; it does not represent a real task result.
    await page.setViewportSize({width:390,height:900});
    await page.evaluate(()=>{
      document.querySelector('#remote-title').textContent='重做 Codex Remote 交互'; document.querySelector('#remote-project-name').textContent='LanPower · 开发电脑';
      const user=document.querySelector('.remote-user'); if(user)user.textContent='继续向原生 Remote 靠近，页面也要像原生一样简洁。';
      const reply=document.querySelector('.remote-turn .remote-message:not(.remote-user):not(.remote-notice)');
      if(reply){reply.replaceChildren(); const p=document.createElement('p');p.textContent='现在可以选择电脑，浏览最近会话和项目，继续在你的电脑上工作。';const list=document.createElement('ul');for(const text of ['查看会话消息与实时进度','展开执行过程和文件修改','发送引导，或暂停远程任务']){const li=document.createElement('li');li.textContent=text;list.append(li);}reply.append(p,list);}
      document.querySelector('#remote-chat-scroll').scrollTop=0;
    });
    await page.screenshot({path:path.join(output,'native-style-example-390.png'),fullPage:true});
  } finally {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      try { await page.locator('form[action="/logout"]').evaluate(async form => {
        await fetch('/logout',{method:'POST',body:new URLSearchParams(new FormData(form)),credentials:'same-origin'});
      }); } catch { /* Cleanup must never print authenticated request details. */ }
    }
    await browser.close();
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
