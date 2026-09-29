function parseRemotePairing(input) {
  const match = /^(https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?)\/#lanpower-remote=([A-Za-z0-9_-]{3,64})\.([0-9a-f]{64})$/i.exec(String(input).trim());
  if (!match || match[1].includes('..')) {
    throw new Error('请扫描远程服务生成的配对二维码');
  }
  return {url: match[1], gatewayId: match[2], token: match[3]};
}

module.exports = {parseRemotePairing};
