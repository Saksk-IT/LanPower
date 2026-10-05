// Compiled WXML/WXSS rendered with a DOM adapter, not a WeChat device emulator.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..'), mini = process.env.MINI_PROGRAM_SOURCE_DIR || path.join(root, 'mini_program');
const compiler = process.env.WECHAT_COMPILER_DIR || 'D:/Soft/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const output = process.env.MINI_PROGRAM_UI_OUTPUT || path.join(root, 'private/mini-codex-ios'); fs.mkdirSync(output, {recursive: true});
for (const [file, args] of [['wcc.exe', ['-o', path.join(output, 'wxml.js'), 'pages/codex/codex.wxml']],
  ['wcsc.exe', ['-js', '-o', path.join(output, 'app-wxss.js'), 'app.wxss']],
  ['wcsc.exe', ['-js', '-o', path.join(output, 'codex-wxss.js'), 'pages/codex/codex.wxss']]]) execFileSync(path.join(compiler, file), args, {cwd: mini});
const modules = ['utils/version.js', 'utils/environment.js', 'utils/cloud-connectivity.js', 'utils/cloud.js', 'utils/codex-remote.js', 'utils/codex-format.js', 'utils/codex-fragments.js', 'utils/navigation.js', 'utils/device-selection.js', 'pages/codex/codex.js', ...fs.readdirSync(path.join(mini, 'utils/codex')).filter(file => file.endsWith('.js')).map(file => 'utils/codex/' + file)];
const sources = Object.fromEntries(modules.map(file => [file, fs.readFileSync(path.join(mini, file), 'utf8')]));

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const width of [320, 390, 430]) {
      const height = width === 320 ? 740 : width === 390 ? 844 : 932;
      const context = await browser.newContext({viewport: {width, height}, screen: {width, height}, deviceScaleFactor: 1});
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<style>html,body{margin:0;height:100%;overflow:hidden}wx-page,wx-view,wx-scroll-view,wx-rich-text{display:block}wx-text{white-space:inherit}wx-button{display:block;cursor:pointer;box-sizing:border-box;border:0;font-family:inherit;text-align:center}wx-button:not([size=mini]){margin-left:auto;margin-right:auto;width:184px}wx-input,wx-textarea{display:block}input,textarea{font-family:inherit;color:inherit;border:0;outline:0;background:transparent;font-size:inherit;width:100%;box-sizing:border-box;line-height:inherit}textarea{resize:none}wx-scroll-view{overflow-y:auto;width:100%}wx-picker{display:block}</style><wx-page><div id="preview"></div></wx-page>');
      await page.addScriptTag({content: fs.readFileSync(path.join(output, 'wxml.js'), 'utf8')});
      await page.evaluate(() => {window.__COMMON_STYLESHEETS__ = {}; window.__transformRpx__ = value => value * innerWidth / 750;});
      await page.addScriptTag({content: fs.readFileSync(path.join(output, 'app-wxss.js'), 'utf8')});
      await page.addScriptTag({content: fs.readFileSync(path.join(output, 'codex-wxss.js'), 'utf8')});
      await page.evaluate(({sources}) => {
        window.__webview_engine_version__ = 0.02;
        const modules = {}, load = name => {
          if (modules[name]) return modules[name].exports;
          const module = {exports: {}}; modules[name] = module;
          const require = relative => {
            const parts = name.split('/').slice(0, -1);
            for (const part of relative.split('/')) {if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);}
            return load(parts.join('/') + '.js');
          };
          new Function('require', 'module', 'exports', sources[name])(require, module, module.exports); return module.exports;
        };
        window.Page = definition => {window.crPage = {...definition, data: structuredClone(definition.data)};};
        const root = 'C:\\Fixture\\LanPower';
        const storage = new Map();
        window.wx = {getStorageSync: key => storage.get(key) || '', setStorageSync: (key, value) => storage.set(key, value), getAppBaseInfo: () => ({theme: 'light'}), setNavigationBarColor: () => {},
          redirectTo: () => {}, setClipboardData: options => options.success()};
        load('pages/codex/codex.js'); const model = window.crPage;
        function makeNode(node) {
          if (typeof node === 'string') return document.createTextNode(node);
          if (node.tag === 'virtual') {const fragment = document.createDocumentFragment(); for (const child of node.children || []) fragment.append(makeNode(child)); return fragment;}
          const element = document.createElement(node.tag || 'div'), attrs = node.attr || {};
          for (const [key, value] of Object.entries(attrs)) {
            if (key.startsWith('bind') || key.startsWith('catch')) continue;
            if (['nodes', 'range', 'value'].includes(key)) continue;
            if (typeof value === 'string' || typeof value === 'number') element.setAttribute(key === 'ariaLabel' ? 'aria-label' : key, value);
          }
          if (attrs.disabled) element.setAttribute('disabled', '');
          if (attrs.bindtap || attrs.catchtap) element.addEventListener('click', event => {
            if (element.hasAttribute('disabled')) return;
            if (attrs.catchtap) event.stopPropagation();
            const result = model[attrs.bindtap || attrs.catchtap]({currentTarget: element, detail: {}});
            if (result?.catch) result.catch(error => model.controller.notify(error.message));
          });
          if (attrs.bindlongpress) element.addEventListener('contextmenu', event => {event.preventDefault(); void model[attrs.bindlongpress]({currentTarget: element, detail: {}});});
          if (['wx-input', 'wx-textarea'].includes(node.tag)) {
            const input = document.createElement(node.tag === 'wx-input' ? 'input' : 'textarea');
            input.value = attrs.value || ''; input.placeholder = attrs.placeholder || ''; input.disabled = !!attrs.disabled;
            if (attrs.bindinput) input.addEventListener('input', () => model[attrs.bindinput]({currentTarget: element, detail: {value: input.value}})); element.append(input);
          } else if (node.tag === 'wx-slider') {
            const input = document.createElement('input'); input.type='range'; input.min=attrs.min; input.max=attrs.max; input.step=attrs.step; input.value=attrs.value; input.disabled=!!attrs.disabled;
            input.style.cssText='width:100%;height:32px;accent-color:#315ff5';
            for (const [event,handler] of [['input',attrs.bindchanging],['change',attrs.bindchange]]) if(handler) input.addEventListener(event,()=>model[handler]({detail:{value:Number(input.value)}})); element.append(input);
          } else if (node.tag === 'wx-image') {
            const img=document.createElement('img');img.src=attrs.src;img.style.cssText='display:block;width:100%;height:100%;object-fit:contain';element.append(img);
          } else if (node.tag === 'wx-rich-text') {
            const rich = nodes => nodes.map(n => {if (n.type === 'text') return document.createTextNode(n.text); const e = document.createElement(n.name); for (const [k, v] of Object.entries(n.attrs || {})) e.setAttribute(k, v); e.append(...rich(n.children || [])); return e;});
            element.append(...rich(attrs.nodes || []));
          } else for (const child of node.children || []) element.append(makeNode(child));
          if(node.tag==='wx-scroll-view' && attrs.bindscroll)element.addEventListener('scroll',()=>{
            if(!element.isConnected)return;
            const detail={scrollTop:element.scrollTop,scrollHeight:element.scrollHeight};model[attrs.bindscroll]({detail});
            if(element.scrollTop <= Number(attrs['upper-threshold']||50) && attrs.bindscrolltoupper)void model[attrs.bindscrolltoupper]();
            if(element.scrollHeight-element.scrollTop-element.clientHeight <= Number(attrs['lower-threshold']||50) && attrs.bindscrolltolower)void model[attrs.bindscrolltolower]();
          });
          return element;
        }
        const render = $gwx('pages/codex/codex.wxml');
        window.crRender = (changes={}) => {
          const old=document.querySelector('.cr-chat-scroll'),top=old?.scrollTop||0;
          document.querySelector('#preview').replaceChildren(makeNode(render(model.data, {})));
          const scroll=document.querySelector('.cr-chat-scroll');if(!scroll)return;
          scroll.scrollTop=Object.hasOwn(changes,'scrollTop')?model.data.scrollTop:top;
          if(Object.hasOwn(changes,'scrollTarget')&&model.data.scrollTarget){const target=document.getElementById(model.data.scrollTarget);if(target)scroll.scrollTop+=target.getBoundingClientRect().top-scroll.getBoundingClientRect().top;}
        };
        wx.nextTick=callback=>setTimeout(callback,0);
        wx.createSelectorQuery=()=>{
          const requests=[],query={in:()=>query,select:selector=>{query.selector=selector;query.all=false;return query;},selectAll:selector=>{query.selector=selector;query.all=true;return query;},
            boundingClientRect:()=>{requests.push({selector:query.selector,all:query.all,offset:false});return query;},scrollOffset:()=>{requests.push({selector:query.selector,all:false,offset:true});return query;},
            exec:callback=>queueMicrotask(()=>callback(requests.map(request=>{
              const value=element=>{if(!element)return null;if(request.offset)return {scrollTop:element.scrollTop};const r=element.getBoundingClientRect();return {id:element.id,top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
              return request.all?[...document.querySelectorAll(request.selector)].map(value):value(document.querySelector(request.selector));
            })))};return query;
        };
        model.setData = (changes, callback) => {
          if (new TextEncoder().encode(JSON.stringify(changes)).length >= 1048576) throw new Error('setData 超过 1 MiB');
          let changed=false;
          for (const [key, value] of Object.entries(changes)) {
            const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let object = model.data;
            for (const part of parts.slice(0, -1)) object = object[part];if(JSON.stringify(object[parts.at(-1)])!==JSON.stringify(value))changed=true;object[parts.at(-1)] = value;
          }
          if(changed)window.crRender(changes);
          if(callback)queueMicrotask(callback);
        };
        model.onLoad(); model.follow = true; model.visible = true;
        const c = model.controller; c.state = 'runtime_ready'; c.deviceId = 'pc-a'; c.sharedControl = true; c.desktopControl = true; c.queueSupported = true; c.chatSupported = true; c.planSupported = true;
        c.projects = [{name: 'LanPower', path: root}, {name:'Study',path:'D:/Fixture/Study'}]; c.threads = [
          {id: 'a', name: '优化小程序布局', projectName: 'LanPower', cwd: root, control: 'remote', updatedAt: Date.now()/1000},
          {id: 'b', name: '检查连接状态', projectName: 'LanPower', cwd: root, updatedAt: Date.now()/1000-1080},
          {id: 'c', name: '整理项目文档', projectName: 'LanPower', cwd: root, updatedAt: Date.now()/1000-3600},
          {id:'chat',name:'规划下一个想法',cwd:'',isChat:true,updatedAt:Date.now()/1000-1000}];
        c.models = [{id:'gpt-5.4',displayName:'GPT-5.4',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}],isDefault:true}]; c.library.preferences.pinned=['b'];
        model.setData({authorized: true, ready: true, state: 'runtime_ready', devices: [{device_id: 'pc-a', name: '开发电脑'}],
          deviceId: 'pc-a', deviceName: '开发电脑'}); model.loadHomePreferences(); model.paint();
        window.crShowChat = () => {
          c.threadId='a'; c.current={...c.threads[0],model:'gpt-5.4',turns:[{id:'first',status:'completed',durationMs:38000,items:[
            {id:'user',type:'userMessage',content:[{type:'text',text:'把 Codex 页面做得更简洁一些'}]},
            {id:'process',type:'agentMessage',phase:'commentary',text:'我会先整理会话和输入区域，让页面更接近原生应用。'},
            {id:'command',type:'commandExecution',command:'node tests/check-layout.js',status:'completed',exitCode:0,aggregatedOutput:'布局检查通过'},
            {id:'files',type:'fileChange',changes:[{path:'mini_program/pages/codex/codex.wxml',diff:'+ 新的布局'}]},
            {id:'answer',type:'agentMessage',phase:'final_answer',text:'**已完成界面重构**\n\n项目与独立聊天分别展示，输入区域保持固定，完整历史可以继续读取。'}]}]};
          c.observeThread(c.current); model.setData({view:'chat'}); model.paint();
        };
        window.crShowRunning=()=>{crShowChat();c.current.turns.push({id:'running',status:'inProgress',startedAt:Date.now()-38000,items:[{id:'running-user',type:'userMessage',content:[{type:'text',text:'检查运行状态'}]},{id:'running-comment',type:'agentMessage',phase:'commentary',text:'开始检查工作记录。'}]});c.activeTurns.set('a','running');c.overlay={label:'正在运行命令',plan:[],error:''};c.queue=[{id:'q1',input:[{type:'text',text:'完成后再检查深色模式'}]}];model.paint();};
        window.crShowCatalog=()=>{c.resources.catalog={kind:'skill',cwd:root,loading:false,error:'',rows:[{name:'项目检查',path:root+'/skills/check',description:'检查项目布局和会话控制逻辑',enabled:true,scope:'project'}]};model.setData({view:'catalog',catalogKind:'skill'});model.paint();};
        window.crShowFiles=()=>{c.resources.state={cwd:root,directory:'.',branch:'main',files:[{name:'README.md',path:'README.md',directory:false},{name:'mini_program',path:'mini_program',directory:true}],cursor:'',query:'',selected:null,loading:false,error:'',truncated:false};model.setData({view:'files'});model.paint();};
        window.crShowImages=()=>{crShowChat();c.current.turns[0].items.splice(1,0,{id:'view-image',type:'imageView',path:root+'/portrait.png'},{id:'generate-image',type:'imageGeneration',result:'data:image/png;base64,fixture'});window.crImageReads=0;window.crImageOpened=[];model.images.resolve=async()=>{window.crImageReads++;return '/fixture/portrait.png';};model.images.peek=()=>'/fixture/portrait.png';wx.previewImage=value=>window.crImageOpened.push(value);model.paint();};
      }, {sources});

      await page.evaluate(() => {
        const c=crPage.controller, root='C:/Fixture/Project';
        c.models=[{id:'gpt-6.1-sol',displayName:'6.1 Sol',defaultReasoningEffort:'max',supportedReasoningEfforts:['minimal','low','medium','high','xhigh','max'].map(reasoningEffort=>({reasoningEffort}))},{id:'gpt-6-astra',displayName:'6 Astra',defaultReasoningEffort:'high',supportedReasoningEfforts:['medium','high'].map(reasoningEffort=>({reasoningEffort}))}];
        c.permissionsSupported=true;c.reconcile=()=>{};
        window.crResetConversation=()=>{
          c.resetHistory();c.threadId='a';c.current={id:'a',name:'完善会话页面的交互',cwd:root,model:'gpt-6.1-sol',reasoningEffort:'max',control:'remote',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'},turns:[{id:'running',status:'inProgress',startedAt:Date.now()-447000,items:[
            {id:'user',type:'userMessage',content:[{type:'text',text:'参照原生会话页面，完善操作与展示。'}]},
            {id:'comment1',type:'agentMessage',phase:'commentary',text:'我会先核对界面和文档状态，再补齐交互与验证。'},
            ...['README.md','conversation.js','codex.wxml'].map((name,index)=>({id:'read'+index,type:'commandExecution',command:'读取 '+name,commandActions:[{type:'read',name}],status:'completed',exitCode:0,aggregatedOutput:'文件内容已读取。'})),
            {id:'comment2',type:'agentMessage',phase:'commentary',text:'布局和连接检查已通过，继续完善模型选择、批准状态与文件对话框。'},
            ...['检查状态','检查布局','检查文件'].map((name,index)=>({id:'command'+index,type:'commandExecution',command:'node '+name+'.js',status:'completed',exitCode:0,aggregatedOutput:'验证通过。\n完整输出保留在此条目。'})),
            {id:'compact',type:'contextCompaction'},
            {id:'comment3',type:'agentMessage',phase:'commentary',text:'我继续完成收尾：核对改动，更新文档，重跑必要验证，最后提交本轮改动。'},
            {id:'reasoning',type:'reasoning',summary:['Planning README and verification updates','先检查公开的验证记录，再更新文档。']},
            {id:'files',type:'fileChange',status:'completed',changes:[{path:'mini_program/pages/codex/codex.wxml',kind:'update',diff:'-旧布局\n+新的会话布局\n+模型面板'},{path:'mini_program/pages/codex/codex.wxss',kind:'update',diff:'+新增弹窗样式'}]},
            {id:'image',type:'imageGeneration',result:'data:image/png;base64,fixture'}]}]};
          c.threadSettings.overrides={};c.observeThread(c.current);c.activeTurns.set('a','running');c.overlay={label:'正在思考',plan:[{step:'完善交互',status:'completed'},{step:'验证布局与状态',status:'inProgress'}],error:''};c.queue=[];c.approvals.clear();
          crPage.setData({view:'chat',sheet:'',prompt:'',draftImages:[],draftFiles:[],keyboardHeight:0,progressOpen:false,inputFocused:false});crPage.paint();
        };
        crPage.connection.request=async(method,params)=>{
          if(method==='lanpower/permissions/set')return {thread:{id:params.threadId,model:'gpt-6.1-sol',approvalPolicy:params.permissionMode==='full-access'?'never':'on-request',approvalsReviewer:params.permissionMode==='auto-review'?'auto_review':'user',sandbox:params.permissionMode==='full-access'?{type:'dangerFullAccess'}:{type:'workspaceWrite',networkAccess:false,writableRoots:[root]}}};
          if(method==='lanpower/files/read')return {path:params.path,content:'# 项目说明\n\n这是用于验证文件预览的公开测试内容。'};
          return {data:[{name:'mini_program',path:'mini_program',directory:true},{name:'README.md',path:'README.md',directory:false},{name:'conversation.js',path:'conversation.js',directory:false}],branch:'main',nextCursor:null};
        };
        const canvas=document.createElement('canvas');canvas.width=240;canvas.height=500;const ctx=canvas.getContext('2d');ctx.fillStyle='#eef3ff';ctx.fillRect(0,0,240,500);ctx.fillStyle='#315ff5';ctx.font='24px sans-serif';ctx.fillText('示例图片',64,180);ctx.fillRect(32,220,176,3);ctx.fillStyle='#7494ec';ctx.fillRect(48,260,144,140);
        window.crFixtureImage=canvas.toDataURL('image/png');const cache=new Map();window.crImageOpened=[];window.crImageReads=0;crPage.images.resolve=async source=>{if(!cache.has(source)){crImageReads++;cache.set(source,crFixtureImage);}return cache.get(source);};crPage.images.peek=source=>cache.get(source)||'';wx.previewImage=value=>crImageOpened.push(value);wx.showModal=options=>options.success({confirm:true});wx.setClipboardData=options=>{window.crCopied=options.data;options.success();};
        crResetConversation();
      });
      async function geometry(name) {
        await page.screenshot({path:path.join(output,name+'-'+width+'.png')});
        const measure=await page.evaluate(()=>{
          const bounds=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
          return {overflow:document.documentElement.scrollWidth-innerWidth,page:bounds(document.querySelector('.codex-page')),composer:bounds(document.querySelector('.cr-composer')),panel:document.querySelector('.cr-sheet')?bounds(document.querySelector('.cr-sheet')):null,scroll:bounds(document.querySelector('.cr-chat-scroll')),buttons:[...document.querySelectorAll('wx-button')].map(e=>({name:e.className,...bounds(e)})).filter(r=>r.width>0&&r.height>0&&(r.left< -1||r.right>innerWidth+1))};
        });
        assert.ok(measure.overflow<=1,name+JSON.stringify(measure));assert.ok(measure.scroll.height>60,name+JSON.stringify(measure));assert.deepEqual(measure.buttons,[],name+JSON.stringify(measure));assert.ok(measure.composer.bottom<=measure.page.bottom+1,name+JSON.stringify(measure));
        if(measure.panel){assert.ok(measure.panel.top>=measure.page.top-1,name+JSON.stringify(measure));assert.ok(measure.panel.bottom<=measure.page.bottom+1,name+JSON.stringify(measure));}
      }
      await geometry('conversation');
      const chatHeight=await page.locator('.cr-chat-scroll').evaluate(e=>e.clientHeight);
      await page.evaluate(()=>crPage.setData({showJump:true}));assert.equal(await page.locator('.cr-chat-scroll').evaluate(e=>e.clientHeight),chatHeight,'悬浮按钮不得改变聊天区域高度');await page.evaluate(()=>crPage.setData({showJump:false}));
      assert.equal(await page.locator('.cr-model-pill').count(),0,'输入框上方不应再显示模型与强度');
      const bubble=await page.evaluate(()=>{const area=document.querySelector('.cr-composer-area'),pill=document.querySelector('.cr-changes-pill'),scroll=document.querySelector('.cr-chat-scroll');return {background:getComputedStyle(area).backgroundColor,pointerEvents:getComputedStyle(area).pointerEvents,overlaps:scroll.getBoundingClientRect().bottom>pill.getBoundingClientRect().bottom};});
      assert.equal(bubble.background,'rgba(0, 0, 0, 0)','文件气泡外层必须透明');assert.equal(bubble.pointerEvents,'none','气泡外围应允许正文触摸滚动');assert.equal(bubble.overlaps,true,'正文应延伸至悬浮气泡后方');
      assert.equal(await page.locator('.cr-activity-detail').count(),0);assert.equal(await page.locator('.cr-reasoning-detail').count(),0);assert.equal(await page.locator('.cr-image-previews').count(),0);
      await page.locator('.cr-activity-group').first().click();assert.equal(await page.locator('.cr-message-activity').count(),3);await page.locator('.cr-activity-toggle').first().click();assert.equal(await page.locator('.cr-activity-detail').count(),1);assert.ok((await page.locator('.cr-activity-detail').textContent()).includes('文件内容已读取'));await geometry('command-expanded');
      await page.locator('.cr-reasoning-toggle').click();assert.equal(await page.locator('.cr-reasoning-detail').count(),1);await page.locator('.cr-image-toggle').click();assert.equal(await page.evaluate(()=>crImageReads),1);await page.locator('.cr-image-button').click();assert.equal(await page.evaluate(()=>crImageOpened.length),1);
      await page.locator('.cr-live').click();assert.equal(await page.locator('.cr-live-work .cr-plan').count(),1);await geometry('work-expanded');
      await page.evaluate(()=>crResetConversation());await page.locator('.cr-context-button').click();await geometry('advanced');
      await page.locator('.cr-advanced-row[data-kind=models]').click();assert.equal(await page.locator('.cr-model-option').count(),2);await geometry('models');
      await page.locator('.cr-model-option[data-value="gpt-6-astra"]').click();assert.equal(await page.evaluate(()=>crPage.data.selectedEffort),'high');assert.equal(await page.evaluate(()=>crPage.data.efforts.length),2);
      await page.locator('.cr-advanced-row[data-kind=models]').click();await page.locator('.cr-model-option[data-value="gpt-6.1-sol"]').click();await page.locator('.cr-advanced-row[data-kind=effort]').click();assert.equal(await page.locator('.cr-effort-dot').count(),6);await page.locator('.cr-effort-dot[data-value=high]').click();assert.equal(await page.evaluate(()=>crPage.data.selectedEffort),'high');await geometry('effort');
      await page.evaluate(()=>{crPage.closeSheet();crPage.inputFocus();crPage.keyboard({detail:{height:290}});});await geometry('keyboard');
      await page.locator('.cr-permission-button').click();assert.ok((await page.locator('.cr-permission-row').allTextContents()).some(text=>text.includes('完全访问')));await geometry('permissions-keyboard');
      await page.locator('.cr-permission-row[data-value=ask]').click();assert.equal(await page.evaluate(()=>crPage.data.selectedPermission),'ask');await page.locator('.cr-permission-row[data-value="full-access"]').click();assert.equal(await page.evaluate(()=>crPage.data.selectedPermission),'full-access');
      await page.evaluate(()=>{crPage.closeSheet();crPage.dismissFeedback();crPage.keyboard({detail:{height:0}});});await page.locator('.cr-permission-button').click();await geometry('permissions');
      await page.evaluate(()=>{crPage.closeSheet();crPage.openAttachments();});await geometry('attachments');assert.equal(await page.locator('.cr-attachment-menu-row[data-source=camera]').count(),1);assert.equal(await page.locator('.cr-attachment-menu-row[data-source=album]').count(),1);
      await page.evaluate(()=>crPage.openFileSheet());await page.locator('.cr-sheet-files .cr-file-row').first().waitFor({state:'visible'});await geometry('files');assert.equal(await page.locator('.cr-sheet-files .cr-file-row').count(),3);await page.locator('.cr-sheet-files .cr-file-row[data-path="README.md"]').click();await page.locator('.cr-file-content').waitFor({state:'visible'});assert.ok((await page.locator('.cr-file-content').textContent()).includes('项目说明'));await geometry('file-preview');await page.locator('.cr-file-preview .cr-primary').click();assert.equal(await page.evaluate(()=>crPage.controller.draft.files.length),1);assert.equal(await page.evaluate(()=>crPage.data.sheet),'');
      await page.evaluate(()=>{crPage.controller.draft.files=[];crPage.paint();crPage.openMenu();});await geometry('menu');assert.equal(await page.locator('.cr-chat-menu-row').filter({hasText:'复制对话串 ID'}).count(),1);await page.locator('.cr-chat-menu-row').filter({hasText:'复制对话串 ID'}).click();assert.equal(await page.evaluate(()=>crCopied),'a');
      await page.evaluate(()=>{crPage.dismissFeedback();crPage.openChanges();});await geometry('changes');assert.equal(await page.locator('.cr-change-file').count(),2);await page.locator('.cr-change-file').first().click();assert.ok((await page.locator('.cr-detail-text').textContent()).includes('新的会话布局'));await geometry('diff');
      await page.evaluate(()=>{crPage.closeSheet();crPage.openStatus();});await geometry('status');assert.ok((await page.locator('.cr-sheet-status').textContent()).includes('上下文'));
      await page.evaluate(()=>{
        const c=crPage.controller;c.resetHistory();c.activeTurns.clear();crPage.follow=false;
        c.current.turns=[{id:'attachment-turn',status:'completed',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'# Files mentioned by the user:\n\n'+Array.from({length:4},(_,i)=>'## image-'+i+'.png:\nC:/Fixture/image-'+i+'.png\nImage attachment: true').join('\n\n')+'\n\n## My request:\n我的请求：查看这四张图片。'}]}]}];crPage.setData({sheet:'',keyboardHeight:0,inputFocused:false});crPage.paint();
      });
      await page.waitForFunction(()=>crPage.data.messages.find(row=>row.kind==='user').images.every(image=>image.src));
      assert.equal(await page.locator('.cr-message-user .cr-image-button').count(),4);assert.equal(await page.locator('.cr-message-user .cr-image-toggle').count(),0);assert.ok(!(await page.locator('.cr-message-user').textContent()).includes('Files mentioned'));
      const thumbnails=await page.locator('.cr-message-user .cr-image-button').evaluateAll(elements=>elements.map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,fit:e.querySelector('wx-image')?.getAttribute('mode')})));
      assert.ok(thumbnails.every(image=>image.width<=140.5&&image.height<=140.5&&image.fit==='aspectFit'));await geometry('user-thumbnails');
      await page.locator('.cr-message-user .cr-image-button').nth(1).click();assert.equal(await page.evaluate(()=>crImageOpened.at(-1).urls.length),4);
      await page.locator('.cr-context-button').click();assert.equal(await page.evaluate(()=>crPage.data.sheet),'options');
      await page.locator('.cr-effort-slider input').evaluate(input=>{input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await page.evaluate(()=>crPage.data.selectedEffort),'high');await geometry('ring-model-strength');
      await page.evaluate(()=>{crPage.closeSheet();crResetConversation();});
      const group=page.locator('.cr-activity-group').first();await group.scrollIntoViewIfNeeded();const groupTop=await group.evaluate(e=>e.getBoundingClientRect().top);
      await group.click();await page.waitForFunction(()=>!crPage.chatUpdating);assert.ok(Math.abs(await group.evaluate(e=>e.getBoundingClientRect().top)-groupTop)<=2,'展开活动应保持标题位置');
      assert.ok(await page.locator('.cr-message-activity').first().evaluate((e,top)=>e.getBoundingClientRect().top>top,groupTop));await geometry('downward-expansion');
      await page.evaluate(()=>{
        const c=crPage.controller;c.resetHistory();c.activeTurns.clear();c.current.turns=Array.from({length:100},(_,i)=>({id:'history-'+i,status:'completed',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'第 '+i+' 个任务'}]},{id:'reply',type:'agentMessage',phase:'final_answer',text:'第 '+i+' 个任务已完成，完整内容保留。'}]}));crPage.follow=true;crPage.setData({sheet:''});crPage.paint();
      });
      await page.waitForFunction(()=>!crPage.chatUpdating&&!crPage.composerMeasuring&&Math.abs(crPage.lastScrollTop-document.querySelector('.cr-chat-scroll').scrollTop)<2);
      const historyStart=await page.evaluate(()=>crPage.data.windowStart);
      const upperAnchor=await page.evaluate(()=>{const scroll=document.querySelector('.cr-chat-scroll');scroll.scrollTop=20;const viewport=scroll.getBoundingClientRect(),row=[...document.querySelectorAll('.cr-message')].find(row=>row.getBoundingClientRect().bottom>viewport.top+1),anchor={id:row.id,top:row.getBoundingClientRect().top-viewport.top};scroll.dispatchEvent(new Event('scroll'));return anchor;});
      await page.waitForFunction(start=>crPage.data.windowStart<start&&!crPage.chatUpdating,historyStart);
      const anchorTop=await page.evaluate(id=>document.getElementById(id).getBoundingClientRect().top-document.querySelector('.cr-chat-scroll').getBoundingClientRect().top,upperAnchor.id);assert.ok(Math.abs(anchorTop-upperAnchor.top)<=2,'向上加载应保持阅读位置');
      const retained=await page.evaluate(()=>({start:crPage.data.windowStart,end:crPage.data.windowEnd,keys:crPage.data.messages.map(row=>row.key)}));
      await page.evaluate(()=>crPage.reachedBottom());assert.equal(await page.evaluate(()=>crPage.data.windowStart),retained.start,'定位产生的底部事件不能读回后续页');assert.equal(await page.evaluate(()=>crPage.follow),false);
      await page.evaluate(()=>{const scroll=document.querySelector('.cr-chat-scroll');scroll.scrollTop=scroll.scrollHeight-scroll.clientHeight-20;scroll.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(()=>crPage.follow&&!crPage.chatUpdating).catch(async error=>{console.error(await page.evaluate(()=>{const s=document.querySelector('.cr-chat-scroll');return {follow:crPage.follow,intent:crPage.scrollIntent,expected:crPage.expectedScrollTop,last:crPage.lastScrollTop,top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,after:crPage.data.hasWindowAfter,start:crPage.data.windowStart,end:crPage.data.windowEnd,updating:!!crPage.chatUpdating};}));throw error;});
      assert.deepEqual(await page.evaluate(()=>crPage.data.messages.map(row=>row.key)),retained.keys,'上下阅读不应删除原来渲染的尾部');
      assert.equal(await page.locator('.cr-chat-scroll .cr-load-more').count(),0);await geometry('automatic-history');
      await page.evaluate(()=>{
        const c=crPage.controller;c.resetHistory();c.activeTurns.set('a','reference');c.overlay={label:'正在思考',plan:[],error:''};crPage.follow=false;
        const command=(id,exitCode=0)=>({id,type:'commandExecution',status:'completed',command:'check public-fixture',aggregatedOutput:'检查完成',exitCode});
        const files=id=>({id,type:'fileChange',status:'completed',changes:[{path:'public-fixture.md',diff:'+校验记录'}]});
        c.current.turns=[{id:'reference',status:'inProgress',items:[{id:'intro',type:'agentMessage',phase:'commentary',text:'我会对照原版聊天页面核对资源，检查脚本和样式是否一致。'},files('file1'),command('cmd1'),{id:'image1',type:'imageView',path:'C:/Fixture/reference1.png'},{id:'image2',type:'imageView',path:'C:/Fixture/reference2.png'},command('cmd2'),{id:'middle',type:'agentMessage',phase:'commentary',text:'资源和界面检查已完成。输入框、按钮、命令图标与手机宽度的显示均已核对。'},files('file2'),command('failed',1),{id:'result',type:'agentMessage',phase:'commentary',text:'继续核对聊天页面的实际显示，确认折叠状态和阅读位置保持稳定。'},command('cmd3'),{id:'image3',type:'imageView',path:'C:/Fixture/reference3.png'},files('file3'),command('cmd4')]}];crPage.paint();
      });
      assert.deepEqual(await page.locator('.cr-activity-group').allTextContents(),['编辑了文件，运行了命令','运行了命令','编辑了文件，运行了命令含失败命令','运行了命令','编辑了文件，运行了命令']);
      assert.equal(await page.locator('.cr-image-toggle').count(),3);assert.equal(await page.locator('.cr-native-images').count(),3);assert.equal(await page.locator('.cr-live-label').textContent(),'正在思考');
      assert.equal(await page.locator('.cr-work-summary').count(),0);assert.equal(await page.locator('.cr-activity-detail,.cr-image-previews').count(),0);
      const chevrons=await page.locator('.cr-activity-group').evaluateAll(rows=>rows.map(row=>{const label=row.querySelector('.cr-row-label').getBoundingClientRect(),chevron=row.querySelector('.cr-native-chevron').getBoundingClientRect();return chevron.left-label.right;}));assert.ok(chevrons.filter((_,index)=>index!==2).every(gap=>gap>=7&&gap<=10),'折叠箭头应紧随摘要文字：'+JSON.stringify({width,chevrons}));
      await geometry('web-reference-collapsed');
      await page.evaluate(()=>{
        const c=crPage.controller;c.resetHistory();crPage.follow=false;
        const command=id=>({id,type:'commandExecution',command:'check public-fixture',status:'completed',exitCode:0,aggregatedOutput:'完整输出末尾'});
        c.current.turns=[{id:'web-native',status:'inProgress',items:[command('c0'),command('c1'),{id:'web',type:'webSearch',status:'completed',action:{type:'search',queries:['公开网页查询与本地开发问题 '.repeat(12),'site:example.com/docs']}},...Array.from({length:12},(_,i)=>command('c'+(i+2))),{id:'open',type:'webSearch',action:{type:'openPage',url:'https://example.com/docs/network/very-long-public-page'}}]}];crPage.paint();
      });
      assert.equal(await page.locator('.cr-activity-group').count(),1);assert.equal(await page.locator('.cr-activity-group').textContent(),'运行了命令，已搜索网页');
      await page.locator('.cr-activity-group').click();assert.equal(await page.locator('.cr-native-globe').count(),2);
      const webLayout=await page.evaluate(()=>{const list=document.querySelector('.cr-activity-list'),label=document.querySelector('.cr-web-search .cr-row-label');return {height:list.clientHeight,scrollHeight:list.scrollHeight,ellipsis:getComputedStyle(label).textOverflow,nowrap:getComputedStyle(label).whiteSpace,long:label.scrollWidth>label.clientWidth};});
      assert.ok(webLayout.height<=272&&webLayout.scrollHeight>webLayout.height);assert.equal(webLayout.ellipsis,'ellipsis');assert.equal(webLayout.nowrap,'nowrap');assert.equal(webLayout.long,true);
      const outerScroll=await page.locator('.cr-chat-scroll').evaluate(element=>element.scrollTop);await page.locator('.cr-activity-list').evaluate(element=>element.scrollTop=element.scrollHeight);assert.equal(await page.locator('.cr-chat-scroll').evaluate(element=>element.scrollTop),outerScroll);
      await page.locator('.cr-activity-list').evaluate(element=>element.scrollTop=0);await geometry('native-web-search');
      await page.locator('.cr-web-search .cr-activity-toggle').first().click();assert.ok((await page.locator('.cr-web-search .cr-output').first().textContent()).includes('site:example.com/docs'));
      await page.evaluate(()=>crPage.changeTheme({currentTarget:{dataset:{value:'dark'}}}));await geometry('native-web-search-dark');
      await page.evaluate(()=>{
        const c=crPage.controller;c.resetHistory();c.activeTurns.clear();crPage.follow=false;
        const text='【GPT-6】已完成聊天阅读修复，小程序升级到 **3.6.6**。\n\n- 修复上滑与历史换页跳动，展开详情时保持阅读位置。'.repeat(3)+'\n- 命令、文件、思考和图片沿用原生分组，默认收起，完整详情保留。\n\n重新编译现有目录，或导入小程序包（D:/Projects/Example/windows/out/Example-mini-program-3.6.6.zip）。改动说明与预览（D:/Projects/Example/docs/very-long-public-conversation-layout-and-text-wrapping-document.md）已更新。\n\n完整标识：`'+ 'abcdef0123456789'.repeat(8)+'`\n\n| 项目 | 结果 |\n| --- | --- |\n| 长网址 | https://example.com/docs/'+ 'long-public-path-'.repeat(10)+' |\n\n```\n'+ '完整代码输出'.repeat(35)+'\n```';
        c.current.turns=[{id:'reading',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text}]}];crPage.changeTheme({currentTarget:{dataset:{value:'light'}}});crPage.paint();
      });
      const assertReader = async () => {
        const bounds=await page.evaluate(()=>{
          const scroll=document.querySelector('.cr-chat-scroll').getBoundingClientRect(),reader=document.querySelector('.cr-markdown'),box=reader.getBoundingClientRect(),walker=document.createTreeWalker(reader,NodeFilter.SHOW_TEXT),bad=[];
          while(walker.nextNode()){if(!walker.currentNode.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);for(const r of range.getClientRects())if(r.width>0&&(r.left<box.left-1||r.right>box.right+1))bad.push({text:walker.currentNode.textContent.slice(0,25),left:r.left,right:r.right});}
          return {scrollLeft:scroll.left,scrollRight:scroll.right,left:box.left,right:box.right,overflow:reader.scrollWidth-reader.clientWidth,bad};
        });
        assert.ok(bounds.scrollLeft>=-1&&bounds.scrollRight<=width+1,JSON.stringify(bounds));assert.ok(bounds.left>=15&&bounds.right<=width-15,JSON.stringify(bounds));assert.ok(bounds.overflow<=1,JSON.stringify(bounds));assert.deepEqual(bounds.bad,[],JSON.stringify(bounds));
      };
      await assertReader();await geometry('reading-wrap');
      await page.addStyleTag({content:'.cr-markdown {font-size:20px !important}'});await assertReader();await page.evaluate(()=>crPage.changeTheme({currentTarget:{dataset:{value:'dark'}}}));await geometry('reading-wrap-large-dark');
      await page.evaluate(()=>{crResetConversation();crPage.follow=false;});
      for(const sheet of ['options','permissions','attachments','menu','files']){await page.evaluate(sheet=>{crPage.changeTheme({currentTarget:{dataset:{value:'dark'}}});crPage.setData({sheet});},sheet);await geometry('dark-'+sheet);}
      assert.deepEqual(errors,[]);await context.close();
    }
    console.log('iOS 会话对齐：320/390/430px 活动逐项折叠、思考/图片/工作状态、模型与强度、批准菜单、相机/照片/文件、聊天菜单、文件预览、Diff、键盘与深色检查通过');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
