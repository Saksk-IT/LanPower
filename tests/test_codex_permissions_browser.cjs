// Built UI with isolated native RPC responses; never writes to a real Codex thread.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443', root = path.resolve(__dirname,'..');
  const staticRoot = process.env.LANPOWER_UI_STATIC || path.join(root,'cloud_app/static/codex-ui');
  const out = path.join(root,'private/codex-permissions-1.20.0/browser'); fs.mkdirSync(out,{recursive:true});
  const password = fs.readFileSync(path.join(root,'deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const cwd = 'D:/Fixture/Permissions', calls = [], errors = [], screenshots = [];
  const ask = {approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[cwd]}};
  let settings = {...ask}, reject = false, supported = true, active = false;
  const metadata = id => ({id,name:id === 'permission-one' ? '权限测试会话' : '另一会话',cwd,control:'shared',status:{type:active?'active':'idle'},...id === 'permission-one'?settings:ask});
  async function rpc(request) {
    calls.push(request); const p = request.params;
    switch(request.method) {
      case 'lanpower/status': return {result:{projects:[{name:'权限测试',path:cwd}],sharedControl:true,desktopControl:true,permissionsControl:supported,activeTurns:active?[{threadId:'permission-one',turnId:'active-turn'}]:[],pendingApprovals:[]}};
      case 'model/list': return {result:{data:[{id:'gpt-6',isDefault:true}]}};
      case 'collaborationMode/list': return {result:{data:[]}};
      case 'thread/list': return {result:{data:[metadata('permission-one'),metadata('permission-two')]}};
      case 'thread/read': return {result:{thread:{...metadata(p.threadId),turns:active?[{id:'active-turn',status:'inProgress',items:[]}]:[]}}};
      case 'thread/queue/list': return {result:{data:[]}};
      case 'account/rateLimits/read': return {result:{}};
      case 'skills/list': return {result:{data:[]}};
      case 'lanpower/permissions/set':
        if (reject) return {error:{code:-32600,message:'fixture_managed_permissions_denied'}};
        settings = p.permissionMode === 'full-access' ? {approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}} : {...ask,approvalsReviewer:p.permissionMode === 'auto-review'?'auto_review':'user'};
        return {result:{thread:metadata('permission-one'),appliesTo:'subsequentTurns'}};
      default: return {result:{}};
    }
  }
  const browser=await chromium.launch({headless:true,...process.platform === 'win32'?{channel:'msedge'}:{}});
  const context=await browser.newContext({viewport:{width:1440,height:980}});
  try {
    await context.route('**/static/codex-ui/**',async route => {
      const relative = new URL(route.request().url()).pathname.split('/static/codex-ui/')[1];
      const file=path.resolve(staticRoot,relative); assert.ok(file.startsWith(path.resolve(staticRoot)+path.sep));
      await route.fulfill({path:file,contentType:relative.endsWith('.css')?'text/css':'application/javascript'});
    });
    await context.exposeBinding('__permissionRpc',(_,request)=>rpc(request));
    await context.addInitScript(()=> { window.WebSocket=class {
      static OPEN=1;readyState=1;
      constructor(){window.__permissionSocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}
      frame(frame){this.onmessage?.({data:JSON.stringify(frame)});}
      async send(raw){const frame=JSON.parse(raw);if(frame.type==='rpc'){const request=frame.payload,reply=await window.__permissionRpc(request);this.frame({type:'rpc',payload:{id:request.id,...reply}});}}
      close(){this.readyState=3;}
    };});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('[data-thread-id="permission-one"] .lp-thread-title').click();
    const trigger=page.getByRole('button',{name:'更改 Codex 权限',exact:true});
    await page.waitForFunction(()=>document.querySelector('.lp-permission-trigger')?.textContent.includes('请求批准'));
    for(const width of [1440,390,320]) for(const theme of ['light','dark']) {
      await page.setViewportSize({width,height:width<640?844:980});await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
      await trigger.click();await page.getByRole('menu',{name:'Codex 权限模式'}).waitFor();
      assert.equal(await page.getByRole('menuitemradio').count(),3);
      assert.equal(await page.getByRole('menu',{name:'Codex 权限模式'}).evaluate(el=>getComputedStyle(el).backgroundColor),theme === 'dark'?'rgb(24, 24, 27)':'rgb(255, 255, 255)');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const box=await page.getByRole('menu',{name:'Codex 权限模式'}).boundingBox();assert.ok(box.x>=0 && box.x+box.width<=width+1);
      const file=path.join(out,`menu-${width}-${theme}.png`);await page.screenshot({path:file,fullPage:true});screenshots.push(file);
      await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),0);
    }
    await page.setViewportSize({width:1440,height:980});await page.evaluate(()=>document.documentElement.classList.remove('dark'));
    for(const label of ['帮我批准','完全访问权限','请求批准']) {
      await trigger.click();await page.getByRole('menuitemradio').filter({hasText:label}).click();
      await page.waitForFunction(label=>document.querySelector('.lp-permission-trigger')?.textContent.includes(label),label);
    }
    assert.equal(calls.filter(c=>c.method==='lanpower/permissions/set').length,3);
    await page.reload();await page.locator('[data-thread-id="permission-one"] .lp-thread-title').click();await page.waitForFunction(()=>document.querySelector('.lp-permission-trigger')?.textContent.includes('请求批准'));
    reject=true;await trigger.click();await page.getByRole('menuitemradio').filter({hasText:'完全访问权限'}).click();await page.getByText(/fixture_managed_permissions_denied/).waitFor();
    assert.ok((await trigger.textContent()).includes('请求批准'));reject=false;
    settings={...ask,approvalsReviewer:'auto_review'};
    await page.evaluate(settings=>window.__permissionSocket.frame({type:'rpc',payload:{method:'thread/settings/updated',params:{threadId:'permission-one',threadSettings:{...settings,sandboxPolicy:settings.sandbox}}}}),settings);
    await page.waitForFunction(()=>document.querySelector('.lp-permission-trigger')?.textContent.includes('帮我批准'));
    await page.locator('[data-thread-id="permission-two"] .lp-thread-title').click();await page.waitForFunction(()=>document.querySelector('.lp-permission-trigger')?.textContent.includes('请求批准'));
    active=true;await page.locator('[data-thread-id="permission-one"] .lp-thread-title').click();await trigger.click();await page.getByText('更改用于后续任务；当前任务和已发起的审批保留原设置。',{exact:true}).waitFor();await page.keyboard.press('Escape');
    supported=false;active=false;await page.reload();await page.locator('[data-thread-id="permission-one"] .lp-thread-title').click();await trigger.click();assert.equal(await page.getByRole('menuitemradio').first().isDisabled(),true);
    assert.ok(!calls.some(c=>['turn/start','turn/interrupt','turn/steer'].includes(c.method)));assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({pageErrors:errors,permissionWrites:calls.filter(c=>c.method==='lanpower/permissions/set').length,inferenceTurns:0,screenshots},null,2));
    console.log(JSON.stringify({passed:true,viewports:3,themes:2,pageErrors:errors.length,permissionWrites:4,inferenceTurns:0}));
    await page.goto(base+'/dashboard');
    const logout=page.locator('form[action="/logout"] button');if(await logout.count())await logout.click();
  } finally {await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
