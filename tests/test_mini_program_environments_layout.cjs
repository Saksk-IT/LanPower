// Compile with WeChat tools, then check the connection form with a browser DOM adapter.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), mini = path.join(root, 'mini_program');
const compiler = process.env.WECHAT_COMPILER_DIR || 'D:/Soft/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const output = path.join(root, 'private/mini-navigation/layout');
fs.mkdirSync(output, {recursive: true});
const routes = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8')).pages;
execFileSync(path.join(compiler, 'wcc.exe'), ['-o', path.join(output, 'wxml.js'), ...routes.map(route => route + '.wxml')], {cwd: mini});
const styles = ['app.wxss', ...routes.map(route => route + '.wxss')];
for (const [index, file] of styles.entries()) {
  const imports = /pages\/(settings|power|help)\//.test(file) ? ['styles/device.wxss'] : [];
  execFileSync(path.join(compiler, 'wcsc.exe'), ['-js', '-o', path.join(output, 'style-' + index + '.js'), file, ...imports], {cwd: mini});
}
const sources = Object.fromEntries(['utils/version.js', 'utils/environment.js', 'utils/cloud-connectivity.js', 'utils/cloud.js', 'utils/pairing.js',
  'utils/wol.js', 'utils/navigation.js', 'utils/device-selection.js', 'utils/device-page.js', 'pages/settings/settings.js', 'pages/power/power.js', 'pages/help/help.js'].map(file => [file, fs.readFileSync(path.join(mini, file), 'utf8')]));

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const width of [320, 390, 430]) {
      const context = await browser.newContext({viewport: {width, height: 780}, screen: {width, height: 780}, deviceScaleFactor: 1});
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<style>html,body{margin:0}wx-page,wx-view,wx-input{display:block}wx-button{display:block;box-sizing:border-box;border:0;font-family:inherit;text-align:center}wx-button:not([size=mini]){width:184px;margin-left:auto;margin-right:auto}wx-text,wx-input{font-family:inherit}input{display:block;box-sizing:border-box;width:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit}</style><wx-page><div id="preview"></div></wx-page>');
      await page.addScriptTag({content: fs.readFileSync(path.join(output, 'wxml.js'), 'utf8')});
      await page.evaluate(() => {window.__COMMON_STYLESHEETS__ = {}; window.__transformRpx__ = value => value * innerWidth / 750;});
      for (const index of [0, styles.indexOf('pages/settings/settings.wxss')]) {
        await page.addScriptTag({content: fs.readFileSync(path.join(output, 'style-' + index + '.js'), 'utf8')});
      }
      await page.evaluate(({sources}) => {
        const modules = {}, storage = {};
        const load = name => {
          if (modules[name]) return modules[name].exports;
          const module = {exports: {}}; modules[name] = module;
          const require = relative => {
            const parts = name.split('/').slice(0, -1);
            for (const part of relative.split('/')) {if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);}
            return load(parts.join('/') + '.js');
          };
          new Function('require', 'module', 'exports', sources[name])(require, module, module.exports); return module.exports;
        };
        window.__webview_engine_version__ = 0.02;
        window.envVersion = 'develop';
        window.wx = {getAccountInfoSync: () => ({miniProgram: {envVersion}}),
          getStorageSync: key => storage[key], setStorageSync: (key, value) => {storage[key] = value;}, removeStorageSync: key => delete storage[key]};
        window.Page = definition => {window.connectionPage = {...definition, data: structuredClone(definition.data)};};
        load('pages/settings/settings.js'); let model = window.connectionPage;
        function node(value) {
          if (typeof value === 'string') return document.createTextNode(value);
          if (value.tag === 'virtual') {const fragment = document.createDocumentFragment(); for (const child of value.children || []) fragment.append(node(child)); return fragment;}
          const element = document.createElement(value.tag || 'div'), attrs = value.attr || {};
          for (const [key, attr] of Object.entries(attrs)) {
            if (key.startsWith('bind') || key.startsWith('catch') || key === 'value') continue;
            if (typeof attr === 'string' || typeof attr === 'number') element.setAttribute(key, attr);
          }
          if (attrs.disabled) element.setAttribute('disabled', '');
          if (attrs.bindtap) element.addEventListener('click', () => {
            if (!element.hasAttribute('disabled')) model[attrs.bindtap]({currentTarget: element, detail: {}});
          });
          if (value.tag === 'wx-input') {
            const input = document.createElement('input'); input.value = attrs.value || ''; input.placeholder = attrs.placeholder || '';
            input.disabled = !!attrs.disabled;
            if (attrs.bindinput) input.addEventListener('input', () => model[attrs.bindinput]({detail: {value: input.value}}));
            element.append(input);
          } else for (const child of value.children || []) element.append(node(child));
          return element;
        }
        let render = $gwx('pages/settings/settings.wxml');
        window.renderConnection = () => document.querySelector('#preview').replaceChildren(node(render(model.data, {})));
        model.setData = changes => {Object.assign(model.data, changes); renderConnection();};
        model.onLoad({tab: 'connect'});
        window.showAuxiliary = (route, patch) => {
          load(route + '.js'); model = window.connectionPage; render = $gwx(route + '.wxml');
          model.setData = changes => {Object.assign(model.data, changes); renderConnection();};
          model.onLoad(); model.setData(patch);
        };
      }, {sources});
      assert.equal(await page.locator('.development-settings').count(), 1);
      assert.equal(await page.locator('wx-button').filter({hasText: /^测试连接$/}).count(), 1);
      await page.locator('#development-cloud input').fill('https://localhost:8443');
      await page.locator('wx-button').filter({hasText: /^保存测试地址$/}).click();
      assert.equal(await page.evaluate(() => connectionPage.data.developmentCloud), 'https://localhost:8443');
      const geometry = await page.evaluate(() => {
        const card = document.querySelector('.development-settings'), input = document.querySelector('#development-cloud');
        const button = card.querySelector('.outline-button');
        return {overflow: document.documentElement.scrollWidth - innerWidth, card: card.clientWidth,
          input: input.getBoundingClientRect().width, button: button.getBoundingClientRect().width,
          height: input.getBoundingClientRect().height};
      });
      assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
      assert.ok(geometry.input > width - 100, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.input - geometry.button) <= 1.1, JSON.stringify(geometry));
      assert.ok(geometry.height >= 36, JSON.stringify(geometry));
      await page.screenshot({path: path.join(output, 'develop-' + width + '.png'), fullPage: true});
      for (const env of ['trial', 'release']) {
        await page.evaluate(env => {envVersion = env; connectionPage.loadConnection();}, env);
        assert.equal(await page.locator('.development-settings').count(), 0);
        assert.equal(await page.evaluate(() => connectionPage.data.cloudUrlDraft), '');
      }
      await page.screenshot({path: path.join(output, 'release-' + width + '.png'), fullPage: true});
      await page.evaluate(() => showAuxiliary('pages/power/power', {connected:true,devices:[{device_id:'fixture',name:'开发电脑'}],selectedId:'fixture',device:'开发电脑',stateText:'在线 · Cloud',statusClass:'online',canControl:true,canWake:false,modeText:'云端直连',detail:'开发电脑在线',controlHint:'可执行睡眠、休眠、重启和关机'}));
      assert.equal(await page.locator('.page-title').textContent(), '电脑与电源');
      assert.equal(await page.locator('.power-grid .power-button').count(), 4);
      assert.equal(await page.locator('.tabbar').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
      await page.screenshot({path: path.join(output, 'power-' + width + '.png'), fullPage: true});
      await page.evaluate(() => showAuxiliary('pages/help/help', {}));
      assert.ok((await page.locator('.help-card-title').textContent()).includes('Codex'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
      await page.screenshot({path: path.join(output, 'help-' + width + '.png'), fullPage: true});
      assert.deepEqual(errors, []); await context.close();
    }
    console.log('微信 WCC/WCSC 编译和 320/390/430px 连接设置、电源与帮助布局、开发/正式/体验版入口隔离检查通过');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
