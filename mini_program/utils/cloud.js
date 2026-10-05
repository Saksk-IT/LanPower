const CLIENT_KEY = 'lanpower_client_v2';
const {VERSION, PROTOCOL_VERSION} = require('./version');
const {cloudOrigin, environment, developmentCloud, setDevelopmentCloud, storageKey, assertReachableCloud} = require('./environment');
const {cloudConnectionError} = require('./cloud-connectivity');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ACCOUNT_KEY = 'lanpower_account_connection_v1';

function authorizationError(message = 'Cloud 登录或授权已失效，请重新登录；原扫码方式也可使用') {
  const error = new Error(message);
  error.code = 'REAUTHORIZE';
  return error;
}

function parseCloudPairing(value, wxApi) {
  const parts = String(value).trim().split('/#lanpower-client=');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
    throw new Error('请扫描 Cloud 的“已授权客户端”页面生成的二维码');
  }
  const url = cloudOrigin(parts[0], wxApi);
  assertReachableCloud(url, wxApi);
  return {url, code: parts[1]};
}

function validTokens(data) {
  return data && ID.test(data.client_id || '') && TOKEN.test(data.access_token || '') &&
    TOKEN.test(data.refresh_token || '') && Number.isSafeInteger(data.access_expires_at);
}

function savedSession(url, data) {
  return {url, client_id: data.client_id, access_token: data.access_token,
    refresh_token: data.refresh_token, access_expires_at: data.access_expires_at,
    ...(data.account ? {account: data.account} : {})};
}

async function accountConnectionKey(wxApi, url, username) {
  const key = storageKey(wxApi, ACCOUNT_KEY, url) + '|' + encodeURIComponent(url) + '|' + encodeURIComponent(username);
  const saved = wxApi.getStorageSync(key);
  if (/^[A-Za-z0-9_-]{43}$/.test(saved || '')) return saved;
  if (!wxApi.getRandomValues || !wxApi.arrayBufferToBase64) throw new Error('请更新微信后使用账号登录，或使用原扫码方式');
  const bytes = await new Promise((resolve, reject) => wxApi.getRandomValues({length: 32,
    success: result => resolve(result.randomValues), fail: () => reject(new Error('无法准备安全登录，请重试'))}));
  if (!bytes || bytes.byteLength !== 32) throw new Error('无法准备安全登录，请重试');
  const created = wxApi.arrayBufferToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(created)) throw new Error('无法准备安全登录，请重试');
  wxApi.setStorageSync(key, created);
  return created;
}

function request(wxApi, url, method, data, token) {
  return new Promise((resolve, reject) => {
    assertReachableCloud(url.replace(/^(https?:\/\/[^/]+).*$/, '$1'), wxApi);
    wxApi.request({url, method, data, timeout: 10000,
    header: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    success: resolve, fail: reason => reject(cloudConnectionError(wxApi, url, reason))});
  });
}

class CloudClient {
  constructor(wxApi, session) {
    cloudOrigin(session.url, wxApi);
    if (!validTokens(session)) throw new Error('请重新扫描 Cloud 授权二维码');
    this.wx = wxApi;
    this.session = session;
    this.environment = environment(wxApi).name;
    this.storageKey = storageKey(wxApi, CLIENT_KEY, session.url);
    this.savedIdentity = !!wxApi.getStorageSync(this.storageKey);
    this.assertCurrent();
  }

  assertCurrent() {
    if (this.closed) throw new Error('连接已关闭');
    if (environment(this.wx).name !== this.environment || storageKey(this.wx, CLIENT_KEY) !== this.storageKey) {
      const error = new Error('Cloud 地址已切换，请重新连接');
      error.code = 'CLOUD_CHANGED';
      throw error;
    }
    const saved = this.wx.getStorageSync(this.storageKey);
    if ((this.savedIdentity && !saved) || saved && (saved.url !== this.session.url || saved.client_id !== this.session.client_id || saved.refresh_token !== this.session.refresh_token)) {
      const error = new Error('账号或 Cloud 已切换，请重新连接');
      error.code = 'CLOUD_CHANGED';
      throw error;
    }
  }

