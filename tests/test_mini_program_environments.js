const assert = require('node:assert/strict');
const {environment, cloudOrigin, developmentCloud, setDevelopmentCloud, storageKey, DEVELOPMENT_CLOUD_KEY} =
  require('../mini_program/utils/environment');
const {CloudClient, CLIENT_KEY, parseCloudPairing} = require('../mini_program/utils/cloud');
const LOCAL_KEY = 'lanpower_device_lan_v2', CACHE_KEY = 'lanpower_device_cache_v2';
const originA = 'https://localhost:8443', originB = 'http://192.168.1.100:8765';
const code = 'c'.repeat(43), tick = () => new Promise(resolve => setImmediate(resolve));
const credentials = (url, token = 'a') => ({url, client_id: '00000000-0000-0000-0000-000000000010',
  access_token: token.repeat(43), refresh_token: 'r'.repeat(43), access_expires_at: Math.floor(Date.now() / 1000) + 900});

function runtime(storage, env = 'develop', request = () => assert.fail('Unexpected network request')) {
  return {getAccountInfoSync: () => ({miniProgram: {envVersion: env}}),
    getStorageSync: key => storage[key], setStorageSync: (key, value) => {storage[key] = value;},
    removeStorageSync: key => delete storage[key], request, showModal: options => options.success({confirm: true})};
}
global.Page = definition => {global.cloudPage = definition;};
require('../mini_program/pages/settings/settings');
global.Page = definition => {global.lanPage = definition;};
require('../mini_program/pages/index/index');
function page(wxApi, definition = global.cloudPage) {
  global.wx = wxApi;
  const instance = {...definition, data: {...definition.data}, visible: false};
  instance.setData = changes => Object.assign(instance.data, changes);
  instance.onLoad(); return instance;
}

