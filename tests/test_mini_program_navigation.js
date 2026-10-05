const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {ROUTES, openPage} = require('../mini_program/utils/navigation');
const {selectedDevice, saveDeviceSelection} = require('../mini_program/utils/device-selection');
const {createDevicePage} = require('../mini_program/utils/device-page');
const {storageKey, setDevelopmentCloud} = require('../mini_program/utils/environment');
const {CLIENT_KEY} = require('../mini_program/utils/cloud');
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = {url: 'https://power.example.com', client_id: '00000000-0000-0000-0000-000000000010', access_token: 'a'.repeat(43), refresh_token: 'r'.repeat(43), access_expires_at: Math.floor(Date.now() / 1000) + 900};
const devices = ['a', 'b'].map(id => ({device_id: id, name: '电脑 ' + id, device_type: 'windows', state: 'online', cloud_agent: 'online', remote_control_available: true}));
function api(storage = {}, env = 'release') {
  return {getAccountInfoSync: () => ({miniProgram: {envVersion: env}}), getStorageSync: key => storage[key], setStorageSync: (key, value) => {storage[key] = value;}, removeStorageSync: key => delete storage[key], request: options => options.success({statusCode: 200, data: devices})};
}
function page(mode, runtime, options = {}) {
  global.wx = runtime;
  const definition = createDevicePage(mode), model = {...definition, data: structuredClone(definition.data)};
  model.setData = changes => Object.assign(model.data, changes);
  model.onLoad(options);
  return model;
}

test('启动进入 Codex，辅助功能有独立路径且旧入口只做兼容跳转', () => {
  const root = path.resolve(__dirname, '../mini_program');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(app.pages[0], ROUTES.codex.slice(1));
  for (const route of Object.values(ROUTES)) assert.ok(app.pages.includes(route.slice(1)));
  let legacy;
  global.Page = definition => {legacy = definition;};
  require('../mini_program/pages/cloud/cloud');
  global.wx = {redirectTo: options => {global.destination = options.url;}};
  for (const [tab, name] of [['home', 'power'], ['connect', 'settings'], ['help', 'help'], ['', 'codex']]) {
    legacy.onLoad({tab, computer: 'pc/a'});
    assert.equal(global.destination, ROUTES[name] + '?computer=pc%2Fa');
  }
});

test('打开辅助页面保留首页，返回复用原页面并防止重复堆叠', () => {
  const calls = [], runtime = {navigateTo: options => calls.push(['open', options]), navigateBack: options => calls.push(['back', options]), reLaunch: options => calls.push(['root', options])};
  global.getCurrentPages = () => [{route: ROUTES.codex.slice(1)}];
  openPage(runtime, 'power', '电脑/a');
  assert.deepEqual(calls.pop(), ['open', {url: ROUTES.power + '?computer=' + encodeURIComponent('电脑/a')}]);
  global.getCurrentPages = () => [{route: ROUTES.codex.slice(1)}, {route: ROUTES.power.slice(1)}, {route: ROUTES.settings.slice(1)}, {route: ROUTES.help.slice(1)}];
  openPage(runtime, 'power'); assert.deepEqual(calls.pop(), ['back', {delta: 2}]);
  openPage(runtime, 'codex'); assert.deepEqual(calls.pop(), ['back', {delta: 3}]);
  openPage(runtime, 'help'); openPage(runtime, 'unknown'); assert.deepEqual(calls, []);
  global.getCurrentPages = () => [{route: ROUTES.lan.slice(1)}];
  openPage(runtime, 'codex'); assert.deepEqual(calls.pop(), ['root', {url: ROUTES.codex}]);
  delete global.getCurrentPages;
});

test('电脑选择沿用已有缓存，隔离环境、Cloud 和手机身份，缓存不保存可操作状态', () => {
  const storage = {}, release = api(storage), client = {session};
  saveDeviceSelection(release, client, devices, 'b');
  assert.equal(selectedDevice(release, client), 'b');
  assert.equal(storage.lanpower_device_cache_v2.devices[1].state, undefined);
  assert.equal(selectedDevice(api(storage, 'trial'), client), '');
  const dev = api(storage, 'develop'); setDevelopmentCloud(dev, 'https://test.example.com');
  assert.equal(selectedDevice(dev, client), '');
  assert.equal(selectedDevice(release, {session: {...session, url: 'https://other.example.com'}}), '');
  assert.equal(selectedDevice(release, {session: {...session, client_id: 'another-phone'}}), '');
  assert.equal(storage.lanpower_device_cache_v2.selectedId, 'b');
});

