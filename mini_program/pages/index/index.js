const {broadcastWake, PC_MAC} = require('../../utils/wol');
const {parsePairingLink} = require('../../utils/pairing');
const {parseRemotePairing} = require('../../utils/remote');

const LOCAL_KEY = 'lanpower_pairing_v1';
const REMOTE_KEY = 'lanpower_remote_v1';
const ACTION_NAMES = {sleep: '睡眠', hibernate: '休眠', restart: '重启', shutdown: '关机'};

Page({
  data: {
    paired: false, remotePaired: false, host: '', device: '我的 Windows 电脑',
    state: 'unpaired', stateText: '未配对', detail: '先扫描电脑上的配对二维码',
    feedback: '', busy: false, canControl: false, mode: 'none', modeText: '未连接', mac: PC_MAC
  },

  onLoad() {
    const local = wx.getStorageSync(LOCAL_KEY);
    if (local && typeof local.host === 'string' && /^[0-9a-f]{64}$/i.test(local.token || '')) {
      this.pairing = local;
      this.setData({paired: true, host: local.host});
    }
    const remote = wx.getStorageSync(REMOTE_KEY);
    if (remote && typeof remote.url === 'string') {
      try {
        this.remote = parseRemotePairing(`${remote.url}/#lanpower-remote=${remote.gatewayId}.${remote.token}`);
        this.setData({remotePaired: true});
      } catch (_) { wx.removeStorageSync(REMOTE_KEY); }
    }
  },

  onShow() {
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 15000);
  },

  onHide() {
    this.stopTimers();
    if (this.data.state === 'waking') {
      this.setData({state: 'offline', stateText: '等待开机', detail: '返回页面后会重新检查电脑状态'});
    }
  },

  onUnload() { this.stopTimers(); },

  stopTimers() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.refreshTimer = null;
    this.wakeTimer = null;
  },

  scanPairing() {
    wx.scanCode({onlyFromCamera: true, scanType: ['qrCode'], success: (result) => {
      try {
        const pairing = parsePairingLink(result.result);
        wx.setStorageSync(LOCAL_KEY, pairing);
        this.pairing = pairing;
        this.setData({paired: true, host: pairing.host, feedback: '局域网配对信息已保存。'});
        this.refresh();
      } catch (error) {
        wx.showModal({title: '配对失败', content: error.message, showCancel: false});
      }
    }});
  },

  scanRemotePairing() {
    wx.scanCode({onlyFromCamera: true, scanType: ['qrCode'], success: (result) => {
      try {
        const remote = parseRemotePairing(result.result);
        wx.setStorageSync(REMOTE_KEY, remote);
        this.remote = remote;
        this.setData({remotePaired: true, feedback: '远程配对信息已保存。'});
        this.refresh();
      } catch (error) {
        wx.showModal({title: '远程配对失败', content: error.message, showCancel: false});
      }
    }});
  },

  clearPairing() {
    wx.showModal({title: '清除局域网配对', content: '确定移除这台电脑的局域网配对信息吗？',
      success: ({confirm}) => {
        if (!confirm) return;
        wx.removeStorageSync(LOCAL_KEY);
        this.pairing = null;
        this.setData({paired: false, host: '', feedback: '', canControl: false});
        this.refresh();
      }
    });
  },

  clearRemotePairing() {
    wx.showModal({title: '清除远程配对', content: '确定移除远程配对信息吗？',
      success: ({confirm}) => {
        if (!confirm) return;
        wx.removeStorageSync(REMOTE_KEY);
        this.remote = null;
        this.setData({remotePaired: false, feedback: '', canControl: false});
        this.refresh();
      }
    });
  },

  refresh() {
    const serial = this.refreshSerial = (this.refreshSerial || 0) + 1;
    if (!this.pairing && !this.remote) {
      this.setData({state: 'unpaired', stateText: '未配对', mode: 'none', modeText: '未连接', canControl: false});
      return Promise.resolve(false);
    }
    if (this.data.state !== 'waking') this.setData({state: 'checking', stateText: '正在连接', canControl: false});
    if (!this.pairing) return this.refreshRemote(serial);
    return new Promise((resolve) => {
      wx.request({
        url: `http://${this.pairing.host}:48211/api/status`, method: 'GET', timeout: 3500,
        header: {'Authorization': `Bearer ${this.pairing.token}`},
        success: (response) => {
          if (serial !== this.refreshSerial) return resolve(false);
          if (response.statusCode === 200 && response.data && response.data.state === 'online') {
            this.markOnline('local', response.data.device);
            return resolve(true);
          }
          this.refreshRemote(serial).then(resolve);
        },
        fail: () => {
          if (serial !== this.refreshSerial) return resolve(false);
          this.refreshRemote(serial).then(resolve);
        }
      });
    });
  },

  refreshRemote(serial) {
    if (!this.remote) {
      this.markOffline('local', '电脑未连接；开机可点下方按钮');
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const remote = this.remote;
      wx.request({
        url: `${remote.url}/api/v1/client/status?gateway_id=${encodeURIComponent(remote.gatewayId)}`,
        method: 'GET', timeout: 5000,
        header: {'Authorization': `Bearer ${remote.token}`},
        success: (response) => {
          if (serial !== this.refreshSerial) return resolve(false);
          if (response.statusCode === 200 && response.data && response.data.gateway === 'online') {
            if (response.data.pc === 'online') {
              this.markOnline('remote');
              return resolve(true);
            }
            this.markOffline('remote', '网关在线，电脑未开机');
          } else if (response.statusCode === 401) {
            this.markOffline('none', '远程配对失效，请重新扫码');
          } else {
            this.markOffline('none', '远程网关暂时不可用');
          }
          resolve(false);
        },
        fail: () => {
          if (serial !== this.refreshSerial) return resolve(false);
          this.markOffline('none', '远程服务暂时不可用');
          resolve(false);
        }
      });
    });
  },

  markOnline(mode, device) {
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = null;
    this.setData({
      state: 'online', stateText: mode === 'local' ? '在线 · 局域网' : '在线 · 远程',
      mode, modeText: mode === 'local' ? '局域网' : '远程', detail: '可以发送电源指令',
      device: device || this.data.device, canControl: !this.data.busy, busy: false,
      feedback: this.data.state === 'waking' ? '电脑已开机。' : this.data.feedback
    });
  },

  markOffline(mode, detail) {
    const changes = {mode, modeText: mode === 'remote' ? '远程' : mode === 'local' ? '局域网' : '未连接', canControl: false};
    if (this.data.state !== 'waking') {
      Object.assign(changes, {state: 'offline', stateText: mode === 'remote' ? '离线 · 远程' : '离线', detail});
    }
    this.setData(changes);
  },

  startWakeWait(mode) {
    this.setData({state: 'waking', stateText: '正在唤醒', mode,
      modeText: mode === 'remote' ? '远程' : '局域网',
      detail: '已发送网络唤醒包，等待电脑启动', feedback: '已发送唤醒包。', canControl: false});
    const started = Date.now();
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = setInterval(() => {
      if (Date.now() - started > 60000) {
        clearInterval(this.wakeTimer);
        this.wakeTimer = null;
        this.setData({state: 'offline', stateText: '未检测到开机', detail: '一分钟内没有检测到电脑', feedback: '唤醒包已发送，但电脑仍未上线。'});
        return;
      }
      this.refresh();
    }, 2500);
  },

  wake() {
    if (this.data.state === 'online') return wx.showToast({title: '电脑已经在线', icon: 'none'});
    if (this.data.state === 'waking' || this.data.mode === 'none') return;
    if (this.data.mode === 'remote' && this.remote) {
      this.remoteCommand('wake', (response) => {
        if (response.statusCode === 200 && response.data && response.data.ok) this.startWakeWait('remote');
        else this.setData({feedback: '远程唤醒失败，请检查网关状态'});
      }, () => this.setData({feedback: '远程唤醒请求失败'}));
      return;
    }
    if (!this.pairing) return;
    try {
      broadcastWake(wx, (message) => this.setData({feedback: `唤醒包发送异常：${message}`}));
      this.startWakeWait('local');
    } catch (error) { this.setData({feedback: error.message}); }
  },

  remoteCommand(action, success, fail) {
    const remote = this.remote;
    wx.request({url: `${remote.url}/api/v1/client/commands`, method: 'POST', timeout: 34000,
      header: {'Authorization': `Bearer ${remote.token}`, 'Content-Type': 'application/json'},
      data: {gateway_id: remote.gatewayId, action}, success, fail});
  },

  sendAction(event) {
    const action = event.currentTarget.dataset.action;
    const name = ACTION_NAMES[action];
    if (!name || !this.data.canControl) return;
    wx.showModal({title: `确定${name}？`, content: `电脑将立即${name}。`,
      confirmColor: action === 'shutdown' ? '#d65e68' : '#2489d6',
      success: ({confirm}) => {
        if (!confirm) return;
        const mode = this.data.mode;
        this.setData({busy: true, canControl: false, feedback: '正在发送指令…'});
        const success = (response) => {
          const accepted = mode === 'local' ? response.statusCode === 202 :
            response.statusCode === 200 && response.data && response.data.ok;
          if (accepted) {
            this.setData({state: 'checking', stateText: '正在切换', detail: `电脑即将${name}`,
              feedback: `${name}指令已送达。`, busy: false, canControl: false});
          } else {
            this.setData({feedback: `指令失败：HTTP ${response.statusCode}`, busy: false});
            this.refresh();
          }
        };
        const fail = () => {
          this.setData({feedback: '指令发送失败，请检查连接', busy: false});
          this.refresh();
        };
        if (mode === 'remote' && this.remote) this.remoteCommand(action, success, fail);
        else if (mode === 'local' && this.pairing) {
          wx.request({url: `http://${this.pairing.host}:48211/api/power`, method: 'POST', timeout: 5000,
            header: {'Authorization': `Bearer ${this.pairing.token}`, 'Content-Type': 'application/json'},
            data: {action}, success, fail});
        }
      }
    });
  }
});