  static load(wxApi) {
    const key = storageKey(wxApi, CLIENT_KEY);
    const saved = wxApi.getStorageSync(key);
    if (!saved) return null;
    try { return new CloudClient(wxApi, saved); }
    catch (_) { wxApi.removeStorageSync(key); return null; }
  }

  static async enroll(wxApi, pairing) {
    const url = cloudOrigin(pairing.url, wxApi);
    assertReachableCloud(url, wxApi);
    if (!/^[A-Za-z0-9_-]{43}$/.test(pairing.code || '')) throw new Error('Cloud 授权码无效，请重新扫码');
    const target = developmentCloud(wxApi);
    if (target && target !== url) throw new Error('授权码与测试 Cloud 地址不同，请在该测试 Cloud 生成授权二维码');
    const initialKey = storageKey(wxApi, CLIENT_KEY);
    const ensureCurrent = () => {
      if (storageKey(wxApi, CLIENT_KEY) !== initialKey) throw new Error('Cloud 地址已切换，请重新扫码');
    };
    let response = await request(wxApi, url + '/api/v2/clients/enroll', 'POST',
      {code: pairing.code, version: VERSION, protocol_version: PROTOCOL_VERSION});
    ensureCurrent();
    // Earlier v2 Clouds reject extra fields before consuming the one-time code.
    // Retry only that explicit response, never a lost or uncertain response.
    if (response.statusCode === 400 && response.data && response.data.error === 'invalid enrollment') {
      response = await request(wxApi, url + '/api/v2/clients/enroll', 'POST', {code: pairing.code});
      ensureCurrent();
    }
    if (response.statusCode !== 200 || !validTokens(response.data)) throw new Error('授权码无效或已使用，请在 Cloud 重新生成');
    const session = savedSession(url, response.data);
    wxApi.setStorageSync(storageKey(wxApi, CLIENT_KEY, url), session);
    if (environment(wxApi).development) setDevelopmentCloud(wxApi, url);
    return new CloudClient(wxApi, session);
  }

