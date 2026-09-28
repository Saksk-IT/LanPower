const PC_MAC = '02-11-22-33-44-55';
const BROADCAST = '192.168.1.255';

function makeMagicPacket(mac) {
  const compact = mac.replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(compact)) {
    throw new Error('电脑网卡地址无效');
  }
  const macBytes = [];
  for (let i = 0; i < 12; i += 2) {
    macBytes.push(parseInt(compact.slice(i, i + 2), 16));
  }
  const bytes = new Uint8Array(102);
  bytes.fill(0xff, 0, 6);
  for (let repeat = 0; repeat < 16; repeat += 1) {
    bytes.set(macBytes, 6 + repeat * 6);
  }
  return bytes.buffer;
}

function broadcastWake(wxApi, onError) {
  if (typeof wxApi.createUDPSocket !== 'function') {
    throw new Error('当前微信版本不支持局域网唤醒');
  }
  const socket = wxApi.createUDPSocket();
  socket.onError((error) => onError(error && error.errMsg ? error.errMsg : 'UDP 发送失败'));
  try {
    socket.bind();
  } catch (error) {
    socket.close();
    throw error;
  }
  const packet = makeMagicPacket(PC_MAC);
  const addresses = ['255.255.255.255', BROADCAST];
  let sent = 0;
  const send = () => {
    for (const address of addresses) {
      try {
        socket.send({address, port: 9, message: packet, setBroadcast: true});
        sent += 1;
      } catch (error) {
        onError(error.message || 'UDP 发送失败');
      }
    }
  };
  send();
  const firstRepeat = setTimeout(send, 350);
  const secondRepeat = setTimeout(send, 700);
  setTimeout(() => {
    clearTimeout(firstRepeat);
    clearTimeout(secondRepeat);
    socket.close();
  }, 1500);
  return sent;
}

module.exports = {PC_MAC, BROADCAST, makeMagicPacket, broadcastWake};
