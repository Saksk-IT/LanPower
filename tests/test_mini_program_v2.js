const assert = require('node:assert/strict');
const {CloudClient, CLIENT_KEY, parseCloudPairing} = require('../mini_program/utils/cloud');
const {VERSION, PROTOCOL_VERSION} = require('../mini_program/utils/version');
const session = {url: 'https://power.example.com', client_id: '00000000-0000-0000-0000-000000000010',
  access_token: 'a'.repeat(43), refresh_token: 'r'.repeat(43), access_expires_at: Math.floor(Date.now() / 1000) + 900};
const pc = id => ({device_id: id, name: 'PC ' + id, device_type: 'windows', state: 'online', cloud_agent: 'online',
  remote_control_available: true, wake_available: false});
const local = {host: '192.168.1.4', token: 'b'.repeat(64), mac: '02-11-22-33-44-55'};
const LOCAL_KEY = 'lanpower_device_lan_v2', CACHE_KEY = 'lanpower_device_cache_v2';
const tick = () => new Promise(resolve => setImmediate(resolve));

function runtime(storage, handler) {
  return {getStorageSync: key => storage[key], setStorageSync: (key, value) => {storage[key] = value;},
    removeStorageSync: key => delete storage[key], request: handler, showModal: opts => opts.success({confirm: true})};
}
function page(storage, handler) {
  global.wx = runtime(storage, handler);
  const p = {...global.definition, data: {...global.definition.data}, visible: true};
  p.setData = changes => Object.assign(p.data, changes);
  p.onLoad(); return p;
}
async function main() {
  assert.deepEqual(parseCloudPairing(`https://power.example.com/#lanpower-client=${'c'.repeat(43)}`), {url: session.url, code: 'c'.repeat(43)});
  for (const url of ['http://power.example.com', 'https://bad..example.com', 'https://good.example.com@bad.example.com', 'https://power.example.com:65536', 'https://power.example.com/path']) {
    assert.throws(() => parseCloudPairing(`${url}/#lanpower-client=${'c'.repeat(43)}`));
  }
  const pairing = {url: session.url, code: 'c'.repeat(43)};
  const enrollmentCalls = [];
  await CloudClient.enroll(runtime({}, opts => {
    enrollmentCalls.push(opts);
    opts.success({statusCode: 200, data: session});
  }), pairing);
  assert.deepEqual(enrollmentCalls[0].data, {code: pairing.code, version: VERSION, protocol_version: PROTOCOL_VERSION});
  const compatibleCalls = [];
  await CloudClient.enroll(runtime({}, opts => {
    compatibleCalls.push(opts);
    opts.success(compatibleCalls.length === 1 ? {statusCode: 400, data: {error: 'invalid enrollment'}} :
      {statusCode: 200, data: session});
  }), pairing);
  assert.equal(compatibleCalls.length, 2);
  assert.deepEqual(compatibleCalls[1].data, {code: pairing.code});
  for (const unavailable of ['response-lost', 'enrollment unavailable']) {
    let calls = 0;
    await assert.rejects(CloudClient.enroll(runtime({}, opts => {
      calls++;
      if (unavailable === 'response-lost') opts.fail({});
      else opts.success({statusCode: 400, data: {error: unavailable}});
    }), pairing));
    assert.equal(calls, 1, 'Enrollment must not be retried after an uncertain or consumed code');
  }
  const saved = {[CLIENT_KEY]: {...session, access_expires_at: 1}}, calls = [];
  let finish;
  const wxApi = runtime(saved, opts => {
    calls.push(opts);
    if (opts.url.endsWith('/token')) finish = () => opts.success({statusCode: 200, data: {...session, access_token: 'n'.repeat(43), refresh_token: 's'.repeat(43)}});
    else opts.success({statusCode: 200, data: []});
  });
  const client = CloudClient.load(wxApi);
  const first = client.call('/api/v2/devices'), second = client.call('/api/v2/devices');
  await tick(); assert.equal(calls.length, 1); assert.equal(saved[CLIENT_KEY].refresh_pending, true);
  finish(); await Promise.all([first, second]);
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 1);
  assert.ok(calls.slice(1).every(c => c.header.Authorization === `Bearer ${'n'.repeat(43)}`));
  // Lost refresh response is never automatically retried, including after reload.
  let attempts = 0;
  const brokenStorage = {[CLIENT_KEY]: {...session, access_expires_at: 1}};
  const brokenApi = runtime(brokenStorage, opts => { attempts++; opts.fail({}); });
  const broken = CloudClient.load(brokenApi);
  await assert.rejects(broken.call('/api/v2/devices'));
  await assert.rejects(broken.call('/api/v2/devices'));
  await assert.rejects(CloudClient.load(brokenApi).call('/api/v2/devices'));
  assert.equal(attempts, 1);

  global.Page = definition => {global.definition = definition;};
  require('../mini_program/pages/cloud/cloud');
  const stored = () => ({[CLIENT_KEY]: {...session}, [LOCAL_KEY]: {[`${session.url}|a`]: {...local}},
    [CACHE_KEY]: {url: session.url, client_id: session.client_id, devices: [pc('a'), pc('b')], selectedId: 'a'}});
  const localCalls = [];
  const localPage = page(stored(), opts => {
    localCalls.push(opts);
    if (opts.method === 'POST') opts.success({statusCode: 202});
    else opts.success({statusCode: 200, data: {state: 'online'}});
  });
  await localPage.refresh();
  assert.equal(localPage.data.modeText, '局域网直连');
  localPage.action({currentTarget: {dataset: {action: 'sleep'}}}); await tick();
  assert.ok(localCalls.every(c => c.url.startsWith('http://192.168.1.4:48211/')));
  assert.equal(localCalls.find(c => c.method === 'POST').data.action, 'sleep');

  const cloudCalls = [];
  const cloudPage = page(stored(), opts => {
    cloudCalls.push(opts);
    if (opts.url.startsWith('http://')) opts.fail({});
    else if (opts.url.endsWith('/commands')) opts.success({statusCode: 200, data: {state: 'transitioning', route: 'windows_direct'}});
    else opts.success({statusCode: 200, data: [pc('a'), pc('b')]});
  });
  await cloudPage.refresh();
  assert.equal(cloudPage.data.modeText, '云端直连'); assert.equal(cloudPage.data.canWake, false);
  cloudPage.selectDevice({detail: {value: '1'}}); await tick();
  assert.equal(cloudPage.data.selectedId, 'b'); assert.equal(cloudPage.data.paired, false);
  cloudPage.action({currentTarget: {dataset: {action: 'shutdown'}}}); await tick();
  const command = cloudCalls.find(c => c.url.endsWith('/commands'));
  assert.equal(command.url, session.url + '/api/v2/devices/b/commands');
  assert.deepEqual(command.data, {action: 'shutdown'});
  assert.ok(cloudCalls.filter(c => c.url.startsWith('https://')).every(c => !JSON.stringify(c).includes(local.token)));
  assert.equal(cloudCalls.filter(c => c.url.startsWith('http://')).length, 1, 'PC B must not reuse PC A LAN credentials');

  const offline = page(stored(), opts => opts.fail({}));
  await offline.refresh(); assert.equal(offline.data.canWake, true);
  // A timed-out LAN power request must not be sent again through Cloud.
  const uncertainCalls = [];
  const uncertain = page(stored(), opts => {
    uncertainCalls.push(opts);
    if (opts.method === 'POST') opts.fail({}); else opts.success({statusCode: 200, data: {state: 'online'}});
  });
  await uncertain.refresh(); uncertain.action({currentTarget: {dataset: {action: 'restart'}}}); await tick();
  assert.match(uncertain.data.feedback, /未收到确认/);
  assert.equal(uncertainCalls.filter(c => c.method === 'POST').length, 1);

  // Switching to cellular invalidates an in-flight LAN response and follows Cloud.
  const networkCalls = [];
  let lanResponse, modal, cloudState = {...pc('a'), state: 'offline', cloud_agent: 'offline',
    remote_control_available: false, wake_available: true};
  const network = page(stored(), opts => {
    networkCalls.push(opts);
    if (opts.url.startsWith('http://')) lanResponse = opts;
    else opts.success({statusCode: 200, data: [cloudState]});
  });
  global.wx.showModal = opts => {modal = opts;};
  const pendingLan = network.refresh();
  network.networkChanged({networkType: '5g', isConnected: true});
  assert.equal(network.data.canControl, false);
  lanResponse.success({statusCode: 200, data: {state: 'online'}});
  await pendingLan; await tick();
  assert.equal(network.route, 'cloud');
  assert.equal(network.data.stateText, '离线 · Cloud');
  assert.equal(network.data.canWake, true);
  assert.equal(network.wakeRoute, 'cloud');
  cloudState = {...pc('a'), state: 'transitioning'};
  await network.refresh();
  assert.equal(network.data.stateText, '正在执行电源操作');
  assert.equal(network.data.canControl, false);
  assert.equal(network.data.canWake, false);
  cloudState = pc('a');
  await network.refresh();
  assert.equal(network.data.canControl, true);
  network.action({currentTarget: {dataset: {action: 'shutdown'}}});
  assert.ok(modal);
  network.networkChanged({networkType: 'none', isConnected: false});
  await modal.success({confirm: true}); await tick();
  assert.equal(networkCalls.filter(c => c.method === 'POST').length, 0, 'Network change invalidates open power confirmation');
  cloudState = {...pc('a'), state: 'offline', cloud_agent: 'offline', remote_control_available: false};
  await network.refresh();
  assert.equal(network.data.canWake, false, 'Cellular must not fall back to LAN WOL');
  assert.equal(networkCalls.filter(c => c.url.startsWith('http://')).length, 1);
  global.wx.request = opts => opts.fail({});
  await network.refresh();
  assert.equal(network.data.stateText, '状态未知');
  assert.equal(network.data.canControl, false);
  assert.equal(network.data.canWake, false);

  // An old Cloud response cannot re-enable controls after a new network response.
  let delayedResponse;
  const stale = page(stored(), opts => {delayedResponse = opts;});
  stale.networkType = '4g';
  const pendingCloud = stale.refresh();
  global.wx.request = opts => opts.success({statusCode: 200, data: [cloudState]});
  stale.networkChanged({networkType: '5g', isConnected: true});
  delayedResponse.success({statusCode: 200, data: [pc('a')]});
  await pendingCloud; await tick();
  assert.equal(stale.data.stateText, '离线 · Cloud');
  assert.equal(stale.data.canControl, false);

  let hiddenResponse, hiddenCalls = 0;
  const hidden = page(stored(), opts => {hiddenCalls++; hiddenResponse = opts;});
  hidden.networkType = '5g';
  const pendingHidden = hidden.refresh();
  hidden.refresh();
  hidden.onHide();
  hiddenResponse.success({statusCode: 200, data: [pc('a')]});
  await pendingHidden; await tick();
  assert.equal(hiddenCalls, 1, 'Hidden pages must not schedule a queued refresh');
  assert.equal(hidden.data.canControl, false);
  let removedListener;
  global.wx.offNetworkStatusChange = listener => {removedListener = listener;};
  hidden.onUnload();
  assert.equal(removedListener, hidden.networkChanged);
  console.log('mini program v2 enrollment, tokens, device selection, LAN/Cloud routing and network status synchronization: PASS');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
