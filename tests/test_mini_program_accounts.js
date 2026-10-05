const assert = require('node:assert/strict');
const {CloudClient, CLIENT_KEY} = require('../mini_program/utils/cloud');
const {storageKey, setDevelopmentCloud} = require('../mini_program/utils/environment');
const {createDevicePage} = require('../mini_program/utils/device-page');
const origin = 'https://accounts.example.test', password = 'test account password 123!';
const account = {id: '00000000-0000-0000-0000-000000000001', username: 'alice'};
const credentials = {client_id: '00000000-0000-0000-0000-000000000002', access_token: 'a'.repeat(43),
  refresh_token: 'r'.repeat(43), access_expires_at: Math.floor(Date.now() / 1000) + 900, account};
function runtime(storage, handler, env = 'release') {
  return {getStorageSync: key => storage[key], setStorageSync: (key, value) => {storage[key] = value;},
    removeStorageSync: key => delete storage[key], request: handler,
    getAccountInfoSync: () => ({miniProgram: {envVersion: env}}),
    getRandomValues: options => options.success({randomValues: new Uint8Array(32).fill(17).buffer}),
    arrayBufferToBase64: buffer => Buffer.from(buffer).toString('base64')};
}
const login = api => CloudClient.accountLogin(api, {url: origin, username: ' ALICE ', password});
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const saved = {}, calls = [];
  const api = runtime(saved, options => {calls.push(options); options.success({statusCode: 200, data: credentials});});
  const client = await login(api);
  assert.equal(client.session.account.username, 'alice');
  assert.equal(calls[0].data.client_type, 'mobile');
  assert.equal(calls[0].data.username, 'alice');
  assert.equal(calls[0].data.connection_key.length, 43);
  assert.equal(calls[0].data.password, password);
  assert(!JSON.stringify(saved).includes(password), 'Password must never be stored');
  await login(api);
  assert.deepEqual(calls[1].data.previous, {id: credentials.client_id, refresh_token: credentials.refresh_token});
  assert.equal(calls[1].data.connection_key, calls[0].data.connection_key, 'Retry retains installation identity');

  for (const status of [401, 409, 429, 404, 503]) {
    const state = {[CLIENT_KEY]: {...client.session}}, before = JSON.stringify(state[CLIENT_KEY]);
    const failing = runtime(state, options => options.success({statusCode: status, data: {error: 'Login unavailable'}}));
    await assert.rejects(login(failing));
    assert.equal(JSON.stringify(state[CLIENT_KEY]), before);
  }
  await assert.rejects(CloudClient.accountLogin(api, {url: 'http://localhost', username: 'alice', password}), /Cloud 需要 HTTPS|账号登录需要 HTTPS/);
  for (const localUrl of ['http://localhost:8080', 'http://192.168.1.100:8080']) {
    const localState = {}, localCalls = [];
    const localApi = runtime(localState, options => {localCalls.push(options); options.success({statusCode: 200, data: credentials});}, 'develop');
    setDevelopmentCloud(localApi, localUrl);
    const localClient = await CloudClient.accountLogin(localApi, {url: localUrl, username: 'alice', password});
    assert.equal(localClient.session.url, localUrl);
    assert.equal(localCalls[0].url, localUrl + '/api/v2/account/login');
    assert.equal(localState[storageKey(localApi, CLIENT_KEY)].client_id, credentials.client_id);
    assert(!JSON.stringify(localState).includes(password));
  }
  for (const env of ['develop', 'trial', 'release']) {
    const blockedCalls = [], blockedApi = runtime({}, options => {blockedCalls.push(options);}, env);
    await assert.rejects(CloudClient.accountLogin(blockedApi, {url: 'http://public.example.test', username: 'alice', password}), /HTTPS/);
    if (env !== 'develop') await assert.rejects(CloudClient.accountLogin(blockedApi, {url: 'http://192.168.1.100:8080', username: 'alice', password}), /HTTPS/);
    assert.equal(blockedCalls.length, 0);
  }
  await assert.rejects(CloudClient.accountLogin(api, {url: origin, username: 'bob', password}), /先退出/);

  const renewedStorage = {[CLIENT_KEY]: {...client.session, access_expires_at: 1}};
  const renewApi = runtime(renewedStorage, options => {
    const data = {...credentials}; delete data.account;
    options.success({statusCode: 200, data: options.url.endsWith('/renew') ? data : []});
  });
  const renewing = CloudClient.load(renewApi);
  await renewing.call('/api/v2/devices');
  assert.deepEqual(renewing.session.account, account);
  assert.deepEqual(renewedStorage[CLIENT_KEY].account, account);

  let lateRenewal;
  const signedOutStorage = {[CLIENT_KEY]: {...client.session, access_expires_at: 1}};
  const signedOutApi = runtime(signedOutStorage, options => {lateRenewal = options;});
  const signedOutClient = CloudClient.load(signedOutApi);
  const refreshing = signedOutClient.refresh();
  await tick();
  delete signedOutStorage[CLIENT_KEY];
  lateRenewal.success({statusCode: 200, data: credentials});
  await assert.rejects(refreshing, error => error.code === 'CLOUD_CHANGED');
  assert.equal(signedOutStorage[CLIENT_KEY], undefined, 'A late renewal must not restore a signed-out session');

  let pending;
  const switchingStorage = {}, switchingApi = runtime(switchingStorage, options => {pending = options;}, 'develop');
  setDevelopmentCloud(switchingApi, origin);
  const delayed = login(switchingApi);
  await tick();
  setDevelopmentCloud(switchingApi, 'https://other.example.test');
  pending.success({statusCode: 200, data: credentials});
  await assert.rejects(delayed, error => error.code === 'CLOUD_CHANGED');
  assert.equal(switchingStorage[storageKey(switchingApi, CLIENT_KEY)], undefined);

  let finish;
  const switchingAccountStorage = {}, switchingAccountApi = runtime(switchingAccountStorage, options => {finish = options;});
  const oldLogin = login(switchingAccountApi);
  await tick();
  switchingAccountStorage[CLIENT_KEY] = {...credentials, url: origin, client_id: '00000000-0000-0000-0000-000000000003', account: {...account, username: 'bob'}};
  finish.success({statusCode: 200, data: credentials});
  await assert.rejects(oldLogin, error => error.code === 'CLOUD_CHANGED');
  assert.equal(switchingAccountStorage[CLIENT_KEY].account.username, 'bob');

  const registerCalls = [], registerState = {};
  const registerApi = runtime(registerState, options => {
    registerCalls.push(options); options.success({statusCode: 200, data: options.url.endsWith('/register') ? {account} : credentials});
  });
  await CloudClient.accountLogin(registerApi, {url: origin, username: 'alice', password, register: true});
  assert.deepEqual(registerCalls.map(row => row.url), [origin + '/api/v2/account/register', origin + '/api/v2/account/login']);
  assert(!JSON.stringify(registerState).includes(password));

  const pageStorage = {}, pageCalls = [];
  global.wx = runtime(pageStorage, options => {
    pageCalls.push(options.url);
    options.success({statusCode: 200, data: options.url.endsWith('/account/login') ? credentials : [{device_id: 'pc-one', device_type: 'windows', name: 'My PC', state: 'online'}]});
  });
  global.wx.navigateTo = () => {};
  global.wx.reLaunch = () => {};
  global.wx.switchTab = () => {};
  const definition = createDevicePage('settings');
  const page = {...definition, data: {...definition.data}, visible: true};
  page.setData = (values, callback) => {Object.assign(page.data, values); if (callback) callback();};
  page.onLoad();
  page.data.accountUrlDraft = origin; page.data.loginUsername = 'alice'; page.accountPassword = password;
  await page.loginAccount();
  assert.equal(page.data.accountUsername, 'alice');
  assert.equal(page.data.devices.length, 1, 'Device list must load after busy is cleared');
  assert(pageCalls.includes(origin + '/api/v2/devices'));
  assert.equal(page.accountPassword, '');
  assert(!JSON.stringify(page.data).includes(password));
  const httpPageState = {}, httpPageCalls = [];
  global.wx = runtime(httpPageState, options => {
    httpPageCalls.push(options.url);
    options.success({statusCode: 200, data: options.url.endsWith('/account/login') ? credentials : [{device_id: 'pc-one', device_type: 'windows', name: 'My PC', state: 'online'}]});
  }, 'develop');
  global.wx.navigateTo = global.wx.reLaunch = global.wx.switchTab = () => {};
  const httpDefinition = createDevicePage('settings');
  const httpPage = {...httpDefinition, data: {...httpDefinition.data}, visible: true};
  httpPage.setData = (values, callback) => {Object.assign(httpPage.data, values); if (callback) callback();};
  httpPage.onLoad();
  httpPage.data.accountUrlDraft = 'https://localhost:8443';
  httpPage.editCloudUrl({detail: {value: 'http://192.168.1.100:8080'}});
  httpPage.saveDevelopmentCloud();
  assert.equal(httpPage.data.accountUrlDraft, 'http://192.168.1.100:8080');
  httpPage.data.loginUsername = 'alice'; httpPage.accountPassword = password;
  await httpPage.loginAccount();
  assert.equal(httpPage.client.session.url, 'http://192.168.1.100:8080');
  assert.equal(httpPage.data.devices.length, 1);
  assert.deepEqual(httpPageCalls, ['http://192.168.1.100:8080/api/v2/account/login', 'http://192.168.1.100:8080/api/v2/devices']);
  console.log('mini program account login, legacy proof, safe retry, password storage, environment/account races and automatic computer listing: PASS');
})().catch(error => {console.error(error); process.exitCode = 1;});