test('设置页只读取授权电脑，切换的目标同步给电源页，失去授权的电脑自动退出选择', async () => {
  const storage = {[CLIENT_KEY]: {...session}}, runtime = api(storage), calls = [];
  runtime.request = options => {calls.push(options.url); options.success({statusCode: 200, data: devices});};
  const settings = page('settings', runtime); settings.visible = true;
  await settings.reloadDevices();
  settings.selectDevice({detail: {value: 1}}); await tick();
  assert.equal(selectedDevice(runtime, settings.client), 'b');
  assert.ok(calls.every(url => url === session.url + '/api/v2/devices'));
  const power = page('power', runtime); assert.equal(power.data.selectedId, 'b'); assert.equal(power.data.canControl, false);
  runtime.request = options => options.success({statusCode: 200, data: [devices[0]]});
  await settings.reloadDevices(); assert.equal(settings.data.selectedId, 'a'); assert.equal(selectedDevice(runtime, settings.client), 'a');
  runtime.request = options => options.success({statusCode: 200, data: []});
  await settings.reloadDevices(); assert.equal(settings.data.selectedId, '');
  settings.onUnload(); power.onUnload();
});

test('辅助页面返回时重新加载授权与电脑选择，退出授权后控制不可用', async () => {
  const storage = {[CLIENT_KEY]: {...session}}, runtime = api(storage), model = page('settings', runtime);
  saveDeviceSelection(runtime, model.client, devices, 'b');
  model.onShow(); await tick(); assert.equal(model.data.selectedId, 'b');
  model.onHide(); runtime.removeStorageSync(CLIENT_KEY);
  model.onShow(); await tick(); assert.equal(model.data.connected, false); assert.equal(model.data.selectedId, ''); assert.equal(model.data.canControl, false);
  model.onUnload();
});

test('隐藏页面迟到的电脑列表不能覆盖返回后新选的电脑', async () => {
  const storage = {[CLIENT_KEY]: {...session}}, runtime = api(storage), model = page('settings', runtime), pending = [];
  runtime.request = options => pending.push(options);
  model.onShow(); await tick(); assert.equal(pending.length, 1);
  model.onHide(); saveDeviceSelection(runtime, model.client, devices, 'b');
  model.onShow(); await tick(); assert.equal(pending.length, 2);
  pending[1].success({statusCode: 200, data: devices}); await tick();
  pending[0].success({statusCode: 200, data: [devices[0]]}); await tick();
  assert.equal(model.data.selectedId, 'b'); assert.equal(selectedDevice(runtime, model.client), 'b');
  model.onUnload();
});

test('异步网络信息不会丢弃设置页正在读取的电脑列表', async () => {
  const storage = {[CLIENT_KEY]: {...session}}, runtime = api(storage), model = page('settings', runtime);
  let complete;
  runtime.request = options => {complete = options.success;};
  model.onShow(); await tick();
  model.networkChanged({networkType: 'wifi', isConnected: true});
  complete({statusCode: 200, data: devices}); await tick();
  assert.equal(model.data.devicesLoaded, true); assert.equal(model.data.selectedId, 'a');
  model.onUnload();
});

test('扫码授权后直接返回 Codex 首页且不自动发送任何任务或电源指令', async () => {
  const storage = {}, runtime = api(storage), calls = [], navigation = [];
  runtime.scanCode = options => options.success({result: session.url + '/#lanpower-client=' + 'c'.repeat(43)});
  runtime.showModal = options => options.success({confirm: true});
  runtime.navigateBack = options => navigation.push(options);
  runtime.request = options => {calls.push(options); options.success({statusCode: 200, data: options.url.endsWith('/enroll') ? session : devices});};
  global.getCurrentPages = () => [{route: 'pages/codex/codex'}, {route: 'pages/settings/settings'}];
  const settings = page('settings', runtime); settings.visible = true; settings.scanCloud(); await tick(); await tick();
  assert.deepEqual(navigation, [{delta: 1}]); assert.equal(settings.data.selectedId, 'a');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.url), [session.url + '/api/v2/clients/enroll']);
  settings.onUnload(); delete global.getCurrentPages;
});
