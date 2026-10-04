// Controlled browser acceptance. No real native task is submitted by this fixture.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password = fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const browser = await chromium.launch({headless:true}), context = await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
  const calls = [], errors = [], root = 'D:/Projects/P0', receipts = new Map();
  const state = {revision:1,active:{},approvals:[],queue:[],loseReceipt:false,model:'gpt-6.1-sol'};
  const history = Array.from({length:180},(_,i)=>({id:'turn-'+i,status:'completed',items:[{id:'user-'+i,type:'userMessage',content:[{type:'text',text:'用户 '+i}]},{id:'answer-'+i,type:'agentMessage',text:i===0?'P0 最早回复':'完整回复 '+i,phase:'final_answer'}]}));
  const huge = JSON.stringify({id:'huge-item',type:'commandExecution',command:'fixture-long-command',status:'completed',aggregatedOutput:'开始🎨'+ 'x'.repeat(17*1048576)+'末尾',exitCode:0});
  history[178].items.push({id:'huge-item',type:'lanpowerLargeItem',reference:'huge',originalType:'commandExecution',characters:huge.length,bytes:Buffer.byteLength(huge),wholeTurn:false});
  const thread = id => ({id,name:id==='one'?'P0 会话一':'P0 会话二',cwd:root,control:'shared',model:id==='one'?state.model:'gpt-6.1-sol',reasoningEffort:'high',collaborationMode:{mode:'default'},status:{type:state.active[id]?'active':'idle'},turns:(id==='one'?history.slice(-8):[]).concat(state.active[id]?[{id:state.active[id],status:'inProgress',items:[]}]:[]),historyCursor:id==='one'?'8':null,lanpowerRevision:state.revision});
  let holdRead = false, heldRead = null, releaseRead;
  async function rpc(request) {
    calls.push(request); const p = request.params;
    if (!request.method) { state.approvals=[];state.revision++;return {events:[{method:'serverRequest/resolved',params:{threadId:'one',requestId:request.id,lanpowerRevision:state.revision}}]} }
    let result = {};
    switch(request.method) {
      case 'lanpower/status': result={projects:[{name:'P0',path:root}],sharedControl:true,desktopControl:true,queueSupported:true,submissionReceipts:true,largeHistory:true,activeTurns:Object.entries(state.active).map(([threadId,turnId])=>({threadId,turnId})),pendingApprovals:state.approvals,lanpowerRevision:state.revision};break;
      case 'model/list': result={data:[{id:'gpt-6',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{id:'gpt-6.1-sol',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]};break;
      case 'collaborationMode/list': result={data:[{mode:'default'},{mode:'plan'}]};break;
      case 'thread/list': result={data:['one','two'].map(thread),nextCursor:null};break;
      case 'thread/read': result={thread:thread(p.threadId)};if(holdRead){holdRead=false;heldRead=JSON.parse(JSON.stringify(result));await new Promise(resolve=>releaseRead=resolve);return {result:heldRead};}break;
      case 'thread/turns/list': {
        if (p.limit > 2) return {error:{code:-32000,message:'result_too_large'}};
        const offset=Number(p.cursor || 0),data=history.slice(Math.max(0,180-offset-p.limit),180-offset).reverse();result={data,nextCursor:offset+p.limit<180?String(offset+p.limit):null};break;
      }
      case 'lanpower/history/item/read': {let end=Math.min(huge.length,p.offset+65536);if(end<huge.length&&/[\uD800-\uDBFF]/.test(huge[end-1]))end--;result={offset:p.offset,data:huge.slice(p.offset,end),nextOffset:end<huge.length?end:null,characters:huge.length};break;}
      case 'thread/queue/list': result={data:state.queue};break;
      case 'lanpower/submission/read': result=receipts.get(p.submissionId)||{state:'unknown'};break;
      case 'turn/start': {
        const receipt = {submissionId:p.submissionId,state:'accepted',turnId:'accepted-turn'};receipts.set(p.submissionId,receipt);state.active[p.threadId]='accepted-turn';state.revision++;result={turn:{id:'accepted-turn',status:'inProgress'},receipt};
        if(state.loseReceipt){state.loseReceipt=false;return {disconnect:true};}break;
      }
      case 'turn/interrupt': if(p.turnId!==state.active[p.threadId])return {error:{code:-32000,message:'turn_changed'}};delete state.active[p.threadId];state.revision++;return {result:{},events:[{method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'},lanpowerRevision:state.revision}}]};
      case 'thread/queue/update': state.queue=state.queue.map(q=>q.id===p.queuedSubmissionId?{...q,input:p.input}:q);result={receipt:{state:'accepted'}};break;
      case 'thread/queue/delete': state.queue=state.queue.filter(q=>q.id!==p.queuedSubmissionId);break;
      case 'skills/list': result={data:[]};break;
    }
    return {result};
  }
  try {
    await context.exposeBinding('__p0Rpc',(_,request)=>rpc(request));
    await context.addInitScript(() => {
      window.WebSocket=class {
        static OPEN=1;readyState=1;
        constructor(){window.__p0Socket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}
        frame(value){this.onmessage?.({data:JSON.stringify(value)});}
        async send(raw){const frame=JSON.parse(raw);if(frame.type!=='rpc')return;const request=frame.payload,reply=await window.__p0Rpc(request);
          if(reply.disconnect){this.readyState=3;this.onclose?.({code:1006});return;}
          if(request.method)this.frame({type:'rpc',payload:{id:request.id,...(reply.error?{error:reply.error}:{result:reply.result})}});
          for(const event of reply.events||[])this.frame({type:'rpc',payload:event});}
        close(){this.readyState=3;}
      };
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(60000);
    const emit = payload => page.evaluate(p=>window.__p0Socket.frame({type:'rpc',payload:p}),payload);
    const select = async id => {await page.locator(`[data-thread-id="${id}"] .lp-thread-title`).click();await page.waitForFunction(()=>!document.querySelector('.thread-composer-input')?.disabled);};
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await select('one');
    await page.locator('.thread-composer .composer-dropdown-trigger').filter({hasText:'GPT-6.1-sol'}).click();await page.locator('.composer-dropdown-option').filter({hasText:/^GPT-6$/}).click();
    await page.locator('.thread-composer-input').fill('会话一内存草稿');
    const png = await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;const draw=canvas.getContext('2d');draw.fillStyle='#168ae0';draw.fillRect(0,0,8,8);return canvas.toDataURL('image/png').split(',')[1];});
    await page.locator('input[type=file]').first().setInputFiles({name:'tiny.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.locator('.thread-composer-attachment').waitFor();
    await select('two');assert.equal(await page.locator('.thread-composer-input').inputValue(),'');assert.equal(await page.locator('.thread-composer-attachment').count(),0);
    await page.locator('.thread-composer-input').fill('会话二草稿');await select('one');
    assert.equal(await page.locator('.thread-composer-input').inputValue(),'会话一内存草稿');assert.equal(await page.locator('.thread-composer-attachment').count(),1);
    state.model='gpt-6.1-sol';await emit({method:'thread/settings/updated',params:{threadId:'one',model:state.model,reasoningEffort:'medium',lanpowerRevision:++state.revision}});
    await page.locator('.lp-actions summary').click();await page.getByRole('button',{name:'刷新会话',exact:true}).click();await page.waitForTimeout(200);
    assert.ok((await page.locator('.thread-composer').textContent()).includes('GPT-6'));
    assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('会话一内存草稿')||v.includes('data:image/'))),false);
    await page.getByRole('button',{name:'采用原窗口参数'}).click();assert.ok((await page.locator('.thread-composer').textContent()).includes('GPT-6.1-sol'));
    state.active.one='new-turn';await emit({method:'turn/started',params:{threadId:'one',turn:{id:'new-turn',status:'inProgress'},lanpowerRevision:++state.revision}});
    await emit({method:'turn/completed',params:{threadId:'one',turn:{id:'old-turn',status:'completed'},lanpowerRevision:++state.revision}});
    assert.ok((await page.locator('.lp-chat-status').textContent()).includes('正在工作'));
    holdRead=true;await page.getByRole('button',{name:'刷新会话',exact:true}).click();while(!releaseRead)await page.waitForTimeout(20);
    state.active.one='newer-turn';await emit({method:'turn/started',params:{threadId:'one',turn:{id:'newer-turn',status:'inProgress'},lanpowerRevision:++state.revision}});releaseRead();await page.waitForTimeout(100);
    assert.ok((await page.locator('.lp-chat-status').textContent()).includes('正在工作'));
    const ended=state.active.one;delete state.active.one;await emit({method:'turn/completed',params:{threadId:'one',turn:{id:ended,status:'completed'},lanpowerRevision:++state.revision}});
    await page.waitForTimeout(800);state.loseReceipt=true;
    await page.locator('.thread-composer-input').fill('接受后断线验证');await page.locator('.thread-composer-input').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.lp-chat-status')?.textContent.includes('历史缓存'));
    await page.waitForFunction(()=>document.querySelector('.lp-send-receipt')?.textContent.includes('原窗口已接受'));
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);assert.ok(calls.some(c=>c.method==='lanpower/submission/read'));
    state.queue=[{id:'queue-one',input:[{type:'text',text:'排队草稿'}]}];await emit({method:'thread/queue/changed',params:{threadId:'one',lanpowerRevision:++state.revision}});await page.locator('.queued-row').waitFor();
    await page.locator('.queued-row-edit').click();await page.locator('.thread-composer-input').fill('修改后的队列');await select('two');await select('one');
    assert.equal(await page.locator('.thread-composer-input').inputValue(),'修改后的队列');assert.match(await page.locator('.lp-edit-queue').innerText(),/正在修改/);
    await page.locator('.thread-composer-input').press('Enter');await page.waitForFunction(()=>document.querySelector('.queued-row-text')?.textContent.includes('修改后的队列'));
    await page.locator('.queued-row-delete').click();await page.waitForFunction(()=>!document.querySelector('.queued-row'));
    const approval={id:'native-approval',method:'item/commandExecution/requestApproval',params:{threadId:'one',turnId:'accepted-turn',command:'fixture-only'}};
    state.approvals=[approval];await emit(approval);await page.locator('.thread-pending-request-primary').evaluate(button=>{button.click();button.click();});
    await page.waitForFunction(()=>!document.querySelector('.thread-pending-request-primary'));
    assert.equal(calls.filter(c=>!c.method&&c.id==='native-approval').length,1);
    await page.locator('.thread-composer-stop').click();await page.waitForFunction(()=>document.querySelector('.lp-chat-status')?.textContent.includes('当前无运行任务'));
    assert.equal(calls.find(c=>c.method==='turn/interrupt').params.turnId,'accepted-turn');
    await page.getByRole('button',{name:'跳至对话开头',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.conversation-root')?.textContent.includes('P0 最早回复'));
    assert.ok(calls.some(c=>c.method==='thread/turns/list'&&c.params.limit===2));
    assert.equal(await page.getByRole('button',{name:'导出完整会话',exact:true}).count(),0);
    await page.getByRole('button',{name:'返回最新消息',exact:true}).click();
    await page.locator('[data-message-id="answer-179"]').waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.lp-history-content').length===0,null,{timeout:90000});
    await page.locator('[data-message-id="worked:turn-178"] .turn-process-toggle').click();
    await page.locator('.native-activity-toggle').last().click();await page.locator('.native-command-toggle').last().click();
    assert.equal(await page.locator('.native-command-output').last().textContent(),JSON.parse(huge).aggregatedOutput);
    assert.deepEqual(errors,[]);
    const output=path.resolve(__dirname,'../private/codex-remote-p0/browser');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'p0-complete.png'),animations:'disabled'});
    console.log(JSON.stringify({draftAndImageIsolation:true,nativeSettingsPreserveChoice:true,staleEventsAndSnapshots:true,lostReceiptQueriedWithoutReplay:true,approvalOnce:true,queueRecovery:true,stopCorrectTurn:true,adaptiveHistory180:true,singleItemOver16MiB:true,automaticContentRestored:true,browserErrors:0}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
