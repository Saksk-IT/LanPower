const {environment, cloudOrigin, localHost, assertReachableCloud} = require('./environment');

function cloudConnectionError(wxApi, url, reason) {
  const message = String(reason && reason.errMsg || '').toLowerCase();
  const development = environment(wxApi).development;
  const host = /^https?:\/\/([a-z0-9.-]+|\[::1\])/i.exec(url);
  const local = host && localHost(host[1].toLowerCase());
  const localHttp = development && local && /^http:\/\//i.test(url);
  let code = 'CLOUD_NETWORK', hint;
  if (/domain list|not in.*domain|invalid.*domain|不在.*合法域名/.test(message)) {
    code = 'CLOUD_DOMAIN';
    hint = development ? '微信拦截了测试 Cloud 地址。手机开发预览请在小程序右上角菜单打开调试，再重新进入；开发者工具的设置需要在手机上单独核查。' :
      '微信拦截了 Cloud 地址，请检查微信后台的 request 合法域名配置。';
  } else if (/ssl|tls|certificate|cert[_ -]|证书/.test(message)) {
    code = 'CLOUD_TLS';
    hint = development && local ? '本机 Cloud 已改用 HTTP，请填写 http://电脑局域网IP:8080，开启微信开发调试后重试。' :
      '微信未接受 Cloud 的 HTTPS 证书，请检查证书信任、有效期和完整证书链。';
  } else if (/permission|access[ _-]denied|local network.*(denied|disabled)|无权限|权限.*拒绝/.test(message)) {
    code = 'CLOUD_NETWORK_PERMISSION';
    hint = '手机限制了网络访问，请在系统设置中允许微信访问本地网络，并连接电脑所在的 Wi-Fi。';
  } else if (/timeout|timed out|超时/.test(message)) {
    code = 'CLOUD_TIMEOUT';
    hint = '连接超时。请在手机浏览器打开同一 Cloud 地址，检查 Wi-Fi、VPN、路由器隔离和电脑防火墙。';
  } else {
    hint = localHttp ? '连接失败。请在手机浏览器打开同一 HTTP 地址，再检查微信调试设置、本地网络权限和电脑防火墙。' : local ? '连接失败。请在手机浏览器打开同一 Cloud 地址，再检查微信调试设置和本地网络权限。' :
      '连接失败，请检查手机网络、Cloud 地址和 HTTPS 证书。';
  }
  const error = new Error(hint);
  error.code = code;
  return error;
}

async function testDevelopmentCloud(wxApi, value) {
  if (!environment(wxApi).development) throw new Error('只有开发版可以检测测试 Cloud');
  const url = cloudOrigin(String(value || '').trim().replace(/\/+$/, ''), wxApi);
  assertReachableCloud(url, wxApi);
  const response = await new Promise((resolve, reject) => wxApi.request({
    url: url + '/healthz', method: 'GET', timeout: 10000,
    success: resolve, fail: reason => reject(cloudConnectionError(wxApi, url, reason))
  }));
  const health = response.data;
  if (response.statusCode !== 200 || !health || health.ok !== true || health.protocol_version !== '2' ||
      typeof health.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(health.version)) {
    throw new Error('该地址没有返回兼容的 Cloud 健康信息，请检查协议、端口和服务状态。');
  }
  return {url, version: health.version};
}

module.exports = {cloudConnectionError, testDevelopmentCloud};
