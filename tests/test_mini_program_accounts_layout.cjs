// Compile with WeChat tools, then check the connection form with a browser DOM adapter.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..'), mini = path.join(root, 'mini_program');
const compiler = process.env.WECHAT_COMPILER_DIR || 'D:/Soft/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const output = path.join(root, 'private/account-login/phone-layout');
fs.mkdirSync(output, {recursive: true});
const routes = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8')).pages;
execFileSync(path.join(compiler, 'wcc.exe'), ['-o', path.join(output, 'wxml.js'), ...routes.map(route => route + '.wxml')], {cwd: mini});
const styles = ['app.wxss', ...routes.map(route => route + '.wxss')];
for (const [index, file] of styles.entries()) {
  const imports = /pages\/(devices|settings|power|help)\//.test(file) ? ['styles/device.wxss'] : [];
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
            input.disabled = !!attrs.disabled; input.type = attrs.password ? 'password' : 'text';
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
          delete modules[route + '.js']; load(route + '.js'); model = window.connectionPage; render = $gwx(route + '.wxml');
          model.setData = changes => {Object.assign(model.data, changes); renderConnection();};
          model.onLoad(); model.setData(patch);
        };
      }, {sources});
assert.equal(await page.locator('#account-username').count(), 1);
      assert.equal(await page.locator('#account-password input').getAttribute('type'), 'password');
      assert.ok(await page.locator('#account-password').evaluate(field => field.getBoundingClientRect().height >= 44));
      await page.locator('#account-username input').fill('alice');
      assert.equal(await page.evaluate(() => connectionPage.data.loginUsername), 'alice');
      await page.screenshot({path: path.join(output, 'account-login-' + width + '.png'), fullPage: true});
      await page.evaluate(() => connectionPage.toggleAccountRegister());
      assert.equal(await page.locator('#account-repeat').count(), 1);
      assert.equal(await page.locator('#account-repeat input').getAttribute('type'), 'password');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
      await page.screenshot({path: path.join(output, 'account-register-' + width + '.png'), fullPage: true});
      await page.emulateMedia({colorScheme:'dark'});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
      await page.screenshot({path: path.join(output, 'account-dark-' + width + '.png'), fullPage: true});
      await page.evaluate(() => connectionPage.setData({connected: true, needsReauthorize: false, accountUsername: 'alice'}));
      assert.equal(await page.locator('#account-password').count(), 0);
      assert.ok((await page.locator('.account-settings').textContent()).includes('alice'));
      for (const env of ['trial', 'release']) {
        await page.evaluate(env => {envVersion = env; connectionPage.loadConnection();}, env);
        assert.equal(await page.locator('.development-settings').count(), 0);
        assert.equal(await page.locator('#account-username').count(), 1);
      }
      assert.deepEqual(errors, []); await context.close();
    }
    console.log('微信 WCC/WCSC 编译及 320/390/430px 账号登录、注册、深色布局和正式/体验环境检查通过');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
