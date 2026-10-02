// Compiled WXML/WXSS rendered with a DOM adapter, not a WeChat device emulator.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..'), mini = path.join(root, 'mini_program');
const compiler = process.env.WECHAT_COMPILER_DIR || 'D:/Soft/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const output = path.join(root, 'private/mini-codex-1.12'); fs.mkdirSync(output, {recursive: true});
for (const [file, args] of [['wcc.exe', ['-o', path.join(output, 'wxml.js'), 'pages/codex/codex.wxml']],
  ['wcsc.exe', ['-js', '-o', path.join(output, 'app-wxss.js'), 'app.wxss']],
  ['wcsc.exe', ['-js', '-o', path.join(output, 'codex-wxss.js'), 'pages/codex/codex.wxss']]]) execFileSync(path.join(compiler, file), args, {cwd: mini});
const sources = Object.fromEntries(['utils/version.js', 'utils/cloud.js', 'utils/codex-remote.js', 'utils/codex-format.js', 'pages/codex/codex.js'].map(file => [file, fs.readFileSync(path.join(mini, file), 'utf8')]));

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const width of [320, 390, 430]) {
      const context = await browser.newContext({viewport: {width, height: 780}, screen: {width, height: 780}, deviceScaleFactor: 1});
      const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<style>html,body{margin:0;height:100%;overflow:hidden}wx-page,wx-view,wx-scroll-view,wx-rich-text{display:block}wx-text{white-space:inherit}wx-button{display:block;cursor:pointer;box-sizing:border-box;border:0;font-family:inherit;text-align:center}wx-button:not([size=mini]){margin-left:auto;margin-right:auto;width:184px}wx-input,wx-textarea{display:block}input,textarea{font-family:inherit;color:inherit;border:0;outline:0;background:transparent;font-size:inherit;width:100%;box-sizing:border-box;line-height:inherit}textarea{resize:none}wx-scroll-view{overflow-y:auto}wx-picker{display:block}</style><div id="preview"></div>');
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
            if (result?.catch) result.catch(error => model.notify(error.message));
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
          for (const [key, value] of Object.entries(changes)) {
            const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let object = model.data;
            for (const part of parts.slice(0, -1)) object = object[part]; object[parts.at(-1)] = value;
          }
          window.crRender();
        };
        model.onLoad(); model.loggedIn = true; model.follow = true; model.visible = true;
        model.projects = [{name: 'LanPower', path: root}]; model.sessions = [
          {id: 'a', name: '优化小程序布局', projectName: 'LanPower', cwd: root, control: 'remote', updatedAt: Date.now()/1000},
          {id: 'b', name: '检查连接状态', projectName: 'LanPower', cwd: root, updatedAt: Date.now()/1000-1080},
          {id: 'c', name: '整理项目文档', projectName: 'LanPower', cwd: root, updatedAt: Date.now()/1000-3600}];
        model.setData({authorized: true, ready: true, state: 'runtime_ready', devices: [{device_id: 'pc-a', name: '开发电脑'}],
          deviceId: 'pc-a', deviceName: '开发电脑', projects: model.projects, projectOptions: [{name: '全部项目', path: ''}, ...model.projects]});
        model.renderLibrary();
        window.crShowChat = () => {
          model.thread = {...model.sessions[0]}; model.items = [
            {id: 'user', kind: 'user', text: '把 Codex 页面做得更简洁一些'},
            {id: 'ai', kind: 'assistant', text: '我会先整理会话和输入区域，让页面更接近原生应用。\n\n已调整间距、消息样式和底部输入栏。'},
            {id: 'done', kind: 'summary', text: '已完成 · 38 秒'}];
          model.aggregateDiff = '--- a/codex.wxml\n+++ b/codex.wxml\n-old\n+new\n--- a/codex.wxss\n+++ b/codex.wxss\n+style';
          model.setData({view: 'chat', title: '优化小程序布局', project: 'LanPower'}); model.paint(); model.controls();
        };
      }, {sources});
      async function geometry() {
        const measurements = await page.evaluate(() => ({overflow: document.documentElement.scrollWidth - innerWidth,
          page: document.querySelector('.codex-page').getBoundingClientRect().height,
          buttons: Array.from(document.querySelectorAll('.cr-primary,.cr-send,.cr-outline')).map(e => ({class: e.className, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height})),
          scroll: document.querySelector('.cr-chat-scroll,.cr-library-scroll').getBoundingClientRect().height}));
        assert.ok(measurements.overflow <= 1, JSON.stringify(measurements)); assert.ok(measurements.scroll > 100, JSON.stringify(measurements));
        for (const button of measurements.buttons) {assert.ok(button.height >= 32, JSON.stringify(measurements)); if (button.class === 'cr-primary' || button.class === 'cr-outline') assert.ok(button.width > width - 70, JSON.stringify(measurements));}
      }
      await page.screenshot({path: path.join(output, 'white-list-' + width + '.png')}); await geometry();
      await page.evaluate(() => crShowChat()); await geometry(); await page.screenshot({path: path.join(output, 'white-chat-' + width + '.png')});
      await page.evaluate(() => {crPage.activeTurns.set('a', {id: 'turn', startedAt: Date.now()-38000}); crPage.changeTheme({currentTarget:{dataset:{value:'dark'}}}); crPage.controls();});
      assert.equal(await page.locator('.cr-stop').count(), 1); await geometry(); await page.screenshot({path: path.join(output, 'dark-chat-' + width + '.png')});
      await page.evaluate(() => {crPage.changeTheme({currentTarget:{dataset:{value:'light'}}}); crPage.changes.set('file', [{path:'codex.wxml'},{path:'codex.wxss'}]);
        crPage.addApproval({id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'a',itemId:'file'}});crPage.openApproval({currentTarget:{dataset:{key:JSON.stringify('approval')}}});});
      await geometry(); assert.equal(await page.locator('.cr-sheet .cr-primary').innerText(), '仅本次允许');
      await page.screenshot({path: path.join(output, 'approval-' + width + '.png')});
      await page.evaluate(() => {crPage.closeSheet(); crPage.keyboard({detail:{height:290}});}); await geometry();
      const composer = await page.locator('.cr-composer').boundingBox(); assert.ok(composer.y + composer.height <= 490);
      assert.deepEqual(errors, []); await context.close();
    }
    console.log('编译后的 WXML/WXSS：320/390/430px 会话、对话、深色、审批及键盘布局检查通过');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
