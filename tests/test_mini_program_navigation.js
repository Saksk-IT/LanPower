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

test('启动进入我的设备，原生底部只包含我的设备与我的，旧链接保留目标设备', () => {
  const root = path.resolve(__dirname, '../mini_program');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(app.pages[0], ROUTES.devices.slice(1));
  assert.deepEqual(app.tabBar.list.map(tab => [tab.text, tab.pagePath]), [['我的设备', ROUTES.devices.slice(1)], ['我的', ROUTES.settings.slice(1)]]);
  for (const tab of app.tabBar.list) for (const icon of [tab.iconPath, tab.selectedIconPath]) assert.ok(fs.existsSync(path.join(root, icon)));
  for (const route of Object.values(ROUTES)) assert.ok(app.pages.includes(route.slice(1)));
  let legacy;
  global.Page = definition => {legacy = definition;};
  require('../mini_program/pages/cloud/cloud');
  const calls = [];
  global.wx = {redirectTo: options => calls.push(['redirect', options.url]), switchTab: options => calls.push(['tab', options.url])};
  for (const [tab, name, kind] of [['home', 'power', 'redirect'], ['devices', 'power', 'redirect'], ['connect', 'settings', 'tab'], ['help', 'help', 'redirect'], ['codex', 'codex', 'redirect'], ['', 'power', 'redirect']]) {
    legacy.onLoad({tab, computer: 'pc/a'});
    assert.deepEqual(calls.pop(), [kind, ROUTES[name] + (['power', 'codex'].includes(name) ? '?computer=pc%2Fa' : '')]);
  }
  legacy.onLoad(); assert.deepEqual(calls.pop(), ['tab', ROUTES.devices]);
  legacy.onLoad({tab: 'codex'}); assert.deepEqual(calls.pop(), ['tab', ROUTES.devices]);
});

test('设备详情和 Codex 使用页面栈，原生页签不能带查询参数或复用另一台电脑', () => {
  const calls = [], runtime = {navigateTo: options => calls.push(['open', options]), navigateBack: options => calls.push(['back', options]), switchTab: options => calls.push(['tab', options])};
  global.getCurrentPages = () => [{route: ROUTES.devices.slice(1)}];
  openPage(runtime, 'power', '电脑/a');
  assert.deepEqual(calls.pop(), ['open', {url: ROUTES.power + '?computer=' + encodeURIComponent('电脑/a')}]);
  global.getCurrentPages = () => [{route: ROUTES.devices.slice(1)}, {route: ROUTES.power.slice(1), targetDevice: 'a'}, {route: ROUTES.codex.slice(1), targetDevice: 'a'}, {route: ROUTES.help.slice(1)}];
  openPage(runtime, 'power', 'a'); assert.deepEqual(calls.pop(), ['back', {delta: 2}]);
  openPage(runtime, 'codex', 'a'); assert.deepEqual(calls.pop(), ['back', {delta: 1}]);
  openPage(runtime, 'power', 'b'); assert.deepEqual(calls.pop(), ['open', {url: ROUTES.power + '?computer=b'}]);
  openPage(runtime, 'settings', 'a'); assert.deepEqual(calls.pop(), ['tab', {url: ROUTES.settings}]);
  openPage(runtime, 'devices', 'b'); assert.deepEqual(calls.pop(), ['tab', {url: ROUTES.devices}]);
  openPage(runtime, 'help'); openPage(runtime, 'unknown'); assert.deepEqual(calls, []);
  global.getCurrentPages = () => [{route: ROUTES.lan.slice(1)}];
  openPage(runtime, 'codex'); assert.deepEqual(calls.pop(), ['tab', {url: ROUTES.devices}]);
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

test('我的页扫码授权后切到我的设备且不自动发送任务或电源指令', async () => {
  const storage = {}, runtime = api(storage), calls = [], navigation = [];
  runtime.scanCode = options => options.success({result: session.url + '/#lanpower-client=' + 'c'.repeat(43)});
  runtime.showModal = options => options.success({confirm: true});
  runtime.switchTab = options => navigation.push(options);
  runtime.request = options => {calls.push(options); options.success({statusCode: 200, data: options.url.endsWith('/enroll') ? session : devices});};
  global.getCurrentPages = () => [{route: 'pages/settings/settings'}];
  const settings = page('settings', runtime); settings.visible = true; settings.scanCloud(); await tick(); await tick();
  assert.deepEqual(navigation, [{url: ROUTES.devices}]); assert.equal(settings.data.selectedId, 'a');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.url), [session.url + '/api/v2/clients/enroll']);
  settings.onUnload(); delete global.getCurrentPages;
});

