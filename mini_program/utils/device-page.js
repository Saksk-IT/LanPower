const {CloudClient, parseCloudPairing} = require('./cloud');
const {parsePairingLink} = require('./pairing');
const {broadcastWake, makeMagicPacket} = require('./wol');
const {VERSION} = require('./version');
const {environment, developmentCloud, setDevelopmentCloud, storageKey} = require('./environment');
const {testDevelopmentCloud} = require('./cloud-connectivity');

const LOCAL_KEY = 'lanpower_device_lan_v2';
const {deviceCache, selectedDevice, saveDeviceSelection, deviceSummary} = require('./device-selection');
const {openPage} = require('./navigation');
const ACTIONS = {sleep: '睡眠', hibernate: '休眠', restart: '重启', shutdown: '关机', wake: '开机'};
const ACTION_HINTS = {
  sleep: '电脑将进入睡眠，稍后可以快速恢复。',
  hibernate: '电脑将保存当前状态后进入休眠。',
  restart: '电脑将关闭当前会话并重新启动 Windows。',
  shutdown: '电脑将完全关机，未保存的工作可能丢失。',
  wake: '将尝试唤醒这台电脑。需要事先开启网络唤醒；指令送达后，请以电脑上线状态为准。'
};
const NETWORK_LABELS = {wifi: 'Wi-Fi', '5g': '5G', '4g': '蜂窝网络', '3g': '蜂窝网络', '2g': '蜂窝网络', none: '无网络', unknown: '网络未知'};

