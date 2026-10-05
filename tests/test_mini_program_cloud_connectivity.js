const assert = require('node:assert/strict');
const {setDevelopmentCloud, DEVELOPMENT_CLOUD_KEY, storageKey} = require('../mini_program/utils/environment');
const {CloudClient, CLIENT_KEY, parseCloudPairing} = require('../mini_program/utils/cloud');
const {testDevelopmentCloud, cloudConnectionError} = require('../mini_program/utils/cloud-connectivity');

global.Page = definition => {global.cloudPage = definition;};
require('../mini_program/pages/cloud/cloud');
const lan = 'https://192.168.1.100:8443', code = 'c'.repeat(43);
function runtime(platform = 'ios', env = 'develop') {
  const storage = {}, calls = [];
  return {storage, calls, getDeviceInfo: () => ({platform}),
    getAccountInfoSync: () => ({miniProgram: {envVersion: env}}),
    getStorageSync: key => storage[key], setStorageSync: (key, value) => {storage[key] = value;},
    removeStorageSync: key => delete storage[key],
    request: options => {calls.push(options); options.success({statusCode: 200,
      data: {ok: true, version: '1.22.1', protocol_version: '2'}});}};
}
function page(api) {
  global.wx = api;
  const model = {...global.cloudPage, data: {...global.cloudPage.data}};
  model.setData = changes => Object.assign(model.data, changes);
  model.onLoad({tab: 'connect'});
  return model;
}

async function main() {
  for (const platform of ['ios', 'android', 'ohos']) {
    const api = runtime(platform);
    setDevelopmentCloud(api, lan);
    for (const url of ['https://localhost:8443', 'http://127.0.0.1:8765', 'https://127.2.3.4', 'https://[::1]:8443']) {
      assert.throws(() => setDevelopmentCloud(api, url), {code: 'CLOUD_LOOPBACK'});
      assert.throws(() => parseCloudPairing(url + '/#lanpower-client=' + code, api), {code: 'CLOUD_LOOPBACK'});
      await assert.rejects(CloudClient.enroll(api, {url, code}), {code: 'CLOUD_LOOPBACK'});
      await assert.rejects(testDevelopmentCloud(api, url), {code: 'CLOUD_LOOPBACK'});
    }
    assert.equal(api.calls.length, 0);
    assert.equal(api.storage[DEVELOPMENT_CLOUD_KEY], lan);
  }
  const oldPhone = runtime();
  delete oldPhone.getDeviceInfo;
  oldPhone.getSystemInfoSync = () => ({platform: 'android'});
  assert.throws(() => setDevelopmentCloud(oldPhone, 'https://localhost:8443'), {code: 'CLOUD_LOOPBACK'});
  const simulator = runtime('devtools');
  assert.equal(setDevelopmentCloud(simulator, 'https://localhost:8443'), 'https://localhost:8443');
  assert.equal((await testDevelopmentCloud(simulator, 'https://localhost:8443')).version, '1.22.1');

  // An old simulator authorization on the phone is retained; no request is sent to the phone itself.
  const savedPhone = runtime();
  const url = 'https://localhost:8443';
  savedPhone.storage[DEVELOPMENT_CLOUD_KEY] = url;
  const saved = {url, client_id: '00000000-0000-0000-0000-000000000010', access_token: 'a'.repeat(43),
    refresh_token: 'r'.repeat(43), access_expires_at: Math.floor(Date.now() / 1000) + 900};
  const key = storageKey(savedPhone, CLIENT_KEY);
  savedPhone.storage[key] = saved;
  await assert.rejects(CloudClient.load(savedPhone).call('/api/v2/devices'), {code: 'CLOUD_LOOPBACK'});
  assert.equal(savedPhone.storage[key], saved);
  assert.equal(savedPhone.calls.length, 0);

  const api = runtime();
  setDevelopmentCloud(api, lan);
  const before = JSON.stringify(api.storage);
  assert.deepEqual(await testDevelopmentCloud(api, lan + '/'), {url: lan, version: '1.22.1'});
  assert.equal(api.calls[0].url, lan + '/healthz');
  assert.equal(api.calls[0].method, 'GET');
  assert.equal(api.calls[0].header, undefined);
  assert.equal(api.calls[0].data, undefined);
  assert.equal(JSON.stringify(api.storage), before);
  for (const [errMsg, expected] of [['request:fail url not in domain list', 'CLOUD_DOMAIN'],
    ['request:fail ssl hand shake error', 'CLOUD_TLS'], ['request:fail timeout', 'CLOUD_TIMEOUT'],
    ['request:fail net::ERR_CERT_AUTHORITY_INVALID', 'CLOUD_TLS'],
    ['request:fail local network permission denied', 'CLOUD_NETWORK_PERMISSION'], ['request:fail connect error', 'CLOUD_NETWORK']]) {
    api.request = options => options.fail({errMsg: errMsg + ' secret-marker'});
    await assert.rejects(testDevelopmentCloud(api, lan), error => error.code === expected && !error.message.includes('secret-marker'));
    await assert.rejects(CloudClient.enroll(api, {url: lan, code}), {code: expected});
  }
  assert.ok(!cloudConnectionError(runtime('ios', 'release'), lan, {errMsg: 'url not in domain list'}).message.includes('调试'));
  for (const env of ['trial', 'release']) {
    const formal = runtime('ios', env);
    await assert.rejects(testDevelopmentCloud(formal, lan), /只有开发版/);
    assert.equal(formal.calls.length, 0);
  }
  for (const response of [{statusCode: 503, data: {ok: true, version: '1.22.1', protocol_version: '2'}},
    {statusCode: 200, data: {ok: true, version: '1.22.1', protocol_version: '3'}},
    {statusCode: 200, data: '<html>wrong service</html>'}]) {
    api.request = options => options.success(response);
    await assert.rejects(testDevelopmentCloud(api, lan), /没有返回兼容/);
  }

  // A late result must not replace feedback after editing, hiding or switching environments.
  const pendingApi = runtime();
  let complete;
  pendingApi.request = options => {pendingApi.calls.push(options); complete = options.success;};
  const model = page(pendingApi);
  model.editCloudUrl({detail: {value: lan}});
  const probe = model.testCloudConnection();
  await model.testCloudConnection();
  assert.equal(pendingApi.calls.length, 1);
  model.editCloudUrl({detail: {value: 'https://10.0.0.10:8443'}});
  model.notify('new feedback');
  complete({statusCode: 200, data: {ok: true, version: '1.22.1', protocol_version: '2'}});
  await probe;
  assert.equal(model.data.feedback, 'new feedback');
  assert.equal(model.data.testingCloud, false);
  const hiddenProbe = model.testCloudConnection();
  model.onHide();
  complete({statusCode: 200, data: {ok: true, version: '1.22.1', protocol_version: '2'}});
  await hiddenProbe;
  assert.equal(model.data.feedback, 'new feedback');
  const formalProbe = model.testCloudConnection();
  pendingApi.getAccountInfoSync = () => ({miniProgram: {envVersion: 'release'}});
  model.loadConnection();
  complete({statusCode: 200, data: {ok: true, version: '1.22.1', protocol_version: '2'}});
  await formalProbe;
  assert.equal(model.data.feedback, 'new feedback');
  assert.equal(model.data.testingCloud, false);
  assert.deepEqual(pendingApi.storage, {});
  console.log('手机回环地址、只读连接检测、微信错误分类、授权保留和迟到响应检查通过');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