test('我的页登录账号后进入我的设备，空账号也不直接打开控制页面', async () => {
  for (const listed of [devices, []]) {
    const storage = {}, runtime = api(storage), calls = [], navigation = [];
    runtime.getRandomValues = options => options.success({randomValues: new Uint8Array(32).fill(17).buffer});
    runtime.arrayBufferToBase64 = buffer => Buffer.from(buffer).toString('base64');
    runtime.switchTab = options => navigation.push(options.url);
    runtime.navigateTo = options => navigation.push(options.url);
    runtime.request = options => {
      calls.push(options);
      options.success({statusCode: 200, data: options.url.endsWith('/account/login')
        ? {...session, account: {id: '00000000-0000-0000-0000-000000000020', username: 'alice'}} : listed});
    };
    const settings = page('settings', runtime); settings.visible = true;
    settings.setData({accountUrlDraft: session.url, loginUsername: 'alice'});
    settings.accountPassword = 'navigation test passphrase';
    await settings.loginAccount();
    assert.deepEqual(navigation, [ROUTES.devices]);
    assert.equal(settings.data.devices.length, listed.length);
    assert.equal(settings.accountPassword, '');
    assert.deepEqual(calls.map(call => call.url), [session.url + '/api/v2/account/login', session.url + '/api/v2/devices']);
    settings.onUnload();
  }
});

test('点击设备卡片把同一台电脑传给设备详情与 Codex，失去设备后不会切换控制目标', async () => {
  const storage = {[CLIENT_KEY]: {...session}}, runtime = api(storage), navigation = [], calls = [];
  runtime.navigateTo = options => navigation.push(options.url);
  runtime.request = options => {calls.push(options); options.success({statusCode: 200, data: devices});};
  const list = page('devices', runtime); list.visible = true;
  await list.reloadDevices();
  assert.deepEqual(list.data.devices.map(device => device.stateText), ['在线', '在线']);
  list.openDevice({currentTarget: {dataset: {id: 'b'}}});
  assert.equal(navigation.pop(), ROUTES.power + '?computer=b');
  const detail = page('power', runtime, {computer: 'b'}); detail.visible = true;
  await detail.refresh(); assert.equal(detail.data.selectedId, 'b'); assert.equal(detail.data.canControl, true);
  detail.selectDevice({detail: {value: 0}}); assert.equal(detail.data.selectedId, 'b');
  detail.openCodex(); assert.equal(navigation.pop(), ROUTES.codex + '?computer=b');
  runtime.request = options => {calls.push(options); options.success({statusCode: 200, data: [devices[0]]});};
  await detail.reloadDevices();
  assert.equal(detail.data.selectedId, ''); assert.equal(detail.data.deviceMissing, true);
  assert.equal(detail.data.canControl, false); assert.equal(detail.data.canWake, false);
  detail.openCodex(); detail.action({currentTarget: {dataset: {action: 'shutdown'}}});
  assert.deepEqual(navigation, []); assert.ok(calls.every(call => call.method === 'GET'));
  list.onUnload(); detail.onUnload();
});

test('设备列表连接失败将状态改为未知，后台与旧 Cloud 的迟到响应不会覆盖当前列表', async () => {
  const storage = {[CLIENT_KEY]: {...session}}, runtime = api(storage), pending = [];
  const list = page('devices', runtime); list.visible = true;
  await list.reloadDevices();
  runtime.request = options => options.fail({errMsg: 'request:fail timeout'});
  await list.reloadDevices();
  assert.equal(list.data.devices.length, 2); assert.ok(list.data.devices.every(device => device.stateText === '状态未知'));
  runtime.request = options => pending.push(options);
  list.onShow(); await tick(); list.onHide(); list.onShow(); await tick();
  pending[1].success({statusCode: 200, data: [devices[1]]}); await tick();
  pending[0].success({statusCode: 200, data: [devices[0]]}); await tick();
  assert.deepEqual(list.data.devices.map(device => device.device_id), ['b']);
  list.onUnload();
});

test('从设备详情进入的 Codex 固定目标，目标删除后关闭连接，不使用缓存中的另一台电脑', async () => {
  const storage = {[CLIENT_KEY]: {...session}}, runtime = api(storage), targets = [];
  global.wx = runtime;
  let definition;
  global.Page = value => {definition = value;};
  require('../mini_program/pages/codex/codex');
  const model = {...definition, data: structuredClone(definition.data)};
  model.setData = changes => Object.assign(model.data, changes);
  model.onLoad({computer: 'b'}); model.visible = true;
  model.connection.connect = id => targets.push(id);
  saveDeviceSelection(runtime, model.client, devices, 'a');
  await model.loadDevices(); assert.equal(model.data.deviceId, 'b'); assert.equal(model.data.deviceLocked, true);
  model.selectDevice({detail: {value: 0}}); assert.equal(model.data.deviceId, 'b');
  runtime.request = options => options.success({statusCode: 200, data: [devices[0]]});
  await model.loadDevices(false);
  assert.equal(model.data.deviceId, ''); assert.equal(model.data.deviceUnavailable, true);
  assert.equal(model.controller.deviceId, ''); assert.equal(model.controller.ready, false);
  assert.ok(targets.filter(Boolean).every(id => id === 'b')); model.onUnload();
});
