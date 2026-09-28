function parsePairingLink(input) {
  const match = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):48211\/#access=([0-9a-f]{64})$/i.exec(String(input).trim());
  if (!match) throw new Error('请扫描电脑配对页显示的二维码');
  const octets = match[1].split('.').map(Number);
  if (octets.some((value) => value > 255) ||
      !(octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168))) {
    throw new Error('二维码中的地址不是局域网地址');
  }
  return {host: match[1], token: match[2]};
}

module.exports = {parsePairingLink};
