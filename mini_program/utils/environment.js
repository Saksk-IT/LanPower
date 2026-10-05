const DEVELOPMENT_CLOUD_KEY = 'lanpower_cloud_url_develop_v1';
const LABELS = {develop: '开发版', trial: '体验版', release: '正式版'};

function environment(wxApi) {
  let name = 'release';
  try {
    const account = wxApi.getAccountInfoSync();
    const value = account && account.miniProgram && account.miniProgram.envVersion;
    if (Object.prototype.hasOwnProperty.call(LABELS, value)) name = value;
  } catch (_) {}
  return {name, label: LABELS[name], development: name === 'develop'};
}

function localHost(host) {
  if (host === 'localhost' || host === '[::1]') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || +part > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function assertReachableCloud(url, wxApi) {
  let platform = '';
  for (const name of ['getDeviceInfo', 'getSystemInfoSync']) {
    try {
      if (typeof wxApi[name] === 'function') platform = String(wxApi[name]().platform || '').toLowerCase();
    } catch (_) {}
    if (platform) break;
  }
  if (!['ios', 'android', 'ohos', 'harmony'].includes(platform)) return;
  const host = /^https?:\/\/([a-z0-9.-]+|\[::1\])(?::[0-9]+)?$/i.exec(url);
  const hostname = host && host[1].toLowerCase();
  if (hostname && (hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))) {
    const error = new Error('手机上的 localhost / 127.0.0.1 指向手机自己。请填写电脑的局域网 HTTPS 地址，并在该地址的网页生成授权二维码。');
    error.code = 'CLOUD_LOOPBACK';
    throw error;
  }
}

function cloudOrigin(value, wxApi) {
  const match = /^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::([0-9]{1,5}))?$/i.exec(value || '');
  if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535))) throw new Error('Cloud 地址无效，请只填写协议、主机和端口');
  const scheme = match[1].toLowerCase(), host = match[2].toLowerCase();
  if (host !== '[::1]' && (host.length > 253 || host.split('.').some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new Error('Cloud 地址无效');
  if (/^[0-9.]+$/.test(host) && (host.split('.').length !== 4 || host.split('.').some(part =>
    !/^(0|[1-9][0-9]{0,2})$/.test(part) || +part > 255))) throw new Error('Cloud 地址无效');
  if (scheme === 'http' && !(environment(wxApi).development && localHost(host))) {
    throw new Error('Cloud 需要 HTTPS；开发版仅允许本机或局域网地址使用 HTTP');
  }
  return scheme + '://' + host + (match[3] ? ':' + Number(match[3]) : '');
}

function developmentCloud(wxApi) {
  if (!environment(wxApi).development) return '';
  try {
    const saved = wxApi.getStorageSync(DEVELOPMENT_CLOUD_KEY);
    return saved ? cloudOrigin(saved, wxApi) : '';
  } catch (_) { return ''; }
}

function setDevelopmentCloud(wxApi, value) {
  if (!environment(wxApi).development) throw new Error('只有开发版可以修改测试 Cloud 地址');
  const input = String(value || '').trim();
  const url = input ? cloudOrigin(input.replace(/\/+$/, ''), wxApi) : '';
  if (url) assertReachableCloud(url, wxApi);
  if (url) wxApi.setStorageSync(DEVELOPMENT_CLOUD_KEY, url);
  else wxApi.removeStorageSync(DEVELOPMENT_CLOUD_KEY);
  return url;
}

function storageKey(wxApi, key, url) {
  const {name} = environment(wxApi);
  if (name === 'develop') return key + ':develop:' + (url === undefined ? developmentCloud(wxApi) : url);
  return name === 'trial' ? key + ':trial' : key;
}

module.exports = {environment, cloudOrigin, developmentCloud, setDevelopmentCloud, storageKey, localHost,
  assertReachableCloud, DEVELOPMENT_CLOUD_KEY};
