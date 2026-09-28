const {broadcastWake, PC_MAC} = require('../../utils/wol');
const {parsePairingLink} = require('../../utils/pairing');

const STORAGE_KEY = 'lanpower_pairing_v1';
const ACTION_NAMES = {sleep: '睡眠', hibernate: '休眠', restart: '重启', shutdown: '关机'};

Page({
  data: {
    paired: false,
    host: '',
    device: '我的 Windows 电脑',
    state: 'unpaired',
    stateText: '未配对',
    detail: '先扫描电脑上的配对二维码',
    feedback: '',
    busy: false,
    canControl: false,
    mac: PC_MAC
  },

  onLoad() {
    const saved = wx.getStorageSync(STORAGE_KEY);
    if (saved && typeof saved.host === 'string' && /^[0-9a-f]{64}$/i.test(saved.token || '')) {
      this.pairing = saved;
      this.setData({paired: true, host: saved.host});
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

  onUnload() {
    this.stopTimers();
  },

  stopTimers() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.refreshTimer = null;
    this.wakeTimer = null;
  },

  scanPairing() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (result) => {
        try {
          const pairing = parsePairingLink(result.result);
          wx.setStorageSync(STORAGE_KEY, pairing);
          this.pairing = pairing;
          this.setData({paired: true, host: pairing.host, feedback: '配对信息已保存。'});
          this.refresh();
        } catch (error) {
          wx.showModal({title: '配对失败', content: error.message, showCancel: false});
        }
      }
    });
  },

  clearPairing() {
    wx.showModal({
      title: '清除配对',
      content: '确定移除这台电脑的配对信息吗？',
      success: ({confirm}) => {
        if (!confirm) return;
        wx.removeStorageSync(STORAGE_KEY);
        this.pairing = null;
        if (this.wakeTimer) clearInterval(this.wakeTimer);
        this.wakeTimer = null;
        this.setData({
          paired: false, host: '', state: 'unpaired', stateText: '未配对',
          detail: '先扫描电脑上的配对二维码', feedback: '', canControl: false, busy: false
        });
      }
    });
  },

  refresh() {
    if (!this.pairing) {
      this.setData({state: 'unpaired', stateText: '未配对', canControl: false});
      return Promise.resolve(false);
    }
    const pairing = this.pairing;
    if (this.data.state !== 'waking') {
      this.setData({state: 'checking', stateText: '正在连接', canControl: false});
    }
    return new Promise((resolve) => {
      wx.request({
        url: `http://${pairing.host}:48211/api/status`,
        method: 'GET',
        timeout: 3500,
        header: {'Authorization': `Bearer ${pairing.token}`},
        success: (response) => {
          if (response.statusCode === 200 && response.data && response.data.state === 'online') {
            if (this.wakeTimer) {
              clearInterval(this.wakeTimer);
              this.wakeTimer = null;
            }
            this.setData({
              state: 'online', stateText: '在线', detail: '可以发送电源指令',
              device: response.data.device || '我的 Windows 电脑',
              canControl: !this.data.busy, busy: false,
              feedback: this.data.state === 'waking' ? '电脑已开机。' : this.data.feedback
            });
            resolve(true);
            return;
          }
          if (response.statusCode === 401) {
            if (this.wakeTimer) clearInterval(this.wakeTimer);
            this.wakeTimer = null;
            this.setData({state: 'unpaired', stateText: '配对失效', detail: '请在电脑上重新扫码配对', canControl: false, busy: false});
            resolve(false);
            return;
          }
          this.markOffline();
          resolve(false);
        },
        fail: (error) => {
          const blocked = error && /domain|合法域名|url not in/i.test(error.errMsg || '');
          this.markOffline(blocked ? '微信阻止了本地连接，请检查小程序网络权限' : '电脑未连接；开机可点下方按钮');
          resolve(false);
        }
      });
    });
  },

  markOffline(detail) {
    if (this.data.state === 'waking') return;
    this.setData({
      state: 'offline', stateText: '离线',
      detail: detail || '电脑未连接；开机可点下方按钮',
      canControl: false
    });
  },

  wake() {
    if (!this.pairing) {
      this.scanPairing();
      return;
    }
    if (this.data.state === 'online') {
      wx.showToast({title: '电脑已经在线', icon: 'none'});
      return;
    }
    if (this.data.state === 'waking') return;
    try {
      broadcastWake(wx, (message) => {
        this.setData({feedback: `唤醒包发送异常：${message}`});
      });
    } catch (error) {
      this.setData({feedback: error.message});
      return;
    }
    this.setData({
      state: 'waking', stateText: '正在唤醒',
      detail: '已发送网络唤醒包，等待电脑启动',
      feedback: '已发送唤醒包。', canControl: false
    });
    const started = Date.now();
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = setInterval(() => {
      if (Date.now() - started > 60000) {
        clearInterval(this.wakeTimer);
        this.wakeTimer = null;
        this.setData({state: 'offline', stateText: '未检测到开机', detail: '请检查 Wi-Fi 和电脑电源', feedback: '唤醒包已发送，但一分钟内没有检测到电脑。'});
        return;
      }
      this.refresh();
    }, 2500);
  },

  sendAction(event) {
    const action = event.currentTarget.dataset.action;
    const name = ACTION_NAMES[action];
    if (!name || !this.pairing || !this.data.canControl) return;
    wx.showModal({
      title: `确定${name}？`,
      content: `电脑将立即${name}。`,
      confirmColor: action === 'shutdown' ? '#d65e68' : '#2489d6',
      success: ({confirm}) => {
        if (!confirm) return;
        this.setData({busy: true, canControl: false, feedback: '正在发送指令…'});
        wx.request({
          url: `http://${this.pairing.host}:48211/api/power`,
          method: 'POST',
          timeout: 5000,
          header: {
            'Authorization': `Bearer ${this.pairing.token}`,
            'Content-Type': 'application/json'
          },
          data: {action},
          success: (response) => {
            if (response.statusCode === 202) {
              this.setData({
                state: 'checking', stateText: '正在切换', detail: `电脑即将${name}`,
                feedback: `${name}指令已送达。`, busy: false, canControl: false
              });
              return;
            }
            this.setData({feedback: `指令失败：HTTP ${response.statusCode}`, busy: false});
            this.refresh();
          },
          fail: (error) => {
            this.setData({feedback: `发送失败：${error.errMsg || '网络错误'}`, busy: false});
            this.refresh();
          }
        });
      }
    });
  }
});
