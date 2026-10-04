const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
(async()=>{
  const base=process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password=fs.readFileSync(process.env.LANPOWER_DEV_LOGIN_FILE || path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/login'); await page.locator('[name=username]').fill('admin'); await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.addInitScript(()=>{
      window.recencyCalls=[];
      const now=Math.floor(Date.now()/1000), rows=[{id:'newer',name:'较新的聊天',updatedAt:now-3600},{id:'older',name:'只读查看的聊天',updatedAt:now-7200}].map(t=>({...t,cwd:'D:/Projects/Demo',createdAt:now-9000,control:'shared',status:{type:'idle'}}));
      window.markRealActivity=()=>{ rows[1].updatedAt=Math.floor(Date.now()/1000); window.recencySocket.frame({type:'rpc',payload:{method:'thread/started',params:{thread:rows[1]}}}) };
      window.WebSocket=class {
        static OPEN=1; static CLOSED=3; readyState=1;
        constructor(){window.recencySocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'})},10)}
        frame(value){this.onmessage?.({data:JSON.stringify(value)})}
        send(raw){const frame=JSON.parse(raw);if(frame.type!=='rpc')return;const p=frame.payload;window.recencyCalls.push(p.method);let result={};
          if(p.method==='lanpower/status')result={projects:[{name:'Demo',path:'D:/Projects/Demo'}],sharedControl:true,desktopControl:true,loggedIn:true,queueSupported:true,activeTurns:[],pendingApprovals:[]};
          if(p.method==='thread/list')result={data:rows,nextCursor:null};
          if(p.method==='thread/read')result={thread:{...rows.find(t=>t.id===p.params.threadId),turns:[]}};
          if(p.method==='model/list')result={data:[{id:'gpt-6',model:'gpt-6',isDefault:true}],nextCursor:null};
          if(p.method==='thread/queue/list')result={data:[],nextCursor:null};
          setTimeout(()=>this.frame({type:'rpc',payload:{id:p.id,result}}),2);
        }
        close(){this.readyState=3;this.onclose?.({code:1000})}
      };
    });
    await page.goto(base+'/remote'); await page.locator('[data-thread-id="older"]').waitFor();
    const order=()=>page.locator('.lp-thread').evaluateAll(rows=>rows.map(row=>row.dataset.threadId));
    const label=()=>page.locator('[data-thread-id="older"] .lp-thread-time').textContent();
    const before=await order(), time=await label(); assert.equal(time,'2h');
    for(let repeat=0;repeat<3;repeat++) {
      await page.locator('[data-thread-id="older"]').click(); await page.locator('.thread-composer-input').waitFor();
      await page.waitForFunction(()=>!document.querySelector('.lp-sync')?.textContent?.includes('正在恢复'));
      assert.equal(await label(),time); assert.deepEqual(await order(),before);
      await page.locator('[data-thread-id="newer"]').click();
    }
    await page.reload(); await page.locator('[data-thread-id="older"]').waitFor();
    assert.equal(await label(),time); assert.deepEqual(await order(),before);
    await page.evaluate(()=>window.markRealActivity());
    await page.waitForFunction(()=>document.querySelector('.lp-thread')?.dataset.threadId==='older');
    assert.equal(await label(),'刚刚');
    const calls=await page.evaluate(()=>window.recencyCalls);
    assert.ok(!calls.some(method=>['thread/resume','turn/start','turn/steer','thread/queue/add','thread/queue/update','thread/rollback'].includes(method)));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({fixture:true,repeatedViewsKeepTime:true,viewsKeepOrder:true,reloadKeepsTime:true,realActivityUpdatesTime:true,writeRequests:0,browserErrors:0}));
  } finally {await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
