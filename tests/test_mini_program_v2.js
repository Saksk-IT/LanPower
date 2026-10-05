const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  // Every registered page must survive a clean checkout, including page JSON.
  const root = path.resolve(__dirname, '../mini_program');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  for (const route of app.pages) {
    for (const extension of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(path.join(root, `${route}.${extension}`)), `Missing page file: ${route}.${extension}`);
    }
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(root, `${route}.json`), 'utf8')));
  }
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
    if (opts.url.endsWith('/renew')) finish = () => opts.success({statusCode: 200, data: {...session, access_token: 'n'.repeat(43)}});
    else opts.success({statusCode: 200, data: []});
  });
  const client = CloudClient.load(wxApi);
  const first = client.call('/api/v2/devices'), second = client.call('/api/v2/devices');
  await tick(); assert.equal(calls.length, 1); assert.equal(saved[CLIENT_KEY].refresh_pending, undefined);
  finish(); await Promise.all([first, second]);
  assert.equal(calls.filter(c => c.url.endsWith('/renew')).length, 1);
  assert.ok(calls.slice(1).every(c => c.header.Authorization === `Bearer ${'n'.repeat(43)}`));
  // A transient failure must keep the phone authorization and allow recovery,
  // including after a reload and from an old refresh_pending marker.
  for (const failure of ['network', 500, 502, 429, 'malformed', 'wrong-client']) {
    for (const restart of [false, true]) {
      let attempts = 0, failed = true;
      const brokenStorage = {[CLIENT_KEY]: {...session, access_expires_at: 1, refresh_pending: true}};
      const brokenApi = runtime(brokenStorage, opts => {
        if (!opts.url.endsWith('/renew')) return opts.success({statusCode: 200, data: []});
        attempts++;
        assert.equal(opts.data.refresh_token, session.refresh_token);
        if (!failed) return opts.success({statusCode: 200, data: session});
        if (failure === 'network') opts.fail({});
        else opts.success({statusCode: typeof failure === 'number' ? failure : 200,
          data: failure === 'wrong-client' ? {...session, client_id: '00000000-0000-0000-0000-000000000099'} : {}});
      });
      let broken = CloudClient.load(brokenApi);
      await assert.rejects(broken.call('/api/v2/devices'), error => error.code !== 'REAUTHORIZE');
      assert.equal(brokenStorage[CLIENT_KEY].refresh_token, session.refresh_token);
      failed = false;
      if (restart) broken = CloudClient.load(brokenApi);
      assert.deepEqual(await broken.call('/api/v2/devices'), []);
      assert.equal(attempts, 2);
      assert.equal(brokenStorage[CLIENT_KEY].refresh_pending, undefined);
    }
  }
  // An old Cloud must never receive a fallback single-use refresh request.
  for (const statusCode of [404, 405]) {
    const oldCalls = [];
    const storage = {[CLIENT_KEY]: {...session, access_expires_at: 1}};
    const oldCloud = CloudClient.load(runtime(storage, opts => {
      oldCalls.push(opts.url); opts.success({statusCode});
    }));
    await assert.rejects(oldCloud.call('/api/v2/devices'), /请先更新 Cloud/);
    assert.deepEqual(oldCalls, [session.url + '/api/v2/clients/renew']);
    assert.equal(storage[CLIENT_KEY].refresh_token, session.refresh_token);
  }
  // Failed local persistence must also allow renewal on the next launch.
  const diskStorage = {[CLIENT_KEY]: {...session, access_expires_at: 1}};
  const diskApi = runtime(diskStorage, opts => opts.success({statusCode: 200,
    data: opts.url.endsWith('/renew') ? session : []}));
  const write = diskApi.setStorageSync;
  diskApi.setStorageSync = () => {throw new Error('storage full');};
  await assert.rejects(CloudClient.load(diskApi).call('/api/v2/devices'), /检查手机存储/);
  diskApi.setStorageSync = write;
  assert.deepEqual(await CloudClient.load(diskApi).call('/api/v2/devices'), []);
  // A renewal completed for a closed page cannot overwrite a new enrollment.
  let delayedRenewal;
  const replacedStorage = {[CLIENT_KEY]: {...session, access_expires_at: 1}};
  const replaced = CloudClient.load(runtime(replacedStorage, opts => {delayedRenewal = opts;}));
  const pendingRenewal = replaced.call('/api/v2/devices');
  await tick(); replaced.close();
  const replacement = {...session, refresh_token: 'z'.repeat(43)};
  replacedStorage[CLIENT_KEY] = replacement;
  delayedRenewal.success({statusCode: 200, data: session});
  await assert.rejects(pendingRenewal, /连接已关闭/);
  assert.deepEqual(replacedStorage[CLIENT_KEY], replacement);
  // A server-side revocation is terminal for this instance, unlike a timeout.
  let rejectedCalls = 0;
  const revoked = CloudClient.load(runtime({[CLIENT_KEY]: {...session, access_expires_at: 1}}, opts => {
    rejectedCalls++; opts.success({statusCode: 401});
  }));
  await assert.rejects(revoked.call('/api/v2/devices'), {code: 'REAUTHORIZE'});
  await assert.rejects(revoked.call('/api/v2/devices'), {code: 'REAUTHORIZE'});
  assert.equal(rejectedCalls, 1);

  global.Page = definition => {global.definition = definition;};
  require('../mini_program/pages/power/power');
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

  // Background status updates and device switching must not overwrite form drafts.
  const draftStorage = stored();
  const drafts = page(draftStorage, opts => opts.url.startsWith('http://') ? opts.fail({}) :
    opts.success({statusCode: 200, data: [pc('a'), pc('b')]}));
  await drafts.refresh();
  drafts.editMac({detail: {value: '02-11-22-33-44-66'}});
  drafts.editBroadcast({detail: {value: '192.168.1.255'}});
  await drafts.refresh();
  assert.equal(drafts.data.mac, '02-11-22-33-44-66');
  assert.equal(drafts.data.wakeDirty, true);
  assert.equal(draftStorage[LOCAL_KEY][`${session.url}|a`].mac, local.mac);
  drafts.selectDevice({detail: {value: '1'}}); await tick();
  assert.equal(drafts.data.mac, '');
  drafts.selectDevice({detail: {value: '0'}}); await tick();
  assert.equal(drafts.data.mac, '02-11-22-33-44-66');
  drafts.saveWake(); await tick();
  assert.equal(draftStorage[LOCAL_KEY][`${session.url}|a`].mac, '02-11-22-33-44-66');
  assert.equal(drafts.data.wakeDirty, false);
  global.wx.scanCode = opts => opts.success({result: `http://192.168.1.5:48211/#access=${'d'.repeat(64)}`});
  drafts.scanLocal(); await tick();
  assert.equal(drafts.pairing().host, '192.168.1.5');
  assert.equal(drafts.pairing().mac, '02-11-22-33-44-66', 'Rescanning the same device keeps its wake settings');
  global.wx.showModal = opts => opts.success({confirm: false});
  drafts.clearLocal();
  assert.equal(drafts.data.paired, true, 'Canceling removal preserves the association');
  global.wx.showModal = opts => opts.success({confirm: true});
  drafts.clearLocal(); await tick();
  assert.equal(drafts.data.paired, false);

  // Manual refresh must discover newly added PCs even while LAN is healthy.
  const discoveryCalls = [];
  const discover = page(stored(), opts => {
    discoveryCalls.push(opts.url);
    opts.success({statusCode: 200, data: opts.url.startsWith('http://') ? {state: 'online'} : [pc('a'), pc('b'), pc('c')]});
  });
  await discover.refresh();
  assert.equal(discover.data.devices.length, 2);
  let stopped = 0;
  global.wx.stopPullDownRefresh = () => {stopped++;};
  await discover.onPullDownRefresh();
  assert.equal(discover.data.devices.length, 3);
  assert.equal(discover.data.selectedId, 'a');
  assert.equal(discover.data.canControl, true);
  assert.equal(stopped, 1);
  assert.ok(discoveryCalls.some(url => url.endsWith('/api/v2/devices')));
  global.wx.request = opts => opts.url.startsWith('http://') ?
    opts.success({statusCode: 200, data: {state: 'online'}}) : opts.fail({});
  await discover.reloadDevices();
  assert.equal(discover.data.canControl, true, 'A failed list reload must preserve LAN control');
  assert.equal(discover.data.cloudState, 'unavailable');
  assert.equal(discover.data.feedbackKind, 'error');

  // Removing the selected PC cannot leave its controls enabled for a newly selected PC.
  const removalStorage = stored();
  removalStorage[LOCAL_KEY][`${session.url}|b`] = {...local, host: '192.168.1.5'};
  let remainingDevices = [pc('a'), pc('b')], nextComputer;
  const removal = page(removalStorage, opts => {
    if (opts.url.startsWith('http://192.168.1.5:')) nextComputer = opts;
    else if (opts.url.startsWith('http://')) opts.fail({});
    else opts.success({statusCode: 200, data: remainingDevices});
  });
  await removal.refresh(); assert.equal(removal.data.canControl, true);
  remainingDevices = [pc('b')];
  await removal.refresh(); await tick();
  assert.equal(removal.data.selectedId, 'b');
  assert.equal(removal.data.canControl, false);
  assert.equal(removal.route, '');
  nextComputer.success({statusCode: 200, data: {state: 'online'}}); await tick();
  assert.equal(removal.data.canControl, true);
  assert.equal(removal.route, 'local');

  const empty = page({[CLIENT_KEY]: {...session}}, opts => opts.success({statusCode: 200, data: []}));
  await empty.refresh();
  assert.equal(empty.data.devicesLoaded, true);
  assert.equal(empty.data.selectedId, '');
  assert.equal(empty.data.canControl, false);
  assert.equal(empty.data.canWake, false);
  assert.equal(empty.data.cloudState, 'online');

  const noGateway = page(stored(), opts => opts.success({statusCode: 200, data: [{...pc('a'), state: 'offline',
    cloud_agent: 'offline', remote_control_available: false, wake_unavailable_reason: '唤醒网关未连接'}]}));
  noGateway.networkType = '5g';
  await noGateway.refresh();
  assert.equal(noGateway.data.canWake, false);
  assert.equal(noGateway.data.wakeHint, '唤醒网关未连接');

  const expired = stored(); expired[CLIENT_KEY].access_expires_at = 1;
  const interrupted = page(expired, opts => opts.fail({}));
  interrupted.networkType = '5g';
  await interrupted.refresh();
  assert.equal(interrupted.data.needsReauthorize, false, 'Offline renewal must not display the rescan banner');
  assert.equal(interrupted.data.cloudState, 'unavailable');
  global.wx.request = opts => opts.success({statusCode: 200,
    data: opts.url.endsWith('/renew') ? session : [pc('a')]});
  await interrupted.refresh();
  assert.equal(interrupted.data.cloudState, 'online');
  assert.equal(interrupted.data.needsReauthorize, false);
  assert.equal(interrupted.data.canControl, true);

  expired[CLIENT_KEY].access_expires_at = 1;
  const reauthorize = page(expired, opts => opts.success({statusCode: 401, data: {}}));
  reauthorize.networkType = '5g';
  await reauthorize.refresh();
  assert.equal(reauthorize.data.needsReauthorize, true);
  assert.equal(reauthorize.data.canControl, false);
  assert.equal(reauthorize.data.cloudState, 'reauthorize');
  reauthorize.networkType = 'wifi';
  global.wx.request = opts => opts.success({statusCode: 200, data: {state: 'online'}});
  await reauthorize.refresh();
  assert.equal(reauthorize.data.canControl, true, 'Invalid Cloud authorization must not disable local control');
  assert.equal(reauthorize.data.needsReauthorize, true);
  console.log('mini program v2 page registration, authorization, LAN/Cloud routing, refresh, wake settings and guidance: PASS');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
