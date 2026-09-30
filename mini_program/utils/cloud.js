const CLIENT_KEY = 'lanpower_client_v2';
const {VERSION, PROTOCOL_VERSION} = require('./version');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

function authorizationError(message = 'Cloud 授权已失效，请重新扫码') {
  const error = new Error(message);
  error.code = 'REAUTHORIZE';
  return error;
}

function cloudOrigin(value) {
  const match = /^(https:\/\/[a-z0-9.-]+(?::([0-9]{1,5}))?)$/i.exec(value || '');
  if (!match || value.includes('..') || (match[2] && (+match[2] < 1 || +match[2] > 65535))) {
    throw new Error('Cloud 地址无效');
  }
  return match[1];
}

function parseCloudPairing(value) {
  const parts = String(value).trim().split('/#lanpower-client=');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
    throw new Error('请扫描 Cloud 的“已授权客户端”页面生成的二维码');
  }
  return {url: cloudOrigin(parts[0]), code: parts[1]};
}

function validTokens(data) {
  return data && ID.test(data.client_id || '') && TOKEN.test(data.access_token || '') &&
    TOKEN.test(data.refresh_token || '') && Number.isSafeInteger(data.access_expires_at);
}

function savedSession(url, data) {
  return {url, client_id: data.client_id, access_token: data.access_token,
    refresh_token: data.refresh_token, access_expires_at: data.access_expires_at};
}

function request(wxApi, url, method, data, token) {
  return new Promise((resolve, reject) => wxApi.request({url, method, data, timeout: 10000,
    header: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    success: resolve, fail: () => reject(new Error('连接失败，请检查网络和 Cloud 地址'))}));
}

class CloudClient {
  constructor(wxApi, session) {
    cloudOrigin(session.url);
    if (!validTokens(session)) throw new Error('请重新扫描 Cloud 授权二维码');
    this.wx = wxApi;
    this.session = session;
  }

  static load(wxApi) {
    const saved = wxApi.getStorageSync(CLIENT_KEY);
    if (!saved) return null;
    try { return new CloudClient(wxApi, saved); }
    catch (_) { wxApi.removeStorageSync(CLIENT_KEY); return null; }
  }

  static async enroll(wxApi, pairing) {
    cloudOrigin(pairing.url);
    let response = await request(wxApi, pairing.url + '/api/v2/clients/enroll', 'POST',
      {code: pairing.code, version: VERSION, protocol_version: PROTOCOL_VERSION});
    // Earlier v2 Clouds reject extra fields before consuming the one-time code.
    // Retry only that explicit response, never a lost or uncertain response.
    if (response.statusCode === 400 && response.data && response.data.error === 'invalid enrollment') {
      response = await request(wxApi, pairing.url + '/api/v2/clients/enroll', 'POST', {code: pairing.code});
    }
    if (response.statusCode !== 200 || !validTokens(response.data)) throw new Error('授权码无效或已使用，请在 Cloud 重新生成');
    const session = savedSession(pairing.url, response.data);
    wxApi.setStorageSync(CLIENT_KEY, session);
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
      const response = await request(this.wx, original.url + '/api/v2/clients/renew', 'POST',
        {client_id: original.client_id, refresh_token: original.refresh_token});
      if (this.closed) throw new Error('连接已关闭');
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
      try { this.wx.setStorageSync(CLIENT_KEY, next); }
      catch (_) { throw new Error('无法保存 Cloud 授权，请检查手机存储后重试'); }
      this.session = next;
    }).finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  async call(path, method = 'GET', data) {
    if (this.closed) throw new Error('连接已关闭');
    if (!/^\/api\/v2\//.test(path)) throw new Error('请求地址无效');
    if (this.session.refresh_pending || this.session.access_expires_at <= Date.now() / 1000 + 30) await this.refresh();
    const sent = this.session.access_token;
    let response = await request(this.wx, this.session.url + path, method, data, sent);
    if (response.statusCode === 401) {
      if (this.session.access_token === sent) await this.refresh();
      response = await request(this.wx, this.session.url + path, method, data, this.session.access_token);
    }
    if (response.statusCode !== 200) {
      if (response.statusCode === 401) throw authorizationError();
      throw new Error(response.statusCode === 429 ? '操作过于频繁，请稍后重试' : '操作不可用，请刷新设备状态');
    }
    return response.data;
  }

  close() { this.closed = true; }
}

module.exports = {CLIENT_KEY, CloudClient, parseCloudPairing};
