// Compiled WXML/WXSS rendered with a DOM adapter, not a WeChat device emulator.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..'), mini = process.env.MINI_PROGRAM_SOURCE_DIR || path.join(root, 'mini_program');
const compiler = process.env.WECHAT_COMPILER_DIR || 'D:/Soft/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const output = path.join(root, 'private/mini-codex-3.0'); fs.mkdirSync(output, {recursive: true});
for (const [file, args] of [['wcc.exe', ['-o', path.join(output, 'wxml.js'), 'pages/codex/codex.wxml']],
  ['wcsc.exe', ['-js', '-o', path.join(output, 'app-wxss.js'), 'app.wxss']],
  ['wcsc.exe', ['-js', '-o', path.join(output, 'codex-wxss.js'), 'pages/codex/codex.wxss']]]) execFileSync(path.join(compiler, file), args, {cwd: mini});
const modules = ['utils/version.js', 'utils/environment.js', 'utils/cloud.js', 'utils/codex-remote.js', 'utils/codex-format.js', 'utils/codex-fragments.js', 'pages/codex/codex.js', ...fs.readdirSync(path.join(mini, 'utils/codex')).filter(file => file.endsWith('.js')).map(file => 'utils/codex/' + file)];
const sources = Object.fromEntries(modules.map(file => [file, fs.readFileSync(path.join(mini, file), 'utf8')]));

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const width of [320, 390, 430]) {
      const height = width === 320 ? 740 : width === 390 ? 844 : 932;
      const context = await browser.newContext({viewport: {width, height}, screen: {width, height}, deviceScaleFactor: 1});
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<style>html,body{margin:0;height:100%;overflow:hidden}wx-page,wx-view,wx-scroll-view,wx-rich-text{display:block}wx-text{white-space:inherit}wx-button{display:block;cursor:pointer;box-sizing:border-box;border:0;font-family:inherit;text-align:center}wx-button:not([size=mini]){margin-left:auto;margin-right:auto;width:184px}wx-input,wx-textarea{display:block}input,textarea{font-family:inherit;color:inherit;border:0;outline:0;background:transparent;font-size:inherit;width:100%;box-sizing:border-box;line-height:inherit}textarea{resize:none}wx-scroll-view{overflow-y:auto}wx-picker{display:block}</style><wx-page><div id="preview"></div></wx-page>');
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
        window.wx = {getStorageSync: () => '', setStorageSync: () => {}, getAppBaseInfo: () => ({theme: 'light'}), setNavigationBarColor: () => {},
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
          if (['wx-input', 'wx-textarea'].includes(node.tag)) {
            const input = document.createElement(node.tag === 'wx-input' ? 'input' : 'textarea');
            input.value = attrs.value || ''; input.placeholder = attrs.placeholder || ''; input.disabled = !!attrs.disabled;
            if (attrs.bindinput) input.addEventListener('input', () => model[attrs.bindinput]({currentTarget: element, detail: {value: input.value}})); element.append(input);
          } else if (node.tag === 'wx-rich-text') {
            const rich = nodes => nodes.map(n => {if (n.type === 'text') return document.createTextNode(n.text); const e = document.createElement(n.name); for (const [k, v] of Object.entries(n.attrs || {})) e.setAttribute(k, v); e.append(...rich(n.children || [])); return e;});
            element.append(...rich(attrs.nodes || []));
          } else for (const child of node.children || []) element.append(makeNode(child));
          return element;
        }
        const render = $gwx('pages/codex/codex.wxml');
        window.crRender = () => document.querySelector('#preview').replaceChildren(makeNode(render(model.data, {})));
        model.setData = changes => {
          if (new TextEncoder().encode(JSON.stringify(changes)).length >= 1048576) throw new Error('setData 超过 1 MiB');
          for (const [key, value] of Object.entries(changes)) {
            const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let object = model.data;
            for (const part of parts.slice(0, -1)) object = object[part]; object[parts.at(-1)] = value;
          }
          window.crRender();
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
          deviceId: 'pc-a', deviceName: '开发电脑'}); model.paint();
        window.crShowChat = () => {
          c.threadId='a'; c.current={...c.threads[0],model:'gpt-5.4',turns:[{id:'first',status:'completed',durationMs:38000,items:[
            {id:'user',type:'userMessage',content:[{type:'text',text:'把 Codex 页面做得更简洁一些'}]},
            {id:'process',type:'agentMessage',phase:'commentary',text:'我会先整理会话和输入区域，让页面更接近原生应用。'},
            {id:'command',type:'commandExecution',command:'node tests/check-layout.js',status:'completed',exitCode:0,aggregatedOutput:'布局检查通过'},
            {id:'files',type:'fileChange',changes:[{path:'mini_program/pages/codex/codex.wxml',diff:'+ 新的布局'}]},
            {id:'answer',type:'agentMessage',phase:'final_answer',text:'**已完成界面重构**\n\n项目与独立聊天分别展示，输入区域保持固定，完整历史可以继续读取。'}]}]};
          c.observeThread(c.current); model.setData({view:'chat'}); model.paint();
        };
        window.crShowRunning=()=>{crShowChat();c.current.turns.push({id:'running',status:'inProgress',startedAt:Date.now()-38000,items:[]});c.activeTurns.set('a','running');c.overlay={label:'正在运行命令',plan:[],error:''};c.queue=[{id:'q1',input:[{type:'text',text:'完成后再检查深色模式'}]}];model.paint();};
        window.crShowCatalog=()=>{c.resources.catalog={kind:'skill',cwd:root,loading:false,error:'',rows:[{name:'项目检查',path:root+'/skills/check',description:'检查项目布局和会话控制逻辑',enabled:true,scope:'project'}]};model.setData({view:'catalog',catalogKind:'skill'});model.paint();};
        window.crShowFiles=()=>{c.resources.state={cwd:root,directory:'.',branch:'main',files:[{name:'README.md',path:'README.md',directory:false},{name:'mini_program',path:'mini_program',directory:true}],cursor:'',query:'',selected:null,loading:false,error:'',truncated:false};model.setData({view:'files'});model.paint();};
        window.crShowImages=()=>{crShowChat();c.current.turns[0].items.splice(1,0,{id:'view-image',type:'imageView',path:root+'/portrait.png'},{id:'generate-image',type:'imageGeneration',result:'data:image/png;base64,fixture'});window.crImageReads=0;window.crImageOpened=[];model.images.resolve=async()=>{window.crImageReads++;return '/fixture/portrait.png';};wx.previewImage=value=>window.crImageOpened.push(value);model.paint();};
      }, {sources});
      async function geometry() {
        const measurements = await page.evaluate(() => ({overflow: document.documentElement.scrollWidth - innerWidth,
          font: getComputedStyle(document.querySelector('.codex-page')).fontFamily,
          page: document.querySelector('.codex-page').getBoundingClientRect().height,
          buttons: Array.from(document.querySelectorAll('.cr-primary,.cr-send,.cr-outline')).map(e => ({class: e.className, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height})),
          scroll: document.querySelector('.cr-chat-scroll,.cr-library-scroll,.cr-feature-scroll').getBoundingClientRect().height,
          outOfBounds:Array.from(document.querySelectorAll('wx-button')).filter(e=>{const r=e.getBoundingClientRect();return r.width && (r.left < -1 || r.right > innerWidth+1)}).map(e=>e.className)}));
        assert.ok(measurements.overflow <= 1, JSON.stringify(measurements)); assert.ok(measurements.scroll > 60, JSON.stringify(measurements));
        assert.ok(measurements.font.includes('sans-serif'), 'compiled page font must inherit through wx-page');
        assert.deepEqual(measurements.outOfBounds, [], JSON.stringify(measurements));
        for (const button of measurements.buttons) assert.ok(button.height >= 32, JSON.stringify(measurements));
      }
      await page.screenshot({path: path.join(output, 'white-list-' + width + '.png')}); await geometry();
      assert.ok(await page.locator('.cr-project-group').count() >= 2); assert.ok((await page.locator('.cr-thread').allTextContents()).some(text=>text.includes('规划下一个想法')));
      await page.evaluate(() => crShowChat()); await geometry(); await page.screenshot({path: path.join(output, 'white-chat-' + width + '.png')});
      assert.equal(await page.locator('.cr-message-activity').count(),0); await page.locator('.cr-work-row').click(); assert.equal(await page.locator('.cr-activity-group').count(),1); await page.locator('.cr-activity-group').click(); assert.equal(await page.locator('.cr-message-activity').count(),2);
      await page.evaluate(()=>crShowImages());assert.equal(await page.locator('.cr-image-toggle').count(),2);assert.equal(await page.locator('.cr-image-previews').count(),0);
      assert.equal(await page.evaluate(()=>crImageReads),0);assert.ok((await page.locator('.cr-image-toggle').allTextContents()).some(text=>text.includes('已查看 1 张图像')));
      await page.locator('.cr-image-toggle').first().click();await page.waitForFunction(()=>document.querySelector('.cr-image-previews wx-image')?.getAttribute('src')==='/fixture/portrait.png');
      const imageBox=await page.locator('.cr-image-previews .cr-image-button').boundingBox();assert.ok(imageBox.width<=141&&imageBox.height<=141);assert.equal(await page.locator('.cr-image-previews wx-image').getAttribute('mode'),'aspectFit');
      await geometry();await page.screenshot({path:path.join(output,'image-preview-'+width+'.png')});
      await page.locator('.cr-image-previews .cr-image-button').click();assert.equal(await page.evaluate(()=>crImageOpened.length),1);
      await page.evaluate(()=>crPage.paint());assert.equal(await page.locator('.cr-image-previews').count(),1);await page.locator('.cr-image-toggle').first().click();assert.equal(await page.locator('.cr-image-previews').count(),0);
      await page.evaluate(() => {crShowRunning();crPage.changeTheme({currentTarget:{dataset:{value:'dark'}}});});
      assert.equal(await page.locator('.cr-stop').count(), 1); await geometry(); await page.screenshot({path: path.join(output, 'dark-chat-' + width + '.png')});
      await page.evaluate(() => {crPage.changeTheme({currentTarget:{dataset:{value:'light'}}});crPage.controller.approvals.set(JSON.stringify('approval'),{id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'a',turnId:'running',itemId:'file',reason:'修改小程序界面与输入区域'}});crPage.openApproval({currentTarget:{dataset:{key:JSON.stringify('approval')}}});});
      await geometry(); assert.equal(await page.locator('.cr-sheet .cr-primary').innerText(), '仅本次允许');
      await page.screenshot({path: path.join(output, 'approval-' + width + '.png')});
      await page.evaluate(() => {crPage.closeSheet();crPage.controller.approvals.clear();crPage.controller.queue=[];crPage.paint();crPage.keyboard({detail:{height:290}});}); await geometry();
      const composer = await page.locator('.cr-composer').boundingBox(); assert.ok(composer.y + composer.height <= height-290+1);
      await page.screenshot({path:path.join(output,'keyboard-'+width+'.png')});
      await page.evaluate(()=>{crPage.keyboard({detail:{height:0}});crShowCatalog();});await geometry();await page.screenshot({path:path.join(output,'skills-'+width+'.png')});
      await page.evaluate(()=>crShowFiles());await geometry();await page.screenshot({path:path.join(output,'files-'+width+'.png')});
      await page.evaluate(()=>{crPage.setData({view:'settings'});crPage.paint();});await geometry();await page.screenshot({path:path.join(output,'settings-'+width+'.png')});
      assert.deepEqual(errors, []); await context.close();
    }
    console.log('微信编译页面：320/390/430px 图片折叠、140px 预览与点击大图，以及项目与聊天、过程折叠、队列、审批、深色、键盘、技能、文件和设置检查通过');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
