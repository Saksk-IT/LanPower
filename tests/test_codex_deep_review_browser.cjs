// Isolated browser acceptance of R2–R6. All RPCs are fixtures; no native task is sent.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password = fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const calls = [], errors = [], root = 'D:/Projects/Review/Nested', archive = new Set();
  const metadata = i => ({id:`chat-${i}`,name:i===170?'未加载的目标聊天':`聊天 ${i}`,cwd:root,projectPath:root,projectName:'Nested',updatedAt:180-i,control:'shared',status:{type:'idle'},model:'gpt-6'});
  const entries = Array.from({length:180},(_,i)=>metadata(i));
  const history = Array.from({length:180},(_,i)=>({id:`turn-${i+1}`,status:'completed',items:[{id:`user-${i+1}`,type:'userMessage',content:[{type:'text',text:`用户 ${i+1}`}]},{id:`answer-${i+1}`,type:'agentMessage',phase:'final_answer',text:`回复 ${i+1}`}]}));
  const tools = [
    {id:'mcp',type:'mcpToolCall',server:'fixture-server',tool:'lookup',status:'completed',arguments:{query:'公开输入'},result:{text:'公开结果',encryptedContent:'private-fixture-secret'}},
    {id:'search',type:'webSearch',status:'inProgress',query:'公开搜索'},
    {id:'dynamic',type:'dynamicToolCall',tool:'fixture-tool',success:false,error:'公开错误'},
    {id:'collab',type:'collabAgentToolCall',status:'interrupted',receiverThreadIds:['child'],agentsStates:{child:'stopped'}},
    {id:'compact',type:'contextCompaction',status:'completed',content:'private-fixture-context'},
    {id:'future',type:'futureFixtureTool',status:'completed',text:'未来类型公开数据'},
  ];
  history[179].items.splice(1,0,...tools,{id:'photo',type:'userMessage',content:[{type:'localImage',path:'D:/Projects/Review/Nested/original.png'}]});
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=';
  const thread = id => ({...entries.find(t=>t.id===id),id,turns:history.slice(-8),historyCursor:'8',historyTailTurnId:'turn-180'});
  async function rpc(request) {
    calls.push(request); const p = request.params || {};
    switch (request.method) {
      case 'lanpower/status': return {result:{projects:[{name:'Review',path:'D:/Projects/Review'},{name:'Nested',path:root}],sharedControl:true,desktopControl:true,queueSupported:true,submissionReceipts:true,targetedHistoryActions:true,libraryCatalog:true,activeTurns:[],pendingApprovals:[],library:{revision:1,preferences:{collapsed:[],hidden:[],pinned:['chat-170'],order:[],aliases:{},sections:{},sort:'updated',chatsFirst:false}}}};
      case 'model/list': return {result:{data:[{id:'gpt-6',isDefault:true}]}};
      case 'collaborationMode/list': return {result:{data:[{mode:'default'}]}};
      case 'lanpower/library/list': {
        const rows=entries.filter(t=>archive.has(t.id)===!!p.archived && (!p.query || t.name.includes(p.query)));
        const offset=Number(p.cursor || 0);
        return {result:{data:rows.slice(offset,offset+50),nextCursor:offset+50<rows.length?String(offset+50):null,pinned:rows.filter(t=>t.id==='chat-170'),revision:1}};
      }
      case 'lanpower/library/check': return {result:{data:entries.filter(t=>p.threadIds.includes(t.id)&&archive.has(t.id)===!!p.archived),revision:1}};
      case 'lanpower/library/update': return {result:{revision:2,preferences:p.preferences}};
      case 'thread/read': return {result:{thread:thread(p.threadId)}};
      case 'thread/turns/list': {
        const offset=Number(p.cursor || 0),data=history.slice(Math.max(0,180-offset-p.limit),180-offset).reverse();
        return {result:{data,nextCursor:offset+p.limit<180?String(offset+p.limit):null}};
      }
      case 'thread/queue/list': return {result:{data:[]}};
      case 'lanpower/history/action': return {error:{code:-32000,message:'history_changed'}};
      case 'turn/start': return {error:{code:-32602,message:'params_not_allowed',data:{notSent:true}}};
      case 'lanpower/image/read': return {result:{contentType:'image/png',base64:png,size:Buffer.from(png,'base64').length}};
      default: return {result:{data:[]}};
    }
  }
  const browser=await chromium.launch({headless:true}), context=await browser.newContext({viewport:{width:1440,height:980},acceptDownloads:true});
  try {
    await context.exposeBinding('__reviewRpc',(_,request)=>rpc(request));
    await context.addInitScript(()=>{
      window.WebSocket=class {
        static OPEN=1;readyState=1;
        constructor(){window.__reviewSocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}
        frame(value){this.onmessage?.({data:JSON.stringify(value)});}
        async send(raw){const frame=JSON.parse(raw);if(frame.type!=='rpc')return;const request=frame.payload,reply=await window.__reviewRpc(request);this.frame({type:'rpc',payload:{id:request.id,...reply}});}
        close(){this.readyState=3;}
      };
    });
    const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
    page.on('console',message=>{if(message.type()==='error') console.error('Browser console:',message.text())});
    await page.goto(base+'/login'); await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('.lp-pinned-section [data-thread-id="chat-170"]').waitFor();
    assert.equal(calls.filter(c=>c.method==='thread/list').length,0);
    assert.equal(calls.filter(c=>c.method==='lanpower/library/list').length,1);
    await page.getByRole('button',{name:'搜索聊天和项目',exact:true}).click();
    await page.getByRole('textbox',{name:'搜索聊天和项目',exact:true}).fill('目标');
    await page.locator('[data-thread-id="chat-170"]').first().waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.lp-thread').length>0);
    await page.waitForTimeout(350);
    assert.ok(calls.some(c=>c.method==='lanpower/library/list'&&c.params.query==='目标'));
    await page.getByRole('button',{name:'清除搜索',exact:true}).click();
    await page.locator('[data-thread-id="chat-0"] .lp-thread-title').click();
    await page.locator('[data-message-id="answer-180"]').waitFor();
    await page.waitForFunction(()=>!document.querySelector('.thread-composer-input')?.disabled);
    const composer=page.locator('.thread-composer-input'), longText='中'.repeat(16001);
    await composer.fill(longText);await composer.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.lp-send-receipt')?.textContent.includes('发送失败'));
    assert.equal(await composer.inputValue(),longText); assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    assert.equal(calls.find(c=>c.method==='turn/start').params.input[0].text,longText);
    await composer.fill('Cloud 明确未发送的草稿');await composer.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.thread-composer-input')?.value==='Cloud 明确未发送的草稿' && document.querySelector('.lp-send-receipt')?.textContent.includes('发送失败'));
    assert.ok((await page.locator('.lp-feedback').textContent()).includes('未发送'));
    assert.equal(calls.filter(c=>c.method==='turn/start').length,2);
    assert.ok(!(await page.locator('.lp-send-receipt').textContent()).includes('待确认'));
    await composer.fill('');
    await page.locator('[data-message-id="worked:turn-180"] .turn-process-toggle').click();
    await page.locator('.native-activity-toggle').click();
    assert.equal(await page.locator('.native-web-search').getAttribute('data-status'),'completed');
    assert.ok((await page.locator('.native-web-search-toggle').textContent()).includes('已搜索网页：公开搜索'));
    for(const [kind,status] of [['MCP 工具','completed'],['动态工具','failed'],['协作任务','interrupted'],['上下文整理','completed'],['会话条目（futureFixtureTool）','completed']]) {
      const card=page.locator(`.lp-native-tool[data-tool-kind="${kind}"]`);await card.waitFor();assert.equal(await card.getAttribute('data-status'),status);
    }
    assert.ok((await page.locator('.lp-native-tool[data-tool-kind="MCP 工具"]').textContent()).includes('fixture-server / lookup'));
    await page.locator('.lp-native-tool[data-tool-kind="MCP 工具"] summary').click();
    assert.ok(!(await page.locator('.conversation-root').textContent()).includes('private-fixture'));
    const photo=page.locator('[data-message-id="photo"] .lp-remote-image');await photo.scrollIntoViewIfNeeded();await photo.click();
    await page.waitForFunction(()=>document.querySelector('.image-modal-image')?.naturalWidth>0);
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('.lp-original-image-download').click()]);
    assert.equal(download.suggestedFilename(),'original.png');
    const original=fs.readFileSync(await download.path());assert.deepEqual(original,Buffer.from(png,'base64'));await page.keyboard.press('Escape');
    const imageCalls=calls.filter(c=>c.method==='lanpower/image/read').length;
    await page.evaluate(()=>window.__reviewSocket.onclose?.({code:1006}));
    await page.waitForFunction(()=>document.querySelector('.lp-connection')?.textContent.includes('已连接'));
    await photo.scrollIntoViewIfNeeded();await photo.click();await page.waitForFunction(()=>document.querySelector('.image-modal-image')?.naturalWidth>0);
    assert.ok(calls.filter(c=>c.method==='lanpower/image/read').length>imageCalls);await page.keyboard.press('Escape');
    await page.locator('.lp-actions summary').click();await page.getByRole('button',{name:'跳至对话开头',exact:true}).click();
    await page.locator('[data-message-id="answer-1"]').waitFor();
    await page.locator('[data-message-id="answer-1"] .message-fork-button').click();
    await page.waitForTimeout(150);
    const fork=calls.find(c=>c.method==='lanpower/history/action'&&c.params.action==='fork');
    assert.deepEqual(fork.params,{threadId:'chat-0',turnId:'turn-1',expectedTailTurnId:'turn-180',action:'fork'});
    assert.equal(await page.locator('[data-message-id="answer-1"]').count(),1);
    await page.locator('[data-message-id="user-1"] .message-edit-button').click();await page.waitForTimeout(150);
    const rollback=calls.find(c=>c.method==='lanpower/history/action'&&c.params.action==='rollback');
    assert.deepEqual(rollback.params,{threadId:'chat-0',turnId:'turn-1',expectedTailTurnId:'turn-180',action:'rollback'});
    assert.equal(await page.locator('[data-message-id="answer-1"]').count(),1);
    assert.equal(calls.filter(c=>['thread/fork','thread/rollback'].includes(c.method)).length,0);
    // An external archive refresh checks older cached rows and preserves the current reading window.
    archive.add('chat-170');await page.evaluate(()=>window.__reviewSocket.frame({type:'rpc',payload:{method:'thread/archived',params:{threadId:'chat-170'}}}));
    await page.waitForFunction(()=>!document.querySelector('[data-thread-id="chat-170"]'));
    assert.ok(calls.some(c=>c.method==='lanpower/library/check'&&c.params.threadIds.includes('chat-170')));
    assert.equal(await page.locator('[data-message-id="answer-1"]').count(),1);
    archive.delete('chat-170');await page.evaluate(()=>window.__reviewSocket.frame({type:'rpc',payload:{method:'thread/unarchived',params:{threadId:'chat-170'}}}));
    await page.locator('.lp-pinned-section [data-thread-id="chat-170"]').waitFor();
    const output=path.resolve(__dirname,'../private/codex-first-six-1.18/browser');fs.mkdirSync(output,{recursive:true});
    for(const width of [1440,390,320]) {await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,`six-fixes-${width}.png`),animations:'disabled'});}
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({stableFirstTurnActions:true,concurrentRejectionPreservesWindow:true,invalidDraftPreserved:true,correlatedNotSent:true,publicToolKinds:6,unloadedPin:true,serverSearch:true,archiveRestoreReconciled:true,reconnectImage:true,originalDownloadBytes:true,widths:[1440,390,320],browserErrors:0}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
