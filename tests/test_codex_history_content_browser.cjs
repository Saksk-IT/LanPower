// Browser replay of public history only. The fixture never connects a real controller or submits a task.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password = fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  let png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=';
  const design = process.env.LANPOWER_NATIVE_DESIGN_FIXTURE ? JSON.parse(fs.readFileSync(process.env.LANPOWER_NATIVE_DESIGN_FIXTURE,'utf8')) : {
    id:'design-turn',status:'completed',items:[{id:'viewed-image',type:'imageView',path:'D:/Projects/History/portrait.png'},...Array.from({length:3},(_,i)=>({id:'image-'+i,type:'imageGeneration',result:png,revisedPrompt:'x'.repeat(750000)})),
      {id:'answer',type:'agentMessage',phase:'final_answer',text:'我建议采用 A 的主界面，搭配 B 的深色模式和 C 的审批弹层。完整正文末尾。'}],
  };
  const final = design.items.find(item=>item.type==='agentMessage'&&item.phase==='final_answer');
  const images = design.items.filter(item=>item.type==='imageGeneration');
  const imageActivities = design.items.filter(item=>['imageGeneration','image_generation','imageView'].includes(item.type));
  const previewOutput=path.resolve(__dirname,'../private/codex-image-preview-1.18.1/browser');fs.mkdirSync(previewOutput,{recursive:true});
  const body = JSON.stringify(design), calls = [], errors = [], downloads = [];
  const subscribe = () => () => {};
  const manager = {getHostId:()=> 'local',getConversation:()=>({requests:[]}),getRecentConversations:()=>[],sendRequest:async()=>({data:[design],nextCursor:null}),
    addApprovalRequestListener:subscribe,addNotificationCallback:subscribe,addTurnCompletedListener:subscribe,addStreamRoleStateCallback:subscribe};
  const sandbox = vm.createContext({TextEncoder,crypto:require("node:crypto").webcrypto,__codexRoot:{_internalRoot:{current:{memoizedState:{memoizedState:manager}}}}});
  const renderer = fs.readFileSync(path.resolve(__dirname,'../windows/LanPower.CodexHost/DesktopRenderer.js'),'utf8');
  await vm.runInContext(renderer.replaceAll('__LANPOWER_GLOBAL__','historyAdapter').replaceAll('__LANPOWER_BINDING__','unusedBinding'),sandbox);
  const adapter = sandbox.historyAdapter;
  let legacy = true, disconnectOnce = true, expireOnce = false, holdChunk = false, releaseChunk;
  const metadata = id => ({id,name:id==='design'?'设计会话完整内容':'另一条会话',cwd:'D:/Projects/History',status:{type:'idle'},control:'shared',model:'gpt-6.1-sol'});
  async function pageTurns(id) {
    if (id!=='design') return [{id:'other-turn',status:'completed',items:[{id:'other-answer',type:'agentMessage',phase:'final_answer',text:'另一会话的独立内容'}]}];
    if (legacy) return [{...design,items:[{id:design.id,type:'lanpowerLargeItem',originalType:'turn',reference:'legacy',wholeTurn:true,characters:body.length,bytes:Buffer.byteLength(body)}]}];
    return (await adapter.rpc('codex-web/local/history/page',{threadId:'design',limit:1})).data;
  }
  async function rpc(request) {
    calls.push({method:request.method,...request.params}); const p = request.params;
    switch (request.method) {
      case 'lanpower/status': return {result:{projects:[{name:'History',path:'D:/Projects/History'}],desktopControl:true,sharedControl:true,queueSupported:true,activeTurns:[],pendingApprovals:[]}};
      case 'model/list': return {result:{data:[{id:'gpt-6.1-sol',isDefault:true}]}};
      case 'thread/list': return {result:{data:['design','other'].map(metadata),nextCursor:null}};
      case 'thread/read': return {result:{thread:{...metadata(p.threadId),turns:await pageTurns(p.threadId),historyCursor:null}}};
      case 'thread/turns/list': return {result:{data:await pageTurns(p.threadId),nextCursor:null}};
      case 'thread/queue/list': return {result:{data:[]}};
      case 'lanpower/image/read': {
        if (process.env.LANPOWER_NATIVE_DESIGN_FIXTURE && fs.existsSync(p.path)) {
          const bytes=fs.readFileSync(p.path); return {result:{contentType:'image/png',base64:bytes.toString('base64'),size:bytes.length}};
        }
        return {result:{contentType:'image/png',base64:png,size:Buffer.from(png,'base64').length}};
      }
      case 'lanpower/history/item/read': {
        if (holdChunk) {holdChunk=false;await new Promise(resolve=>releaseChunk=resolve);}
        if (disconnectOnce && p.offset>0) {disconnectOnce=false;return {disconnect:true};}
        if (expireOnce) {expireOnce=false;return {error:{code:-32000,message:'history_reference_expired'}};}
        if (p.reference!=='legacy') return {result:await adapter.rpc('codex-web/local/history/item/read',p)};
        let end=Math.min(body.length,p.offset+65536);if(end<body.length&&/[\uD800-\uDBFF]/.test(body[end-1]))end--;
        return {result:{offset:p.offset,data:body.slice(p.offset,end),nextOffset:end<body.length?end:null,characters:body.length}};
      }
      default: return {result:{data:[]}};
    }
  }
  const browser = await chromium.launch({headless:true}), context = await browser.newContext({viewport:{width:1440,height:980}});
  try {
    await context.exposeBinding('__historyRpc',(_,request)=>rpc(request));
    await context.addInitScript(()=>{
      window.WebSocket=class {
        static OPEN=1;readyState=1;
        constructor(){window.__historySocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}
        frame(value){this.onmessage?.({data:JSON.stringify(value)});}
        async send(raw){const frame=JSON.parse(raw);if(frame.type!=='rpc')return;const request=frame.payload,reply=await window.__historyRpc(request);
          if(reply.disconnect){this.readyState=3;this.onclose?.({code:1006});return;}
          const payload={id:request.id,...reply},body=JSON.stringify(payload);
          if(body.length<256000)this.frame({type:'rpc',payload});
          else{const parts=body.match(/[\s\S]{1,32000}/g);parts.forEach((data,index)=>this.frame({type:'rpc_chunk',id:request.id,index,count:parts.length,data}));}}
        close(){this.readyState=3;}
      };
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('download',d=>downloads.push(d.suggestedFilename()));
    png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=240;canvas.height=960;const c=canvas.getContext('2d');c.fillStyle='#eef2ff';c.fillRect(0,0,240,960);c.fillStyle='#4169e1';for(let i=0;i<6;i++)c.fillRect(20,30+i*150,200,90);return canvas.toDataURL('image/png').split(',')[1];});
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('[data-thread-id="design"] .lp-thread-title').click();
    await page.locator(`[data-message-id="${final.id}"]`).waitFor({timeout:45000});
    assert.equal(await page.locator('.lp-history-content').count(),0);
    assert.ok(calls.filter(call=>call.method==='lanpower/history/item/read').filter(call=>call.offset===65536).length>=2,'resume the interrupted segment');
    assert.equal(await page.getByRole('button',{name:/完整下载|导出完整/}).count(),0);
    assert.ok((await page.locator(`[data-message-id="${final.id}"]`).textContent()).includes('我建议采用'));
    const viewedActivities=imageActivities.filter(item=>item.type==='imageView');
    if(viewedActivities.length){assert.equal(await page.locator('.turn-process-toggle').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('[data-message-id="viewed-image"]').count(),0);await page.locator('.turn-process-toggle').click();}
    for (const image of imageActivities) {
      const activity=page.locator(`[data-message-id="${image.id}"]`),toggle=activity.locator('.native-image-toggle');
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      assert.equal(await activity.locator('.lp-remote-image').count(),0,'collapsed activities do not mount full-size images');
      assert.ok((await toggle.textContent()).includes(image.type==='imageView'?'已查看 1 张图像':'已生成 1 张图像'));
      await toggle.click();
      const preview=page.locator(`[data-message-id="${image.id}"] img`);await preview.scrollIntoViewIfNeeded();
      await page.waitForFunction(id=>document.querySelector(`[data-message-id="${id}"] img`)?.naturalWidth>0,image.id);
      const box=await activity.locator('.lp-remote-image').boundingBox();assert.ok(box.width<=141&&box.height<=141,JSON.stringify(box));
    }
    if (!process.env.LANPOWER_NATIVE_DESIGN_FIXTURE) {
      const activity=page.locator('[data-message-id="viewed-image"]'),toggle=activity.locator('.native-image-toggle');
      for(const width of [1440,390,320]) {
        await page.setViewportSize({width,height:900});await activity.scrollIntoViewIfNeeded();
        const box=await activity.locator('.lp-remote-image').boundingBox();assert.ok(box.width<=141&&box.height<=141);
        assert.equal(await activity.locator('img').evaluate(img=>getComputedStyle(img).objectFit),'contain');
        await activity.screenshot({path:path.join(previewOutput,`image-preview-${width}.png`),animations:'disabled'});
        await activity.locator('.lp-remote-image').click();await page.waitForFunction(()=>document.querySelector('.image-modal-image')?.naturalHeight===960);
        await page.keyboard.press('Escape');assert.equal(await page.locator('.image-modal-backdrop').count(),0);
        await toggle.click();assert.equal(await activity.locator('.lp-remote-image').count(),0);
        await activity.screenshot({path:path.join(previewOutput,`image-collapsed-${width}.png`),animations:'disabled'});
        await toggle.click();await activity.locator('img').waitFor();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      }
      await page.setViewportSize({width:1440,height:980});
    }
    const markdownImages=page.locator(`[data-message-id="${final.id}"] .lp-remote-image`);
    for (let index=0;index<await markdownImages.count();index++) {
      await markdownImages.nth(index).scrollIntoViewIfNeeded();
      await page.waitForFunction(({id,index})=>document.querySelectorAll(`[data-message-id="${id}"] .lp-remote-image`)[index]?.querySelector('img')?.naturalWidth>0,{id:final.id,index});
    }
    const before=calls.filter(call=>call.method==='lanpower/history/item/read').length;
    await page.locator('.lp-actions summary').click();await page.getByRole('button',{name:'刷新会话',exact:true}).click();
    await page.waitForTimeout(350);
    assert.equal(calls.filter(call=>call.method==='lanpower/history/item/read').length,before,'refresh retains already restored content');
    assert.equal(await page.locator('.native-image-toggle[aria-expanded="true"]').count(),imageActivities.length,'refresh preserves expanded previews');
    await page.locator('.lp-actions summary').click();
    const output=path.resolve(__dirname,'../private/codex-history-content/browser');fs.mkdirSync(output,{recursive:true});
    await page.locator(`[data-message-id="${final.id}"] .message-text`).filter({hasText:'我建议采用'}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'complete-1440.png'),animations:'disabled'});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'complete-390.png'),animations:'disabled'});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    // Updated packing keeps the short answer visible while each image restores automatically.
    legacy=false;holdChunk=true;
    await page.locator('.lp-back').click();
    await page.locator('[data-thread-id="other"] .lp-thread-title').click();await page.locator('[data-message-id="other-answer"]').waitFor();
    await page.locator('.lp-back').click();await page.locator('[data-thread-id="design"] .lp-thread-title').click();
    await page.locator(`[data-message-id="${final.id}"]`).waitFor();
    while(!releaseChunk)await page.waitForTimeout(20);
    await page.locator('.lp-back').click();await page.locator('[data-thread-id="other"] .lp-thread-title').click();
    releaseChunk();await page.locator('[data-message-id="other-answer"]').waitFor();await page.waitForTimeout(300);
    assert.equal(await page.locator(`[data-message-id="${final.id}"]`).count(),0,'late content stays out of another conversation');
    expireOnce=true;
    await page.locator('.lp-back').click();await page.locator('[data-thread-id="design"] .lp-thread-title').click();
    await page.locator(`[data-message-id="${final.id}"]`).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.lp-history-content').length===0,null,{timeout:45000});
    assert.equal(await page.locator('.conversation-item[data-message-type="imageView"]').count(),imageActivities.length-viewedActivities.length);
    assert.equal(await page.locator('.native-image-toggle[aria-expanded="true"]').count(),0,'switching conversations resets preview expansion');
    assert.ok(calls.some(call=>call.method==='thread/turns/list'),'refresh expired references automatically');
    assert.deepEqual(downloads,[]);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({nativePublicReplay:Boolean(process.env.LANPOWER_NATIVE_DESIGN_FIXTURE),completeReply:true,generatedImages:images.length,foldableImageActivities:imageActivities.length,compactPortraitPreview:true,originalImageModal:true,markdownImages:await markdownImages.count(),automaticChunkRead:true,reconnectResume:true,expiredReferenceRenewed:true,lateContentIsolation:true,refreshRetainsContent:true,widths:[1440,390,320],downloads:0,browserErrors:0}));
  } finally {adapter.dispose();await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