function createDevicePage(mode) {
  return {
  data: {connected: false, devices: [], selectedId: '', selectedIndex: 0, device: '选择一台电脑', stateText: '尚未连接',
    detail: '先授权这部手机，再选择电脑', modeText: '未连接', routeHint: '等待连接', controlHint: '连接后可查看电脑状态并执行电源操作',
    paired: false, lanOpen: false, pageMode: mode, cloudHost: '', deviceMissing: false,
    cloudState: 'idle', cloudStatusText: '未授权', needsReauthorize: false, devicesLoaded: false, updatingList: false,
    networkType: 'unknown', networkText: '检测网络', statusClass: 'idle', wakeHint: '先连接并选择电脑',
    canControl: false, canWake: false, busy: false, feedback: '', feedbackKind: 'info', wakeDirty: false,
    mac: '', broadcast: '255.255.255.255', version: VERSION,
    environmentLabel: '正式版', development: false, developmentCloud: '', cloudUrlDraft: '', testingCloud: false,
    accountUsername: '', accountUrlDraft: '', loginUsername: '', accountRegister: false, accountFormVisible: true},

  onLoad(options = {}) {
    this.wakeDrafts = {};
    this.preferredDevice = options.computer || '';
    this.targetDevice = mode === 'power' ? this.preferredDevice : '';
    this.loadConnection();
    this.networkChanged = info => {
      this.networkType = info.networkType || (info.isConnected === false ? 'none' : 'unknown');
      if (mode === 'power') this.serial = (this.serial || 0) + 1;
      this.controlRoute = ''; this.wakeRoute = '';
      this.setData({canControl: false, canWake: false, statusClass: 'busy', stateText: '正在同步状态', networkType: this.networkType,
        networkText: NETWORK_LABELS[this.networkType] || '网络未知', wakeHint: '正在检查可用的唤醒方式',
        controlHint: '正在同步设备状态', routeHint: '正在检查局域网和 Cloud 连接'});
      if (this.visible) this.syncConnection();
    };
    if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(this.networkChanged);
  },
  loadConnection() {
    this.connectionTestSerial = (this.connectionTestSerial || 0) + 1;
    const current = environment(wx), url = developmentCloud(wx);
    this.lanStorageKey = storageKey(wx, LOCAL_KEY);
    this.client = CloudClient.load(wx);
    this.local = wx.getStorageSync(this.lanStorageKey) || {};
    // Page.route 是微信页面路径；电源通道使用独立字段，供返回导航正确识别页面。
    this.controlRoute = ''; this.wakeRoute = '';
    this.setData({environmentLabel: current.label, development: current.development, developmentCloud: url, cloudUrlDraft: url, testingCloud: false,
      connected: !!this.client, cloudHost: this.client ? this.client.session.url.replace(/^https?:\/\//, '') : '',
      accountUsername: this.client && this.client.session.account ? this.client.session.account.username : '',
      loginUsername: this.client && this.client.session.account ? this.client.session.account.username : this.data.loginUsername || '',
      accountUrlDraft: url || (this.client ? this.client.session.url : wx.getStorageSync(storageKey(wx, 'lanpower_account_cloud_v1')) || ''),
      cloudStatusText: this.client ? '已保存授权' : '未授权', cloudState: 'idle', needsReauthorize: false,
      devices: [], selectedId: '', selectedIndex: 0, device: '选择一台电脑', devicesLoaded: false, deviceMissing: false,
      paired: false, lanOpen: false, mac: '', broadcast: '255.255.255.255', wakeDirty: false,
      canControl: false, canWake: false, statusClass: 'idle', stateText: '尚未连接', modeText: '未连接',
      detail: '先授权这部手机，再选择电脑', routeHint: '等待连接', controlHint: '连接后可查看电脑状态并执行电源操作',
      wakeHint: '先连接并选择电脑', feedback: '', feedbackKind: 'info'});
    const cache = deviceCache(wx, this.client);
    if (this.client && cache && cache.url === this.client.session.url && cache.client_id === this.client.session.client_id && Array.isArray(cache.devices)) {
      const devices = cache.devices.map(deviceSummary);
      const device = devices.find(d => d.device_id === (this.targetDevice || this.preferredDevice || cache.selectedId));
      this.setData({devices, selectedId: device ? device.device_id : '', device: device ? device.name : '正在读取设备',
        selectedIndex: Math.max(0, devices.indexOf(device))});
      this.syncPairing();
    }
  },
  editCloudUrl(event) {
    this.connectionTestSerial = (this.connectionTestSerial || 0) + 1;
    this.setData({cloudUrlDraft: event.detail.value, testingCloud: false});
  },
  async testCloudConnection() {
    if (!environment(wx).development || this.data.busy || this.data.updatingList || this.data.testingCloud) return;
    const draft = this.data.cloudUrlDraft;
    const serial = this.connectionTestSerial = (this.connectionTestSerial || 0) + 1;
    this.setData({testingCloud: true});
    try {
      const result = await testDevelopmentCloud(wx, draft);
      if (serial !== this.connectionTestSerial || !environment(wx).development) return;
      this.notify(`已连接 Cloud ${result.version}。请保存 ${result.url}，并在同一地址的网页生成手机授权二维码。`, 'success');
    } catch (error) {
      if (serial === this.connectionTestSerial && environment(wx).development) this.notify(error.message, 'error');
    } finally {
      if (serial === this.connectionTestSerial) this.setData({testingCloud: false});
    }
  },
  saveDevelopmentCloud() { this.changeDevelopmentCloud(this.data.cloudUrlDraft); },
  clearDevelopmentCloud() { this.changeDevelopmentCloud(''); },
  changeDevelopmentCloud(value) {
    if (!environment(wx).development || this.data.busy || this.data.updatingList || this.data.testingCloud) return;
    try {
      const previous = developmentCloud(wx), url = setDevelopmentCloud(wx, value);
      this.setData({developmentCloud: url, cloudUrlDraft: url});
      if (url !== previous) {
        this.serial = (this.serial || 0) + 1;
        if (this.client) this.client.close();
        this.refreshAgain = false; this.refreshing = null; this.wakeDrafts = {};
        this.loadConnection();
        if (this.client) this.syncConnection();
      }
      this.notify(url ? (this.client ? '已恢复该测试 Cloud 的开发版授权。' : '测试地址已保存，请扫描该 Cloud 的手机授权二维码。') :
        '已清空测试地址，下次扫码选择 Cloud。已有开发版授权会保留。', 'success');
    } catch (error) { this.notify(error.message, 'error'); }
  },
  onShow() {
    this.visible = true;
    this.setData({accountFormVisible: true});
    clearInterval(this.timer);
    const latest = CloudClient.load(wx);
    if (!latest || !this.client || latest.storageKey !== this.client.storageKey || latest.session.client_id !== this.client.session.client_id || latest.session.refresh_token !== this.client.session.refresh_token) {
      if (this.client) this.client.close();
      this.serial = (this.serial || 0) + 1;
      this.refreshing = null; this.refreshAgain = false; this.wakeDrafts = {};
      this.loadConnection();
    } else this.client.session = latest.session;
    this.local = wx.getStorageSync(this.lanStorageKey) || {};
    const id = this.targetDevice || this.preferredDevice || selectedDevice(wx, this.client);
    if (id && id !== this.data.selectedId) {
      this.serial = (this.serial || 0) + 1;
      this.controlRoute = ''; this.wakeRoute = '';
      const cache = deviceCache(wx, this.client), devices = cache ? cache.devices.map(deviceSummary) : this.data.devices;
      const device = devices.find(row => row.device_id === id);
      this.setData({selectedId: device ? id : '', devices, device: device ? device.name : '正在读取设备', selectedIndex: Math.max(0, devices.indexOf(device)), canControl: false, canWake: false});
    }
    this.syncPairing();
    if (wx.getNetworkType) wx.getNetworkType({success: this.networkChanged});
    this.syncConnection();
    if (mode === 'power') this.timer = setInterval(() => this.refresh(), 5000);
    if (mode === 'devices') this.timer = setInterval(() => this.reloadDevices(), 10000);
  },
  syncConnection() { if (this.visible === false) return Promise.resolve(); return mode === 'power' ? this.refresh() : this.reloadDevices(); },
  onHide() {
    this.accountPassword = ''; this.accountRepeatPassword = '';
    this.setData({accountFormVisible: false});
    this.connectionTestSerial = (this.connectionTestSerial || 0) + 1;
    this.visible = false; clearInterval(this.timer); this.serial = (this.serial || 0) + 1;
    this.refreshAgain = false;
    this.controlRoute = ''; this.wakeRoute = '';
    this.deviceListRun = (this.deviceListRun || 0) + 1;
    this.setData({canControl: false, canWake: false, testingCloud: false, updatingList: false});
  },
  onUnload() {
    this.onHide();
    if (this.client) this.client.close();
    if (wx.offNetworkStatusChange) wx.offNetworkStatusChange(this.networkChanged);
  },
  async onPullDownRefresh() {
    try { await this.reloadDevices(); }
    finally { if (wx.stopPullDownRefresh) wx.stopPullDownRefresh(); }
  },
  notify(message, kind = 'info') { this.setData({feedback: message, feedbackKind: kind}); },
  dismissFeedback() { this.setData({feedback: ''}); },
  cloudError(error) {
    const needsReauthorize = error.code === 'REAUTHORIZE' || this.data.needsReauthorize;
    this.setData({needsReauthorize, cloudState: needsReauthorize ? 'reauthorize' : 'unavailable',
      cloudStatusText: needsReauthorize ? '需要重新授权' : '暂时无法连接'});
  },
  openDevice(event) {
    if (this.data.busy || this.data.updatingList) return;
    const device = this.data.devices.find(row => row.device_id === event.currentTarget.dataset.id);
    if (!device) return;
    saveDeviceSelection(wx, this.client, this.data.devices, device.device_id);
    openPage(wx, 'power', device.device_id);
  },
  openDevices() { openPage(wx, 'devices'); },
  openCodex() { if (this.data.selectedId && !this.data.busy) openPage(wx, 'codex', this.data.selectedId); },
  openSettings() { openPage(wx, 'settings', this.data.selectedId); },
  openPower() { openPage(wx, 'power', this.data.selectedId); },
  openHelp() { openPage(wx, 'help'); },
  openLocal() { openPage(wx, 'lan'); },
  toggleLan() { this.setData({lanOpen: !this.data.lanOpen}); },
  scanFailed(error) {
    if (!/cancel/.test(error.errMsg || '')) this.notify('无法打开扫码，请检查微信相机权限后重试。', 'error');
  },

  editAccountUrl(event) { this.setData({accountUrlDraft: event.detail.value}); },
  editAccountUsername(event) { this.setData({loginUsername: event.detail.value}); },
  editAccountPassword(event) { this.accountPassword = event.detail.value; },
  editAccountRepeatPassword(event) { this.accountRepeatPassword = event.detail.value; },
  toggleAccountRegister() {
    if (!this.data.busy) this.setData({accountRegister: !this.data.accountRegister});
  },
  async loginAccount() {
    if (this.data.busy || this.data.updatingList) return;
    if (this.data.accountRegister && this.accountPassword !== this.accountRepeatPassword) {
      this.notify('两次输入的密码不一致。', 'error'); return;
    }
    this.setData({busy: true});
    try {
      const client = await CloudClient.accountLogin(wx, {url: this.data.accountUrlDraft,
        username: this.data.loginUsername, password: this.accountPassword, register: this.data.accountRegister});
      if (this.client) this.client.close();
      this.serial = (this.serial || 0) + 1;
      this.wakeDrafts = {}; this.refreshAgain = false; this.refreshing = null;
      this.loadConnection();
      this.setData({accountRegister: false, accountFormVisible: false});
      this.notify('已登录，正在读取账号下的电脑。', 'success');
      this.accountLoggedIn = true;
    } catch (error) { this.notify(error.message, 'error'); }
    finally {
      this.accountPassword = ''; this.accountRepeatPassword = '';
      this.setData({busy: false, accountFormVisible: false}, () => {
        if (!this.data.connected || this.data.needsReauthorize) this.setData({accountFormVisible: true});
      });
      if (this.accountLoggedIn) {
        this.accountLoggedIn = false;
        await this.reloadDevices();
        if (this.visible) this.openDevices();
      }
    }
  },

  scanCloud() {
    if (this.data.busy) return;
    wx.scanCode({onlyFromCamera: true, scanType: ['qrCode'], success: async ({result}) => {
      let pairing;
      try {
        pairing = parseCloudPairing(result, wx);
        const target = developmentCloud(wx);
        if (target && pairing.url !== target) throw new Error('授权码与测试 Cloud 地址不同，请在该测试 Cloud 生成授权二维码');
      }
      catch (error) { this.notify(error.message, 'error'); return; }
      wx.showModal({title: '授权这部手机', content: `允许此手机连接 ${pairing.url} 并查看、控制已授权的 Windows 电脑？\n\n凭据保存在这部手机，可在小程序或 Cloud 网页撤销授权。`,
        success: async ({confirm}) => {
          if (!confirm || this.data.busy) return;
          this.serial = (this.serial || 0) + 1;
          this.setData({busy: true});
          try {
            const client = await CloudClient.enroll(wx, pairing);
            const sameCloud = this.client && this.client.session.url === pairing.url;
            this.serial = (this.serial || 0) + 1;
            if (this.client) this.client.close();
            this.client = client;
            this.lanStorageKey = storageKey(wx, LOCAL_KEY);
                    this.local = wx.getStorageSync(this.lanStorageKey) || {};
            if (!sameCloud) this.wakeDrafts = {};
            this.controlRoute = ''; this.wakeRoute = '';
            this.setData({connected: true, ...(sameCloud ? {} : {devices: [], selectedId: '', selectedIndex: 0, device: '选择一台电脑'}),
              cloudHost: pairing.url.replace(/^https?:\/\//, ''), cloudState: 'online', cloudStatusText: '已连接', needsReauthorize: false,
              developmentCloud: developmentCloud(wx), cloudUrlDraft: developmentCloud(wx),
              devicesLoaded: false, canControl: false, canWake: false, statusClass: 'busy', stateText: '正在同步状态',
              routeHint: '正在读取电脑列表', controlHint: '选择电脑后显示可执行操作', wakeHint: '正在检查可用的唤醒方式'});
            this.preferredDevice = '';
      this.syncPairing(); this.cacheDevices();
            this.notify('手机已授权，正在读取我的设备。', 'success');
            this.enrolled = true;
            if (wx.pageScrollTo) wx.pageScrollTo({scrollTop: 0, duration: 0});
          } catch (error) { this.notify(error.message, 'error'); }
          finally {
            this.setData({busy: false}); await this.syncConnection();
            if (this.enrolled && this.visible) { this.enrolled = false; this.openDevices(); }
          }
        }});
    }, fail: error => this.scanFailed(error)});
  },

  disconnect() {
    if (!this.client || this.data.busy) return;
    const client = this.client;
    wx.showModal({title: this.data.needsReauthorize ? '移除失效授权' : this.data.accountUsername ? '退出账号' : '撤销手机授权', content: '退出后可重新登录同一账号或使用原扫码方式。局域网关联会保留。',
      success: async ({confirm}) => {
        if (!confirm || client !== this.client || this.data.busy) return;
        this.serial = (this.serial || 0) + 1;
        this.setData({busy: true});
        try {
          if (!this.data.needsReauthorize) await this.client.call('/api/v2/clients/revoke', 'POST');
          this.client.close();
          wx.removeStorageSync(client.storageKey);
          this.client = null;
          this.controlRoute = ''; this.wakeRoute = '';
          this.serial = (this.serial || 0) + 1;
          this.setData({connected: false, devices: [], selectedId: '', selectedIndex: 0, device: '选择一台电脑', cloudHost: '', paired: false, canControl: false,
            canWake: false, statusClass: 'idle', lanOpen: false, stateText: '已断开', modeText: '未连接', routeHint: '等待重新连接 Cloud',
            needsReauthorize: false, devicesLoaded: false, cloudState: 'idle', cloudStatusText: '未授权', controlHint: '扫描授权码后即可重新开始'});
          this.setData({accountUsername: '', accountFormVisible: true, controlHint: '登录账号后即可重新开始'});
          this.notify('已退出手机授权。', 'success');
        } catch (error) { this.cloudError(error); this.notify('暂时无法撤销，请重试或在 Cloud 网页移除此手机。', 'error'); }
        finally { this.setData({busy: false}); }
      }});
  },

  localKey(id = this.data.selectedId) { return this.client ? `${this.client.session.url}|${id}` : ''; },
  pairing() { return this.local[this.localKey()]; },
  canUseLan() { return !this.networkType || this.networkType === 'wifi' || this.networkType === 'unknown'; },
  selectDevice(event) {
    if (this.data.busy || this.data.updatingList) return;
    const device = this.data.devices[Number(event.detail.value)];
    if (!device || (this.targetDevice && device.device_id !== this.targetDevice)) return;
    this.serial = (this.serial || 0) + 1;
    this.controlRoute = ''; this.wakeRoute = '';
    this.setData({selectedId: device.device_id, selectedIndex: Number(event.detail.value), device: device.name,
      canControl: false, canWake: false, statusClass: 'busy', stateText: '正在同步状态',
      routeHint: '正在检查局域网和 Cloud 连接', controlHint: '正在同步设备状态', wakeHint: '正在检查可用的唤醒方式', feedback: ''});
    this.syncPairing();
    this.cacheDevices();
    this.syncConnection();
  },
  cacheDevices() { saveDeviceSelection(wx, this.client, this.data.devices, this.data.selectedId); },
  async reloadDevices() {
    if (!this.client || this.data.busy || this.data.updatingList) return;
    const client = this.client;
    const run = this.deviceListRun = (this.deviceListRun || 0) + 1;
    const serial = this.serial = (this.serial || 0) + 1;
    this.setData({updatingList: true, canControl: false, canWake: false});
    try {
      const list = await client.call('/api/v2/devices');
      if (client !== this.client || serial !== this.serial || run !== this.deviceListRun) return;
      if (!Array.isArray(list)) throw new Error('设备列表暂时无法读取，请稍后重试');
      const devices = list.filter(d => d.device_type === 'windows').map(deviceSummary);
      const selected = devices.find(d => d.device_id === (this.targetDevice || this.preferredDevice || this.data.selectedId)) || (!this.targetDevice ? devices[0] : null);
      this.serial = (this.serial || 0) + 1;
      this.setData({devices, selectedId: selected ? selected.device_id : '', selectedIndex: selected ? devices.indexOf(selected) : 0,
        device: selected ? selected.name : this.targetDevice ? '设备不可用' : '还没有电脑', deviceMissing: !!this.targetDevice && !selected,
        devicesLoaded: true, cloudState: 'online', cloudStatusText: '已连接', needsReauthorize: false,
        canControl: false, canWake: false, statusClass: 'busy',
        routeHint: selected ? '正在检查局域网和 Cloud 连接' : '等待 Windows 应用连接 Cloud', controlHint: selected ? '正在同步设备状态' : '请先在 Windows 应用中连接 Cloud'});
      this.preferredDevice = '';
      this.syncPairing(); this.cacheDevices();
    } catch (error) {
      if (client === this.client && serial === this.serial) {
        this.cloudError(error);
        this.setData({devices: this.data.devices.map(device => deviceSummary({...device, state: ''}))});
        this.notify(error.message, 'error');
      }
    } finally { if (client === this.client && run === this.deviceListRun) { this.setData({updatingList: false}); if (mode === 'power') await this.refresh(); } }
  },
  syncPairing() {
    const pairing = this.pairing();
    const draft = this.wakeDrafts[this.localKey()];
    this.setData({paired: !!pairing, mac: draft ? draft.mac : pairing && pairing.mac || '',
      broadcast: draft ? draft.broadcast : pairing && pairing.broadcast || '255.255.255.255',
      wakeDirty: !!draft, lanOpen: !!pairing && this.data.lanOpen});
  },
  scanLocal() {
    const key = this.localKey();
    if (this.data.busy || this.data.updatingList) return;
    if (!this.data.selectedId) { this.notify('请先在“我的设备”打开要关联的设备。'); return; }
    wx.scanCode({onlyFromCamera: true, scanType: ['qrCode'], success: ({result}) => {
      try {
        const pairing = parsePairingLink(result);
        wx.showModal({title: '关联局域网电脑', content: `确认此二维码来自“${this.data.device}”这台电脑？`, success: ({confirm}) => {
          if (!confirm || key !== this.localKey() || this.data.busy) return;
          const local = {...this.local, [key]: {...this.local[key], ...pairing}};
          wx.setStorageSync(this.lanStorageKey, local);
          this.local = local;
          this.serial = (this.serial || 0) + 1;
          this.setData({lanOpen: true});
          this.notify('局域网已关联。需要离线开机时，请继续填写下方唤醒设置。', 'success');
          this.syncPairing(); this.refresh();
        }});
      } catch (error) { this.notify(error.message, 'error'); }
    }, fail: error => this.scanFailed(error)});
  },
  clearLocal() {
    if (this.data.busy) return;
    const key = this.localKey();
    wx.showModal({title: '移除局域网关联', content: `移除“${this.data.device}”的直连凭据和唤醒设置？Cloud 手机授权不受影响。`,
      success: ({confirm}) => {
        if (!confirm || key !== this.localKey() || this.data.busy) return;
        const local = {...this.local}; delete local[key]; delete this.wakeDrafts[key];
        wx.setStorageSync(this.lanStorageKey, local); this.local = local;
        this.serial = (this.serial || 0) + 1;
        this.controlRoute = ''; this.wakeRoute = '';
        this.setData({lanOpen: false, canControl: false, canWake: false});
        this.notify('已移除局域网关联。', 'success'); this.syncPairing(); this.refresh();
      }});
  },
  editWake(field, value) {
    this.wakeDrafts[this.localKey()] = {mac: this.data.mac, broadcast: this.data.broadcast, [field]: value};
    this.setData({[field]: value, wakeDirty: true});
  },
  editMac(event) { this.editWake('mac', event.detail.value); },
  editBroadcast(event) { this.editWake('broadcast', event.detail.value); },
  saveWake() {
    if (!this.pairing() || this.data.busy) return;
    try {
      makeMagicPacket(this.data.mac.trim());
      const broadcast = this.data.broadcast.trim();
      const octets = broadcast.split('.');
      if (octets.length !== 4 || octets.some(o => !/^\d{1,3}$/.test(o) || Number(o) > 255)) throw new Error('广播地址无效');
      const local = {...this.local, [this.localKey()]: {...this.pairing(), mac: this.data.mac.trim(), broadcast}};
      wx.setStorageSync(this.lanStorageKey, local); this.local = local;
      delete this.wakeDrafts[this.localKey()]; this.syncPairing();
      this.notify('局域网唤醒设置已保存。', 'success'); this.refresh();
    } catch (error) { this.notify(error.message, 'error'); }
  },

  refresh() {
    if (mode !== 'power' || !this.client || this.data.busy || this.data.updatingList || this.visible === false) return Promise.resolve();
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    const promise = this.refreshOnce(); this.refreshing = promise;
    return promise.finally(() => {
      if (this.refreshing === promise) this.refreshing = null;
      if (this.refreshAgain) { this.refreshAgain = false; this.refresh(); }
    });
  },
  async refreshOnce() {
    const serial = this.serial = (this.serial || 0) + 1;
    const client = this.client;
    const current = () => serial === this.serial && this.client === client;
    try {
      // Once selected, LAN remains usable even if Cloud is unavailable.
      const pairing = this.pairing();
      if (pairing && this.canUseLan()) {
        const reachable = await new Promise(resolve => wx.request({url: `http://${pairing.host}:48211/api/status`,
          method: 'GET', timeout: 2500, header: {Authorization: `Bearer ${pairing.token}`},
          success: r => resolve(r.statusCode === 200 && r.data && r.data.state === 'online'), fail: () => resolve(false)}));
        if (!current()) return;
        if (reachable) {
          this.controlRoute = 'local'; this.wakeRoute = '';
          this.preferredDevice = ''; this.cacheDevices();
          this.setData({stateText: '在线 · 局域网', statusClass: 'online', modeText: '局域网直连', routeHint: '通过当前局域网直接连接电脑',
            detail: '电脑在线，可以发送电源指令', controlHint: '可执行睡眠、休眠、重启和关机', wakeHint: '电脑已在线，无需唤醒',
            canControl: true, canWake: false});
          return;
        }
      }
      const list = await client.call('/api/v2/devices');
      if (!current()) return;
      if (!Array.isArray(list)) throw new Error('设备列表无效');
      const devices = list.filter(d => d.device_type === 'windows');
      const device = devices.find(d => d.device_id === (this.targetDevice || this.preferredDevice || this.data.selectedId)) || (!this.targetDevice ? devices[0] : null);
      const changed = device && device.device_id !== this.data.selectedId;
      this.setData({devices, selectedId: device ? device.device_id : '', selectedIndex: device ? devices.indexOf(device) : 0,
        device: device ? device.name : this.targetDevice ? '设备不可用' : '还没有电脑', deviceMissing: !!this.targetDevice && !device, devicesLoaded: true,
        cloudState: 'online', cloudStatusText: '已连接', needsReauthorize: false});
      this.preferredDevice = '';
      this.cacheDevices();
      this.syncPairing();
      if (!device) {
        this.controlRoute = ''; this.wakeRoute = '';
        this.setData({stateText: '没有设备', statusClass: 'idle', modeText: '等待连接', routeHint: 'Windows 应用尚未向 Cloud 注册电脑',
          detail: '先在 Windows 应用中连接 Cloud', controlHint: '连接完成后回到这里更新设备列表', wakeHint: '请先添加电脑',
          canControl: false, canWake: false}); return;
      }
      if (changed && this.pairing()) {
        this.controlRoute = ''; this.wakeRoute = '';
        this.setData({canControl: false, canWake: false, statusClass: 'busy', stateText: '正在同步状态',
          controlHint: '正在检查新选中电脑的连接', wakeHint: '正在检查可用的唤醒方式'});
        this.refreshAgain = true; return;
      }
      this.controlRoute = 'cloud';
      this.wakeRoute = device.wake_available ? 'cloud' : this.canUseLan() && this.pairing() && this.pairing().mac ? 'local' : '';
      const online = device.state === 'online';
      const transitioning = device.state === 'transitioning';
      const canControl = online && !!device.remote_control_available;
      const wakeHint = online ? '电脑已在线，无需唤醒' : transitioning ? '请等待上一次操作完成' :
        this.wakeRoute === 'cloud' ? '通过在线网关尝试唤醒电脑' : this.wakeRoute === 'local' ? '通过当前 Wi-Fi 发送局域网唤醒包' :
          device.wake_unavailable_reason || '尚未配置可用的唤醒方式';
      const routeHint = device.cloud_agent === 'online' ? 'Cloud 直接连接 Windows 服务' : device.remote_control_available ? 'Cloud 通过唤醒网关转发指令' : 'Cloud 已连接，但 Windows 服务未响应';
      const controlHint = transitioning ? '正在等待电脑完成上一次操作' : canControl ? '可执行睡眠、休眠、重启和关机' : online ? '电脑在线，但还没有可用的控制通道' : this.wakeRoute ? '电脑离线，可尝试开机；其他操作需电脑在线' : '电脑离线，请先配置局域网或唤醒网关';
      this.setData({stateText: online ? '在线 · Cloud' : transitioning ? '正在执行电源操作' : '离线 · Cloud', statusClass: canControl ? 'online' : transitioning ? 'busy' : this.wakeRoute ? 'ready' : 'idle',
        modeText: device.cloud_agent === 'online' ? '云端直连' : device.remote_control_available ? '网关连接' : 'Cloud', routeHint, controlHint, wakeHint,
        detail: transitioning ? '等待电脑完成操作并重新同步状态' : canControl ? '可以控制这台电脑' :
          online ? '电脑在线，但 Windows 服务与备用控制通道暂时不可用' : wakeHint,
        canControl,
        canWake: device.state === 'offline' && !!this.wakeRoute});
    } catch (error) {
      if (!current()) return;
      this.cloudError(error);
      this.controlRoute = '';
      this.wakeRoute = this.canUseLan() && this.pairing() && this.pairing().mac ? 'local' : '';
      this.setData({stateText: '状态未知', statusClass: this.wakeRoute ? 'ready' : 'idle', modeText: this.wakeRoute ? '局域网唤醒可用' : '未连接',
        routeHint: this.wakeRoute ? 'Cloud 暂时不可用，已保留局域网唤醒' : '请检查网络或刷新授权',
        detail: error.message, controlHint: this.wakeRoute ? '当前只能尝试局域网开机' : '恢复连接后再执行电源操作',
        wakeHint: this.wakeRoute ? '状态暂时未知，可尝试局域网唤醒' : this.data.needsReauthorize ? '请重新授权后检查唤醒方式' : '暂时无法检查唤醒方式，请恢复连接',
        canControl: false, canWake: !!this.wakeRoute});
    }
  },

  action(event) {
    const action = event.currentTarget.dataset.action;
    if (!ACTIONS[action] || this.data.busy || (action === 'wake' ? !this.data.canWake : !this.data.canControl)) return;
    const id = this.data.selectedId, client = this.client, route = action === 'wake' ? this.wakeRoute : this.controlRoute;
    wx.showModal({title: `确定${ACTIONS[action]}？`, content: `${ACTION_HINTS[action]}\n\n目标电脑：${this.data.device}`,
      success: async ({confirm}) => {
        if (!confirm || id !== this.data.selectedId || client !== this.client || this.data.busy ||
            route !== (action === 'wake' ? this.wakeRoute : this.controlRoute) ||
            (action === 'wake' ? !this.data.canWake : !this.data.canControl)) return;
        this.serial = (this.serial || 0) + 1;
        this.setData({busy: true, statusClass: 'busy', canControl: false, canWake: false, controlHint: '指令发送中，请不要重复点击', wakeHint: '请等待指令处理完成'});
        this.notify('正在发送指令…');
        try {
          if (route === 'local' && action === 'wake') {
            let sendFailed = false;
            const sent = broadcastWake(wx, () => { sendFailed = true; this.notify('部分唤醒包发送失败，请检查局域网连接。', 'error'); }, this.pairing());
            if (sent && !sendFailed) this.notify('唤醒包已发出，请等待电脑上线；发送成功不代表已开机。');
          } else if (route === 'local') {
            const pairing = this.pairing();
            const response = await new Promise((resolve, reject) => wx.request({
              url: `http://${pairing.host}:48211/api/power`, method: 'POST', timeout: 5000,
              header: {Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json'}, data: {action},
              success: resolve, fail: () => reject(new Error('未收到确认，请先刷新状态再决定是否重试'))}));
            if (response.statusCode !== 202) throw new Error('局域网指令未被接受，请刷新状态');
            this.notify(`${ACTIONS[action]}指令已送达，正在同步电脑状态。`, 'success');
          } else {
            let result = await client.call(`/api/v2/devices/${encodeURIComponent(id)}/commands`, 'POST', {action});
            if (result.accepted && result.command_id) {
              this.notify('Cloud 已接收，正在等待电脑或网关确认。');
              for (let attempt = 0; attempt < 23 && result.state === 'accepted'; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (this.visible === false) break;
                result = await client.call(`/api/v2/commands/${encodeURIComponent(result.command_id)}`);
              }
            }
            if (result.state === 'failed' || result.ok === false) throw new Error('设备未能完成操作，请刷新状态');
            this.notify(result.state === 'accepted' ? '尚未收到设备确认，请刷新状态查看。' : `${ACTIONS[action]}指令已送达，请以电脑实际状态为准。`,
              result.state === 'accepted' ? 'info' : 'success');
          }
        } catch (error) { if (error.code === 'REAUTHORIZE') this.cloudError(error); this.notify(error.message, 'error'); }
        finally { this.setData({busy: false}); if (this.visible !== false) this.refresh(); }
      }});
  }
};
}

module.exports = {createDevicePage};
