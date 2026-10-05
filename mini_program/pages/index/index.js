const {broadcastWake, makeMagicPacket, PC_MAC, BROADCAST} = require('../../utils/wol');
const {parsePairingLink} = require('../../utils/pairing');
const {parseRemotePairing} = require('../../utils/remote');
const {storageKey} = require('../../utils/environment');
const {openPage} = require('../../utils/navigation');

const LOCAL_KEY = 'lanpower_pairing_v1';
const REMOTE_KEY = 'lanpower_remote_v1';
const ACTION_NAMES = {sleep: '睡眠', hibernate: '休眠', restart: '重启', shutdown: '关机'};

Page({
  data: {
    paired: false, remotePaired: false, host: '', device: '我的 Windows 电脑',
    state: 'unpaired', stateText: '未配对', detail: '先扫描电脑上的配对二维码',
    feedback: '', busy: false, canControl: false, canWake: false, wakeRoute: 'none',
    mode: 'none', modeText: '未连接', mac: '', broadcast: BROADCAST, wakeOpen: false, wakeConfigured: false
  },

  onLoad() {
    this.localStorageKey = storageKey(wx, LOCAL_KEY);
    this.remoteStorageKey = storageKey(wx, REMOTE_KEY);
    const local = wx.getStorageSync(this.localStorageKey);
    if (local && typeof local.host === 'string' && /^[0-9a-f]{64}$/i.test(local.token || '')) {
      this.pairing = local;
      const target = this.localWakeTarget();
      this.setData({paired: true, host: local.host, canWake: !!target, wakeRoute: target ? 'local' : 'none',
        mac: target ? target.mac : '', broadcast: target ? target.broadcast : BROADCAST, wakeConfigured: !!target});
    }
    const remote = wx.getStorageSync(this.remoteStorageKey);
    if (remote && typeof remote.url === 'string') {
      try {
        this.remote = parseRemotePairing(`${remote.url}/#lanpower-remote=${remote.gatewayId}.${remote.token}`);
        this.setData({remotePaired: true});
      } catch (_) { wx.removeStorageSync(this.remoteStorageKey); }
    }
  },

  onShow() {
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 15000);
  },

  onHide() {
    this.stopTimers();
    this.refreshSerial = (this.refreshSerial || 0) + 1;
    this.refreshQueued = false;
    if (this.data.state === 'waking') {
      this.setData({state: 'offline', stateText: '等待开机', detail: '返回页面后会重新检查电脑状态',
        canWake: !!this.localWakeTarget() || !!this.remote});
    }
  },

  onUnload() { this.stopTimers(); },

  goCloud() {
    openPage(wx, 'codex');
  },
  localWakeTarget() {
    if (!this.pairing) return null;
    // Preserve older installations with a customized constant, but never wake a demonstration MAC.
    const mac = this.pairing.mac || (PC_MAC !== '02-11-22-33-44-55' ? PC_MAC : '');
    return mac ? {mac, broadcast: this.pairing.broadcast || BROADCAST} : null;
  },
  toggleWakeSettings() { this.setData({wakeOpen: !this.data.wakeOpen}); },
  editMac(event) { this.setData({mac: event.detail.value}); },
  editBroadcast(event) { this.setData({broadcast: event.detail.value}); },
  saveWakeSettings() {
    if (!this.pairing || this.data.busy) return;
    try {
      const mac = this.data.mac.trim(), broadcast = this.data.broadcast.trim();
      makeMagicPacket(mac);
      const octets = broadcast.split('.');
      if (octets.length !== 4 || octets.some(o => !/^\d{1,3}$/.test(o) || Number(o) > 255)) throw new Error('广播地址无效');
      this.pairing = {...this.pairing, mac, broadcast};
      wx.setStorageSync(this.localStorageKey, this.pairing);
      this.setData({wakeConfigured: true, feedback: '局域网唤醒设置已保存。'});
      this.refresh();
    } catch (error) { this.setData({feedback: error.message}); }
  },
  dismissFeedback() { this.setData({feedback: ''}); },

  stopTimers() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.refreshTimer = null;
    this.wakeTimer = null;
  },

  scanPairing() {
    wx.scanCode({onlyFromCamera: true, scanType: ['qrCode'], success: (result) => {
      try {
        const parsed = parsePairingLink(result.result);
        const pairing = {...(this.pairing && this.pairing.host === parsed.host ? this.pairing : {}), ...parsed};
        wx.setStorageSync(this.localStorageKey, pairing);
        this.pairing = pairing;
        const target = this.localWakeTarget();
        this.setData({paired: true, host: pairing.host, canWake: !!target, wakeRoute: target ? 'local' : 'none',
          mac: target ? target.mac : '', broadcast: target ? target.broadcast : BROADCAST, wakeConfigured: !!target,
          wakeOpen: !target, feedback: '局域网已配对。需要离线开机时，请继续填写唤醒设置。'});
        this.refreshSerial = (this.refreshSerial || 0) + 1;
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
        wx.setStorageSync(this.remoteStorageKey, remote);
        this.remote = remote;
        this.setData({remotePaired: true, feedback: '远程配对信息已保存。'});
        this.refreshSerial = (this.refreshSerial || 0) + 1;
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
        wx.removeStorageSync(this.localStorageKey);
        this.pairing = null;
        this.setData({paired: false, host: '', feedback: '', canControl: false, mac: '', broadcast: BROADCAST, wakeConfigured: false, wakeOpen: false,
          canWake: !!this.remote, wakeRoute: this.remote ? 'remote' : 'none'});
        this.refreshSerial = (this.refreshSerial || 0) + 1;
        this.refresh();
      }
    });
  },

  clearRemotePairing() {
    wx.showModal({title: '清除远程配对', content: '确定移除远程配对信息吗？',
      success: ({confirm}) => {
        if (!confirm) return;
        wx.removeStorageSync(this.remoteStorageKey);
        this.remote = null;
        this.setData({remotePaired: false, feedback: '', canControl: false,
          canWake: !!this.localWakeTarget(), wakeRoute: this.localWakeTarget() ? 'local' : 'none'});
        this.refreshSerial = (this.refreshSerial || 0) + 1;
        this.refresh();
      }
    });
  },

  refresh() {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    const pending = Promise.resolve().then(() => this.refreshOnce());
    this.refreshInFlight = pending;
    return pending.finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refresh();
      }
    });
  },

  refreshOnce() {
    const serial = this.refreshSerial = (this.refreshSerial || 0) + 1;
    if (!this.pairing && !this.remote) {
      this.setData({state: 'unpaired', stateText: '未配对', mode: 'none', modeText: '未连接',
        canControl: false, canWake: false, wakeRoute: 'none'});
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
      this.markOffline('local', this.localWakeTarget() ? '电脑未连接，可尝试局域网唤醒' : '电脑未连接；离线开机需先保存局域网唤醒设置');
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
      canWake: false, wakeRoute: mode,
      device: device || this.data.device, canControl: !this.data.busy, busy: false,
      feedback: this.data.state === 'waking' ? '电脑已开机。' : this.data.feedback
    });
  },

  markOffline(mode, detail) {
    const wakeRoute = mode === 'remote' && this.remote ? 'remote' : this.localWakeTarget() ? 'local' : 'none';
    const localFallback = mode === 'none' && wakeRoute === 'local';
    const changes = {
      mode, wakeRoute, canWake: wakeRoute !== 'none' && this.data.state !== 'waking',
      modeText: localFallback ? '局域网唤醒可用' : mode === 'remote' ? '远程' : mode === 'local' ? '局域网' : '未连接',
      canControl: false
    };
    if (this.data.state !== 'waking') {
      Object.assign(changes, {state: 'offline', stateText: localFallback ? '远程不可用' : mode === 'remote' ? '离线 · 远程' : '离线',
        detail: localFallback ? `${detail}；仍可通过局域网唤醒` : detail});
    }
    this.setData(changes);
  },

  startWakeWait(mode) {
    this.setData({state: 'waking', stateText: '正在唤醒', mode,
      modeText: mode === 'remote' ? '远程' : '局域网', wakeRoute: mode, canWake: false,
      detail: '已发送网络唤醒包，等待电脑启动', feedback: '已发送唤醒包。', canControl: false});
    const started = Date.now();
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = setInterval(() => {
      if (Date.now() - started > 60000) {
        clearInterval(this.wakeTimer);
        this.wakeTimer = null;
        this.setData({state: 'offline', stateText: '未检测到开机', detail: '一分钟内没有检测到电脑',
          canWake: this.data.wakeRoute !== 'none', feedback: '唤醒包已发送，但电脑仍未上线。'});
        return;
      }
      this.refresh();
    }, 2500);
  },

  wake() {
    if (this.data.state === 'online') return wx.showToast({title: '电脑已经在线', icon: 'none'});
    if (this.data.state === 'waking' || !this.data.canWake) return;
    if (this.data.wakeRoute === 'remote' && this.remote) {
      this.remoteCommand('wake', (response) => {
        if (response.statusCode === 200 && response.data && response.data.ok) this.startWakeWait('remote');
        else this.setData({feedback: '远程唤醒失败，请检查网关状态'});
      }, () => this.setData({feedback: '远程唤醒请求失败'}));
      return;
    }
    if (!this.pairing) return;
    try {
      broadcastWake(wx, (message) => this.setData({feedback: `唤醒包发送异常：${message}`}), this.localWakeTarget());
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
