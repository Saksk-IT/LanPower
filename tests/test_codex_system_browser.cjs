// Native RPC fixtures exercise the complete client workflow; real desktop checks are separate.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password = fs.readFileSync(path.resolve(__dirname,'../deploy/docker/private/dev-login.txt'),'utf8').match(/^Password: (.+)$/m)[1].trim();
  const browser = await chromium.launch({headless:true}), context = await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
  const output = path.resolve(__dirname,'../private/codex-remote-1.15/browser'); fs.mkdirSync(output,{recursive:true});
  const calls = [], errors = [], root = 'D:/Projects/Demo', longOutput = 'BEGIN\n' + 'full-output '.repeat(110000) + '\nEND';
  const turns = Array.from({length:180},(_,i) => ({id:'turn-'+i,status:'completed',items:[{id:'u-'+i,type:'userMessage',content:[{type:'text',text:i===0?'最早的人类消息':'第 '+i+' 轮'}]},{id:'a-'+i,type:'agentMessage',text:i===0?'最早的完整回复':'完整回复 '+i}]}));
  turns[179].items.push({id:'cmd-long',type:'commandExecution',command:'fixture-long-command',cwd:root,status:'completed',aggregatedOutput:longOutput,exitCode:0});
  turns[179].items[0].content.push({type:'localImage',path:'D:/Images/native.png'});
  let library = {revision:0,preferences:{collapsed:[],pinned:[],hidden:[],order:[],aliases:{},sections:{projects:true,chats:true,pinned:true},sort:'updated',chatsFirst:false}};
  const metadata = id => ({id,name:id==='native-long'?'原窗口长对话':id==='independent'?'独立聊天':'另一目录的同名项目',cwd:id==='independent'?'C:/Users/Test/Documents/Codex/2026-10-04/chat':id==='other'?'D:/Other/Demo':root,createdAt:1800000000,updatedAt:1800000001,status:{type:'idle'},control:'shared',model:'gpt-6.1-sol',reasoningEffort:'high',collaborationMode:{mode:'plan'}});
  function rpc(request) {
    calls.push(request); const p = request.params;
    switch(request.method) {
      case 'lanpower/status': return {projects:[{name:'Demo',path:root},{name:'Demo',path:'D:/Other/Demo'}],library,desktopControl:true,sharedControl:true,queueSupported:true,chatSupported:true,activeTurns:[],pendingApprovals:[]};
      case 'model/list': return {data:[{id:'gpt-6',isDefault:true},{id:'gpt-6.1-sol'}]};
      case 'collaborationMode/list': return {data:[{mode:'default'},{mode:'plan'}]};
      case 'thread/list': return {data:['native-long','other','independent'].map(metadata),nextCursor:null};
      case 'thread/read': return {thread:{...metadata(p.threadId),turns:turns.slice(-8),historyCursor:'8'}};
      case 'thread/turns/list': {const offset=Number(p.cursor || 0), limit=p.limit || 8, data=turns.slice(Math.max(0,180-offset-limit),180-offset).reverse();return {data,nextCursor:offset+limit<180?String(offset+limit):null};}
      case 'thread/queue/list': return {data:[]};
      case 'lanpower/library/update': if(p.revision!==library.revision)return {...library,conflict:true}; library={revision:library.revision+1,preferences:p.preferences};return library;
      case 'lanpower/image/read': return {contentType:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=',size:68};
      case 'lanpower/files/list': return {data:[{name:'README.md',path:'README.md',directory:false}],path:'.',branch:'main'};
      case 'lanpower/files/read': return {path:p.path,content:'来自被授权电脑的文件内容'};
      case 'skills/list': return {data:[{skills:[{name:'native-skill',path:'D:/Skills/native/SKILL.md',description:'原窗口可用技能',scope:'user',enabled:true}]}]};
      case 'plugin/list': return {marketplaces:[{name:'native',plugins:[{name:'native-plugin',id:'native-plugin',interface:{displayName:'原窗口插件'}}]}]};
      case 'mcpServerStatus/list': return {data:[{name:'native-mcp',authStatus:'OAuth',tools:[{name:'read',description:'读取工具'}]}]};
      case 'app/list': return {data:[{id:'native-app',name:'原窗口应用'}]};
      case 'turn/start': return {turn:{id:'fixture-new',status:'inProgress',items:[]}};
      default:return {};
    }
  }
  try {
    await context.exposeBinding('__nativeRpc',(_,request)=>rpc(request));
    await context.addInitScript(() => {
      window.WebSocket=class {
        static OPEN=1;readyState=1;
        constructor(){window.__fixtureSocket=this;setTimeout(()=>{this.onopen?.({});this.frame({type:'state',state:'runtime_ready'});},20);}
        frame(value){this.onmessage?.({data:JSON.stringify(value)});}
        async send(raw){const frame=JSON.parse(raw);if(frame.type!=='rpc')return;const request=frame.payload,result=await window.__nativeRpc(request),payload={id:request.id,result};
          const body=JSON.stringify(payload);if(body.length<1000000){this.frame({type:'rpc',payload});return;}
          const chunks=body.match(/[\s\S]{1,16000}/g);chunks.forEach((data,index)=>this.frame({type:'rpc_chunk',id:request.id,index,count:chunks.length,data}));}
        close(){this.readyState=3;setTimeout(()=>this.onclose?.({code:1000}),0);}
      };
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/login');await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'),page.locator('form[action="/login"] button').click()]);
    await page.goto(base+'/remote');await page.locator('[data-thread-id="native-long"] .lp-thread-title').click();
    await page.waitForFunction(()=>document.querySelector('.lp-chat-header h1')?.textContent==='原窗口长对话');
    await page.waitForFunction(()=>document.querySelector('.message-image-preview')?.naturalWidth===1);
    assert.equal(await page.locator('.lp-project').count(),2,'same-name project roots must stay separate');
    assert.ok((await page.locator('.lp-chats-section').textContent()).includes('独立聊天'));
    assert.ok((await page.locator('.thread-composer').textContent()).includes('GPT-6.1-sol'),'restore the native model');
    await page.locator('.lp-actions summary').click();await page.getByRole('button',{name:'跳至对话开头',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.conversation-root')?.textContent.includes('最早的完整回复'));
    assert.ok(calls.filter(c=>c.method==='thread/turns/list').length>=22,'read history beyond 128 turns');
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出完整会话',exact:true}).click();
    const downloaded=await downloadPromise, file=await downloaded.path(), exported=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(exported.turns.length,180);assert.equal(exported.turns[179].items.find(i=>i.id==='cmd-long').aggregatedOutput,longOutput);
    await page.locator('.lp-actions summary').click();
    await page.locator('.lp-project[data-project-path="D:/Other/Demo"] .lp-folder-toggle').click();
    await page.waitForFunction(()=>window.__fixtureSocket.readyState===1);await new Promise(resolve=>setTimeout(resolve,500));
    assert.ok(library.preferences.collapsed.includes('d:/other/demo'));
    await page.reload();await page.locator('[data-thread-id="native-long"] .lp-thread-title').waitFor();
    assert.equal(await page.locator('.lp-project[data-project-path="D:/Other/Demo"]').getAttribute('data-expanded'),'false','host preferences restore without local browser storage');
    await page.locator('[data-thread-id="native-long"] .lp-thread-title').click();
    await page.getByRole('button',{name:'浏览项目文件',exact:true}).click();await page.locator('.lp-files-list button').filter({hasText:'README.md'}).click();
    await page.waitForFunction(()=>document.querySelector('.lp-file-preview')?.textContent.includes('来自被授权电脑的文件内容'));await page.getByRole('button',{name:'关闭项目文件'}).click();
    await page.locator('.lp-feature-link').first().click();await page.getByRole('tab',{name:'插件',exact:true}).click();await page.getByRole('heading',{name:'原窗口插件'}).waitFor();
    await page.getByRole('tab',{name:'MCP',exact:true}).click();await page.getByRole('heading',{name:'native-mcp'}).waitFor();
    await page.getByRole('tab',{name:'技能',exact:true}).click();await page.getByRole('button',{name:'添加到聊天',exact:true}).click();
    await page.locator('.thread-composer-input').fill('调用原窗口技能');await page.locator('.thread-composer-input').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.lp-chat-status')?.textContent.includes('正在工作'));
    const sent=calls.find(c=>c.method==='turn/start');assert.ok(sent.params.input.some(i=>i.type==='skill'&&i.path==='D:/Skills/native/SKILL.md'));
    assert.equal(sent.params.model,'gpt-6.1-sol');assert.equal(sent.params.mode,'plan');
    await page.screenshot({path:path.join(output,'system-1440.png'),fullPage:true,animations:'disabled'});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({nativeHistoryTurns:180,longToolOutput:longOutput.length,hostLibraryRestored:true,sameNameProjectsSeparated:true,localImagePreview:true,authorizedFiles:true,nativeDirectories:true,nativeModelAndPlan:true,typedSkillInput:true,browserErrors:0}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