async function main() {
  assert.equal(environment({}).name, 'release');
  assert.equal(environment({getAccountInfoSync: () => {throw new Error();}}).name, 'release');
  assert.equal(environment(runtime({}, 'unknown')).name, 'release');
  for (const env of ['trial', 'release']) {
    const api = runtime({}, env);
    assert.equal(environment(api).development, false);
    assert.throws(() => setDevelopmentCloud(api, originA), /只有开发版/);
    assert.throws(() => parseCloudPairing(originB + '/#lanpower-client=' + code, api), /HTTPS/);
    assert.deepEqual(parseCloudPairing('https://power.example.com/#lanpower-client=' + code, api),
      {url: 'https://power.example.com', code});
  }
  const dev = runtime({});
  for (const url of [originA, originB, 'http://localhost:8765', 'http://127.0.0.1:8765', 'http://[::1]:8765',
    'http://10.1.2.3:80', 'http://172.16.1.100', 'http://172.31.1.100', 'https://power.example.com']) {
    assert.equal(cloudOrigin(url, dev), url);
  }
  for (const url of ['http://power.example.com', 'http://8.8.8.8', 'http://172.32.1.100', 'http://0.0.0.0',
    'https://good.example.com@bad.example.com', 'https://bad..example.com', 'https://bad-.example.com',
    'https://localhost:65536', 'https://localhost:0', 'https://localhost/path', 'https://localhost?x=1',
    'https://localhost/#x', 'https://999.1.1.1', 'https://127.1', 'https://01.2.3.4']) {
    assert.throws(() => cloudOrigin(url, dev), url);
  }
  assert.equal(setDevelopmentCloud(dev, '  HTTPS://LOCALHOST:8443/  '), originA);
  assert.throws(() => setDevelopmentCloud(dev, '/'), /Cloud 地址无效/);

  // Shared WeChat storage must retain production data while isolating each test server.
  const production = credentials('https://power.example.com');
  const productionCache = {url: production.url, client_id: production.client_id, devices: [], selectedId: 'prod'};
  const storage = {[CLIENT_KEY]: production, [CACHE_KEY]: productionCache, [LOCAL_KEY]: {production: {host: '192.168.1.100'}}};
  const calls = [];
  const api = runtime(storage, 'develop', options => {calls.push(options); options.success({statusCode: 200, data: credentials(originA)});});
  assert.equal(CloudClient.load(api), null);
  assert.equal(page(api).data.connected, false);
  assert.deepEqual(page(api).local, {});
  assert.equal(CloudClient.load(runtime(storage, 'trial')), null);
  assert.equal(CloudClient.load(runtime(storage, 'release')).session, production);

  const clientA = await CloudClient.enroll(api, {url: originA, code});
  assert.equal(developmentCloud(api), originA);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, originA + '/api/v2/clients/enroll');
  assert.equal(calls[0].header.Authorization, undefined);
  assert.equal(CloudClient.load(api).session.url, originA);
  const sessionAKey = clientA.storageKey, cacheAKey = storageKey(api, CACHE_KEY);
  storage[cacheAKey] = {url: originA, client_id: clientA.session.client_id,
    devices: [{device_id: 'test-a', name: '测试电脑 A'}], selectedId: 'test-a'};
  const connected = page(api);
  assert.equal(connected.data.development, true);
  assert.equal(connected.data.selectedId, 'test-a');
  assert.equal(connected.data.canControl, false);
  assert.equal(connected.data.cloudUrlDraft, originA);
  connected.route = 'local'; connected.setData({canControl: true, canWake: true, mac: 'old draft'});
  connected.wakeDrafts = {old: {mac: 'draft'}};
  connected.editCloudUrl({detail: {value: originB}}); connected.saveDevelopmentCloud();
  assert.equal(connected.data.connected, false);
  assert.equal(connected.data.canControl, false);
  assert.equal(connected.data.canWake, false);
  assert.equal(connected.data.selectedId, '');
  assert.equal(connected.route, '');
  assert.deepEqual(connected.wakeDrafts, {});
  assert.equal(storage[sessionAKey].url, originA);
  await assert.rejects(clientA.call('/api/v2/devices'), {code: 'CLOUD_CHANGED'});
  const requestsBefore = calls.length;
  await assert.rejects(CloudClient.enroll(api, {url: production.url, code}), /授权码与测试 Cloud 地址不同/);
  assert.equal(calls.length, requestsBefore, 'A code from a different Cloud must never be forwarded');

  api.request = options => {calls.push(options); options.success({statusCode: 200, data: credentials(originB, 'b')});};
  const clientB = await CloudClient.enroll(api, {url: originB, code});
  assert.equal(calls.at(-1).url, originB + '/api/v2/clients/enroll');
  assert.notEqual(clientA.storageKey, clientB.storageKey);
  connected.loadConnection();
  connected.editCloudUrl({detail: {value: originA}}); connected.saveDevelopmentCloud();
  assert.equal(connected.client.session.access_token, 'a'.repeat(43));
  assert.equal(connected.data.selectedId, 'test-a');
  assert.equal(connected.client.storageKey, sessionAKey);
  connected.editCloudUrl({detail: {value: 'http://public.example.com'}}); connected.saveDevelopmentCloud();
  assert.equal(developmentCloud(api), originA);
  assert.equal(connected.data.connected, true);
  connected.clearDevelopmentCloud();
  assert.equal(developmentCloud(api), '');
  assert.equal(connected.data.connected, false);
  assert.equal(storage[sessionAKey].access_token, 'a'.repeat(43));
  assert.equal(storage[CLIENT_KEY], production);
  assert.equal(storage[CACHE_KEY], productionCache);

  // Formal releases neither show nor accept the development setting, even with persisted dev configuration.
  setDevelopmentCloud(api, originA);
  for (const env of ['release', 'trial']) {
    const releaseApi = runtime(storage, env), formal = page(releaseApi);
    assert.equal(formal.data.development, false);
    assert.equal(formal.data.cloudUrlDraft, '');
    const before = JSON.stringify(storage);
    formal.changeDevelopmentCloud(originB);
    assert.equal(JSON.stringify(storage), before);
    assert.equal(developmentCloud(releaseApi), '');
  }

  // Renewal and responses arriving after a target switch cannot overwrite any other environment's credentials.
  let complete;
  const delayed = runtime(storage, 'develop', options => {complete = options.success;});
  storage[sessionAKey] = {...credentials(originA), access_expires_at: 1};
  let renewing = CloudClient.load(delayed);
  const refresh = renewing.refresh(); await tick();
  setDevelopmentCloud(delayed, originB);
  complete({statusCode: 200, data: credentials(originA, 'n')});
  await assert.rejects(refresh, {code: 'CLOUD_CHANGED'});
  assert.equal(storage[sessionAKey].access_token, 'a'.repeat(43));
  setDevelopmentCloud(delayed, originA);
  renewing = CloudClient.load(delayed);
  const retry = renewing.refresh(); await tick();
  complete({statusCode: 200, data: credentials(originA, 'n')}); await retry;
  assert.equal(storage[sessionAKey].access_token, 'n'.repeat(43));
  assert.equal(storage[CLIENT_KEY], production);
  const reading = renewing.call('/api/v2/devices'); await tick();
  setDevelopmentCloud(delayed, originB); complete({statusCode: 200, data: []});
  await assert.rejects(reading, {code: 'CLOUD_CHANGED'});

  const pendingStorage = {}, pendingApi = runtime(pendingStorage, 'develop', options => {complete = options.success;});
  setDevelopmentCloud(pendingApi, originA);
  const enrollment = CloudClient.enroll(pendingApi, {url: originA, code});
  setDevelopmentCloud(pendingApi, originB);
  complete({statusCode: 200, data: credentials(originA)});
  await assert.rejects(enrollment, /Cloud 地址已切换/);
  assert.equal(pendingStorage[storageKey(pendingApi, CLIENT_KEY, originA)], undefined);

  // The native Codex transport must also use the local test Cloud's WebSocket scheme.
  const {CodexConnection} = require('../mini_program/utils/codex-remote');
  const socketApi = runtime({}, 'develop', options => options.success({statusCode: 200, data: credentials(originB)}));
  const socketCloud = await CloudClient.enroll(socketApi, {url: originB, code});
  let handshake;
  socketApi.connectSocket = options => {
    handshake = options;
    return {onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}};
  };
  const connection = new CodexConnection({wxApi: socketApi, cloud: socketCloud,
    event() {}, state() {}, timer: () => 1, clearTimer() {}});
  connection.connect('test-pc'); await tick();
  assert.equal(handshake.url, 'ws://192.168.1.100:8765/api/v2/remote/mobile/test-pc');
  assert.equal(handshake.header.Authorization, 'Bearer ' + socketCloud.session.access_token);
  connection.stop();

  // Old LAN and v1 Cloud pairing must also stay isolated, including invalid-session cleanup.
  const legacy = {lanpower_pairing_v1: {host: '192.168.1.100', token: 'a'.repeat(64)},
    lanpower_remote_v1: {url: production.url, gateway: 'home', client_secret: 'b'.repeat(64)}};
  const legacyApi = runtime(legacy);
  const lan = page(legacyApi, global.lanPage);
  assert.equal(lan.data.paired, false); assert.equal(lan.data.remotePaired, false);
  legacy[storageKey(legacyApi, 'lanpower_remote_v1')] = {url: 'invalid'};
  page(legacyApi, global.lanPage);
  assert.equal(legacy.lanpower_remote_v1.url, production.url);
  assert.ok(legacy.lanpower_pairing_v1);
  assert.equal(storage[DEVELOPMENT_CLOUD_KEY], originB);
  console.log('小程序开发/体验/正式环境、地址校验、授权与缓存隔离、切换和续期检查通过');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