  static async accountLogin(wxApi, {url, username, password, register = false}) {
    url = cloudOrigin(String(url || '').trim().replace(/\/+$/, ''), wxApi);
    assertReachableCloud(url, wxApi);
    username = String(username || '').trim().toLowerCase();
    if (!username || username.length > 80 || typeof password !== 'string' || !password || password.length > 256)
      throw new Error('请填写账号和密码');
    const initialEnvironment = environment(wxApi).name, initialKey = storageKey(wxApi, CLIENT_KEY);
    const previous = wxApi.getStorageSync(initialKey) || null;
    const initialIdentity = previous ? previous.client_id + '|' + previous.refresh_token : '';
    const ensureCurrent = () => {
      const current = wxApi.getStorageSync(initialKey) || null;
      if (environment(wxApi).name !== initialEnvironment || storageKey(wxApi, CLIENT_KEY) !== initialKey ||
          (current ? current.client_id + '|' + current.refresh_token : '') !== initialIdentity) {
        const error = new Error('账号或 Cloud 已切换，请重新登录'); error.code = 'CLOUD_CHANGED'; throw error;
      }
    };
    if (previous && (previous.url !== url || previous.account && previous.account.username !== username))
      throw new Error('请先退出当前账号，再登录其他账号或 Cloud');
    const connectionKey = await accountConnectionKey(wxApi, url, username);
    ensureCurrent();
    const check = response => {
      if (response.statusCode === 404 || response.statusCode === 405) throw new Error('请先更新 Cloud，以支持统一账号登录');
      if (response.statusCode === 429) throw new Error('尝试次数过多，请在 5 分钟后重试');
      if (response.statusCode !== 200) throw new Error(response.data && typeof response.data.error === 'string'
        ? response.data.error.slice(0, 300) : '登录暂时不可用，请稍后重试');
    };
    if (register) {
      if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username) || password.length < 12) throw new Error('账号需要 3 至 40 位字母、数字、点、下划线或短横线，密码至少 12 个字符');
      const created = await request(wxApi, url + '/api/v2/account/register', 'POST', {username, password});
      ensureCurrent(); check(created);
    }
    const response = await request(wxApi, url + '/api/v2/account/login', 'POST', {
      username, password, client_type: 'mobile', connection_key: connectionKey, name: '我的手机',
      version: VERSION, protocol_version: PROTOCOL_VERSION,
      ...(previous && previous.url === url ? {previous: {id: previous.client_id, refresh_token: previous.refresh_token}} : {})
    });
    ensureCurrent(); check(response);
    if (!validTokens(response.data) || !response.data.account || !ID.test(response.data.account.id || '') || response.data.account.username !== username)
      throw new Error('Cloud 登录响应无效，请重试');
    const session = savedSession(url, response.data);
    wxApi.setStorageSync(storageKey(wxApi, CLIENT_KEY, url), session);
    if (environment(wxApi).development) setDevelopmentCloud(wxApi, url);
    wxApi.setStorageSync(storageKey(wxApi, 'lanpower_account_cloud_v1'), url);
    return new CloudClient(wxApi, session);
  }

  refresh() {
    if (this.closed) return Promise.reject(new Error('连接已关闭'));
    if (this.authorizationInvalid) return Promise.reject(authorizationError());
    if (this.refreshInFlight) return this.refreshInFlight;
    const original = this.session;
    // This endpoint retains the phone credential, so a lost response, failed
    // storage write or legacy refresh_pending marker can be retried safely.
    // Never fall back to the old single-use /token endpoint on an older Cloud.
    this.refreshInFlight = Promise.resolve().then(async () => {
      this.assertCurrent();
      const response = await request(this.wx, original.url + '/api/v2/clients/renew', 'POST',
        {client_id: original.client_id, refresh_token: original.refresh_token});
      if (this.closed) throw new Error('连接已关闭');
      this.assertCurrent();
      if (response.statusCode === 401) {
        this.authorizationInvalid = true;
        throw authorizationError();
      }
      if (response.statusCode === 404 || response.statusCode === 405) {
        throw new Error('请先更新 Cloud 平台以支持手机长期授权，已有授权已保留');
      }
      if (response.statusCode === 429) throw new Error('操作过于频繁，请稍后重试');
      if (response.statusCode !== 200 || !validTokens(response.data) || response.data.client_id !== original.client_id) {
        throw new Error('Cloud 暂时无法续期，恢复连接后将自动重试');
      }
      const next = savedSession(original.url, response.data);
      if (original.account) next.account = original.account;
      try { this.wx.setStorageSync(this.storageKey, next); }
      catch (_) { throw new Error('无法保存 Cloud 授权，请检查手机存储后重试'); }
      this.session = next;
    }).finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  async call(path, method = 'GET', data) {
    if (this.closed) throw new Error('连接已关闭');
    this.assertCurrent();
    if (!/^\/api\/v2\//.test(path)) throw new Error('请求地址无效');
    if (this.session.refresh_pending || this.session.access_expires_at <= Date.now() / 1000 + 30) await this.refresh();
    this.assertCurrent();
    const sent = this.session.access_token;
    let response = await request(this.wx, this.session.url + path, method, data, sent);
    this.assertCurrent();
    if (response.statusCode === 401) {
      if (this.session.access_token === sent) await this.refresh();
      this.assertCurrent();
      response = await request(this.wx, this.session.url + path, method, data, this.session.access_token);
      this.assertCurrent();
    }
    if (response.statusCode !== 200) {
      if (response.statusCode === 401) throw authorizationError();
      if (response.statusCode === 403 && path.startsWith('/api/v2/remote/')) {
        const error = new Error('请在 Cloud 的手机授权中，为这部手机开启 Codex Remote 权限');
        error.code = 'FORBIDDEN'; throw error;
      }
      if (response.statusCode === 404 && path.startsWith('/api/v2/remote/')) {
        const error = new Error('请先将 Cloud 更新至 1.12.0，再使用小程序远程开发');
        error.code = 'UPDATE_REQUIRED'; throw error;
      }
      throw new Error(response.statusCode === 429 ? '操作过于频繁，请稍后重试' : '操作不可用，请刷新设备状态');
    }
    return response.data;
  }

  close() { this.closed = true; }
}

module.exports = {CLIENT_KEY, CloudClient, parseCloudPairing};
