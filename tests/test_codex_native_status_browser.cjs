// Actual LanPower UI, isolated RPC fixtures; no inference or native configuration mutation.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443', out = path.resolve(__dirname,'../private/native-status'); fs.mkdirSync(out,{recursive:true});
  const password = fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const calls = [], errors = [], screenshots = [], project = 'D:/Fixture/NativeStatus'; let quotaFailed = false;
  const counts = totalTokens => ({totalTokens,inputTokens:totalTokens,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0});
  const metadata = {id:'native-fixture',name:'原生状态验收',cwd:project,control:'shared',status:{type:'idle'}};
  async function rpc(request) {
    calls.push({method:request.method,params:request.params}); const p = request.params;
    switch(request.method) {
      case 'lanpower/status': return {result:{projects:[{name:'验收项目',path:project}],loggedIn:true,sharedControl:true,desktopControl:true,capabilityPaging:true,activeTurns:[],pendingApprovals:[]}};
      case 'model/list': return {result:{data:[{id:'gpt-6',isDefault:true}]}};
      case 'collaborationMode/list': return {result:{data:[]}};
      case 'thread/list': return {result:{data:[metadata]}};
      case 'thread/read': return {result:{thread:{...metadata,turns:[]}}};
      case 'thread/queue/list': return {result:{data:[]}};
      case 'account/rateLimits/read': return quotaFailed ? {error:{code:-32000,message:'fixture_native_quota_unavailable'}} : {result:{rateLimitsByLimitId:{codex:{primary:{usedPercent:42,windowDurationMins:300}},other:{secondary:{usedPercent:10,windowDurationMins:10080}}}}};
      case 'skills/list': return {result:{data:[{cwd:project,skills:[{name:'已启用技能',path:project+'/a/SKILL.md',enabled:true},{name:'未知技能',path:project+'/b/SKILL.md'},{name:'未启用技能',path:project+'/c/SKILL.md',enabled:false}]}],nextCursor:null}};
      case 'plugin/list': return {result:{marketplaces:[{name:'fixture',plugins:Array.from({length:p.cursor ? 3 : 24},(_,i)=>({id:'plugin-'+(p.cursor ? 24+i : i),name:'插件 '+(p.cursor ? 24+i : i),...(i%2 ? {installed:false} : {installed:true,enabled:true})}))}],nextCursor:p.cursor ? null : 'plugin-next'}};
      case 'app/list': return {result:{data:Array.from({length:p.cursor ? 3 : 24},(_,i)=>({id:'app-'+i,name:['已安装应用','未启用应用','需授权应用','未知应用'][i%4]+i,...[{isAccessible:true,isEnabled:true},{isAccessible:true,isEnabled:false},{isAccessible:false,isEnabled:true},{}][i%4]})),nextCursor:p.cursor ? null : 'app-next'}};
      case 'mcpServerStatus/list': return {result:{data:[{name:'需授权 MCP',authStatus:'notLoggedIn'},{name:'未知 MCP',authStatus:'unsupported',tools:[{name:'tool',description:'工具存在不能证明授权'}]}],nextCursor:null}};
      default: return {result:{}};
    }
  }
  const browser = await chromium.launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});
  const context = await browser.newContext({viewport:{width:1440,height:980},ignoreHTTPSErrors:true});
  try {
    await context.exposeBinding('__nativeStatusRpc',(_,request)=>rpc(request));
    await context.addInitScript(()=> { window.WebSocket = class {
      static OPEN=1; readyState=1;
      constructor(){window.__nativeStatusSocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}
      frame(frame){this.onmessage?.({data:JSON.stringify(frame)});}
      async send(raw){const frame=JSON.parse(raw);if(frame.type !== 'rpc')return;const request=frame.payload,reply=await window.__nativeStatusRpc(request);this.frame({type:'rpc',payload:{id:request.id,...reply}});}
      close(){this.readyState=3;}
    }; });
    const page = await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('[data-thread-id="native-fixture"] .lp-thread-title').click();
    await page.waitForFunction(()=>document.querySelector('.lp-native-context'));
    await page.evaluate(({counts})=>window.__nativeStatusSocket.frame({type:'rpc',payload:{method:'thread/tokenUsage/updated',params:{threadId:'native-fixture',tokenUsage:{total:counts,last:counts,modelContextWindow:24000}}}}),{counts:counts(12000)});
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('main').getByText('50% 剩余',{exact:true}).waitFor();
    assert.equal(calls.filter(row=>row.method==='account/rateLimits/read').length,1);
    assert.equal(await page.locator('.rate-limit-card').count(),2);assert.ok((await page.getByRole('main').locator('.lp-token-status').textContent()).includes('12,000'));
    for(const width of [1440,375,768]) for(const theme of ['light','dark']) {
      await page.setViewportSize({width,height:width===375 ? 812 : 1024});await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);await page.waitForTimeout(2200);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const screenshot=path.join(out,`quota-${width}-${theme}.png`);await page.screenshot({path:screenshot,fullPage:true});screenshots.push(screenshot);
    }
    quotaFailed=true;await page.getByRole('button',{name:'刷新原生额度',exact:true}).click();await page.getByText(/fixture_native_quota_unavailable/).waitFor();assert.equal(await page.locator('.rate-limit-card-metric').count(),0);
    await page.setViewportSize({width:1440,height:980});await page.getByRole('button',{name:'返回聊天',exact:true}).click();await page.getByRole('button',{name:'技能 PLUGINS, APPS, MCPS'}).click();
    await page.getByRole('tab',{name:'技能',exact:true}).click();await page.getByRole('heading',{name:'未知技能',exact:true}).waitFor();
    assert.equal(await page.locator('.lp-feature-card').filter({has:page.getByRole('heading',{name:'未知技能',exact:true})}).getByRole('button',{name:'添加到聊天'}).isDisabled(),true);
    await page.getByRole('tab',{name:'应用',exact:true}).click();await page.getByRole('heading',{name:'未知应用3',exact:true}).waitFor();
    assert.equal(await page.locator('.lp-feature-card').count(),24);for(const state of ['installed','disabled','needs-auth','unknown']) assert.ok(await page.locator(`.lp-card-badge[data-state="${state}"]`).count());
    assert.equal(calls.filter(row=>row.method==='app/list').length,1);assert.equal(calls.find(row=>row.method==='app/list').params.limit,24);
    await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.lp-feature-card').length===3);assert.equal(calls.filter(row=>row.method==='app/list').length,2);
    await page.getByRole('button',{name:'上一页',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.lp-feature-card').length===24);
    await page.setViewportSize({width:375,height:812});await page.waitForTimeout(2200);const screenshot=path.join(out,'capabilities-375-dark.png');await page.screenshot({path:screenshot,fullPage:true});screenshots.push(screenshot);
    await page.getByRole('tab',{name:'插件',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.lp-feature-card').length===24);
    assert.ok(await page.locator('.lp-card-badge[data-state="not-installed"]').count());assert.equal(calls.filter(row=>row.method==='plugin/list').length,1);
    await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.lp-feature-card').length===3);
    assert.equal(calls.filter(row=>row.method==='plugin/list').length,2);
    await page.getByRole('tab',{name:'MCP',exact:true}).click();await page.getByRole('heading',{name:'未知 MCP',exact:true}).waitFor();
    assert.equal(await page.locator('.lp-card-badge[data-state="needs-auth"]').count(),1);assert.equal(await page.locator('.lp-card-badge[data-state="unknown"]').count(),1);
    assert.deepEqual(errors,[]);assert.ok(!calls.some(row=>['turn/start','plugin/install','config/batchWrite'].includes(row.method)));
    const report={passed:true,url:base+'/remote',viewports:[1440,375,768],themes:['light','dark'],screenshots,errors,requestCounts:Object.fromEntries([...new Set(calls.map(row=>row.method))].map(method=>[method,calls.filter(row=>row.method===method).length])),realNativeData:false,realPhoneTested:false};fs.writeFileSync(path.join(out,'browser-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
