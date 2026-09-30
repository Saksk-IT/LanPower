const {CLIENT_KEY, CloudClient, parseCloudPairing} = require('../../utils/cloud');
const {parsePairingLink} = require('../../utils/pairing');
const {broadcastWake, makeMagicPacket} = require('../../utils/wol');
const {VERSION} = require('../../utils/version');

const LOCAL_KEY = 'lanpower_device_lan_v2';
const CACHE_KEY = 'lanpower_device_cache_v2';
const ACTIONS = {sleep: '睡眠', hibernate: '休眠', restart: '重启', shutdown: '关机', wake: '开机'};

Page({
  data: {connected: false, devices: [], selectedId: '', device: '选择一台电脑', stateText: '未连接 Cloud',
    detail: '在 Cloud 的已授权客户端页面生成二维码', modeText: '未连接', paired: false,
    canControl: false, canWake: false, busy: false, feedback: '', mac: '', broadcast: '255.255.255.255', version: VERSION},

  onLoad() {
    this.client = CloudClient.load(wx);
    this.local = wx.getStorageSync(LOCAL_KEY) || {};
    this.setData({connected: !!this.client});
    const cache = wx.getStorageSync(CACHE_KEY);
    if (this.client && cache && cache.url === this.client.session.url && cache.client_id === this.client.session.client_id && Array.isArray(cache.devices)) {
      const device = cache.devices.find(d => d.device_id === cache.selectedId);
      if (device) this.setData({devices: cache.devices, selectedId: device.device_id, device: device.name});
      this.syncPairing();
    }
  },
  onShow() { this.visible = true; this.refresh(); this.timer = setInterval(() => this.refresh(), 15000); },
  onHide() { this.visible = false; clearInterval(this.timer); this.serial = (this.serial || 0) + 1; },
  onUnload() { this.onHide(); },
  openLocal() { wx.navigateTo({url: '/pages/index/index'}); },

  scanCloud() {
    if (this.data.busy) return;
    wx.scanCode({onlyFromCamera: true, scanType: ['qrCode'], success: async ({result}) => {
      let pairing;
      try { pairing = parseCloudPairing(result); }
      catch (error) { this.setData({feedback: error.message}); return; }
      wx.showModal({title: '连接 Cloud', content: `允许此手机连接 ${pairing.url} 并控制其中的电脑？`,
        success: async ({confirm}) => {
          if (!confirm || this.data.busy) return;
          this.setData({busy: true});
          try {
            const client = await CloudClient.enroll(wx, pairing);
            this.serial = (this.serial || 0) + 1;
            if (this.client) this.client.close();
            this.client = client;
            this.setData({connected: true, devices: [], selectedId: '', canControl: false, canWake: false, feedback: 'Cloud 已连接'});
          } catch (error) { this.setData({feedback: error.message}); }
          finally { this.setData({busy: false}); this.refresh(); }
        }});
    }});
  },

  disconnect() {
    if (!this.client || this.data.busy) return;
    wx.showModal({title: '断开 Cloud', content: '撤销这部手机的 Cloud 授权，电脑的局域网配对仍保留。',
      success: async ({confirm}) => {
        if (!confirm) return;
        this.setData({busy: true});
        try {
          await this.client.call('/api/v2/clients/revoke', 'POST');
          this.client.close();
          wx.removeStorageSync(CLIENT_KEY);
          this.client = null;
          this.serial = (this.serial || 0) + 1;
          this.setData({connected: false, devices: [], selectedId: '', paired: false, canControl: false,
            canWake: false, stateText: '已断开', feedback: '手机授权已撤销'});
        } catch (_) { this.setData({feedback: '暂时无法撤销，请重试或在 Cloud 页面移除此手机'}); }
        finally { this.setData({busy: false}); }
      }});
  },

  localKey(id = this.data.selectedId) { return this.client ? `${this.client.session.url}|${id}` : ''; },
  pairing() { return this.local[this.localKey()]; },
  selectDevice(event) {
    if (this.data.busy) return;
    const device = this.data.devices[Number(event.detail.value)];
    if (!device) return;
    this.serial = (this.serial || 0) + 1;
    this.setData({selectedId: device.device_id, device: device.name, canControl: false, canWake: false, feedback: ''});
    this.syncPairing();
    this.cacheDevices();
    this.refresh();
  },
  cacheDevices() {
    wx.setStorageSync(CACHE_KEY, {url: this.client.session.url, client_id: this.client.session.client_id,
      devices: this.data.devices.map(d => ({device_id: d.device_id, name: d.name, device_type: 'windows'})), selectedId: this.data.selectedId});
  },
  async reloadDevices() {
    if (!this.client || this.data.busy) return;
    const client = this.client;
    try {
      const devices = (await client.call('/api/v2/devices')).filter(d => d.device_type === 'windows');
      if (client !== this.client) return;
      const selected = devices.find(d => d.device_id === this.data.selectedId) || devices[0];
      this.serial = (this.serial || 0) + 1;
      this.setData({devices, selectedId: selected ? selected.device_id : '', device: selected ? selected.name : '还没有电脑', canControl: false, canWake: false});
      this.syncPairing(); this.cacheDevices(); this.refresh();
    } catch (error) { this.setData({feedback: error.message}); }
  },
  syncPairing() {
    const pairing = this.pairing();
    this.setData({paired: !!pairing, mac: pairing && pairing.mac || '', broadcast: pairing && pairing.broadcast || '255.255.255.255'});
  },
  scanLocal() {
    const key = this.localKey();
    if (!this.data.selectedId || this.data.busy) return;
    wx.scanCode({onlyFromCamera: true, scanType: ['qrCode'], success: ({result}) => {
      try {
        const pairing = parsePairingLink(result);
        wx.showModal({title: '关联局域网电脑', content: `确认此二维码来自“${this.data.device}”这台电脑？`, success: ({confirm}) => {
          if (!confirm || key !== this.localKey()) return;
          const local = {...this.local, [key]: pairing};
          wx.setStorageSync(LOCAL_KEY, local);
          this.local = local;
          this.serial = (this.serial || 0) + 1;
          this.syncPairing(); this.refresh();
        }});
      } catch (error) { this.setData({feedback: error.message}); }
    }});
  },
  clearLocal() {
    if (this.data.busy) return;
    const local = {...this.local}; delete local[this.localKey()];
    wx.setStorageSync(LOCAL_KEY, local); this.local = local;
    this.serial = (this.serial || 0) + 1; this.syncPairing(); this.refresh();
  },
  editMac(event) { this.setData({mac: event.detail.value}); },
  editBroadcast(event) { this.setData({broadcast: event.detail.value}); },
  saveWake() {
    if (!this.pairing() || this.data.busy) return;
    try {
      makeMagicPacket(this.data.mac.trim());
      const broadcast = this.data.broadcast.trim();
      const octets = broadcast.split('.');
      if (octets.length !== 4 || octets.some(o => !/^\d{1,3}$/.test(o) || Number(o) > 255)) throw new Error('广播地址无效');
      const local = {...this.local, [this.localKey()]: {...this.pairing(), mac: this.data.mac.trim(), broadcast}};
      wx.setStorageSync(LOCAL_KEY, local); this.local = local;
      this.setData({feedback: '局域网唤醒设置已保存'}); this.refresh();
    } catch (error) { this.setData({feedback: error.message}); }
  },

  refresh() {
    if (!this.client || this.data.busy) return Promise.resolve();
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
      if (pairing) {
        const reachable = await new Promise(resolve => wx.request({url: `http://${pairing.host}:48211/api/status`,
          method: 'GET', timeout: 2500, header: {Authorization: `Bearer ${pairing.token}`},
          success: r => resolve(r.statusCode === 200 && r.data && r.data.state === 'online'), fail: () => resolve(false)}));
        if (!current()) return;
        if (reachable) {
          this.route = 'local';
          this.setData({stateText: '在线 · 局域网', modeText: '局域网直连', detail: '可以控制这台电脑', canControl: true, canWake: false});
          return;
        }
      }
      const list = await client.call('/api/v2/devices');
      if (!current()) return;
      if (!Array.isArray(list)) throw new Error('设备列表无效');
      const devices = list.filter(d => d.device_type === 'windows');
      const device = devices.find(d => d.device_id === this.data.selectedId) || devices[0];
      const changed = device && device.device_id !== this.data.selectedId;
      this.setData({devices, selectedId: device ? device.device_id : '', device: device ? device.name : '还没有电脑'});
      this.cacheDevices();
      this.syncPairing();
      if (!device) {
        this.setData({stateText: '没有设备', detail: '先在 Windows 应用中连接 Cloud', canControl: false, canWake: false}); return;
      }
      if (changed && this.pairing()) { this.refreshAgain = true; return; }
      this.route = 'cloud';
      this.wakeRoute = device.wake_available ? 'cloud' : this.pairing() && this.pairing().mac ? 'local' : '';
      this.setData({stateText: device.state === 'online' ? '在线 · Cloud' : '离线',
        modeText: device.cloud_agent === 'online' ? '云端直连' : device.remote_control_available ? '网关连接' : 'Cloud',
        detail: device.remote_control_available ? '可以控制这台电脑' : device.wake_available ? '可通过唤醒网关开机' :
          this.wakeRoute === 'local' ? '仍可尝试局域网唤醒' : '未连接唤醒网关，远程开机不可用',
        canControl: !!device.remote_control_available, canWake: device.state !== 'online' && !!this.wakeRoute});
    } catch (error) {
      if (!current()) return;
      this.wakeRoute = this.pairing() && this.pairing().mac ? 'local' : '';
      this.setData({stateText: '暂时无法连接', modeText: this.wakeRoute ? '局域网唤醒可用' : '未连接',
        detail: error.message, canControl: false, canWake: !!this.wakeRoute});
    }
  },

  action(event) {
    const action = event.currentTarget.dataset.action;
    if (!ACTIONS[action] || this.data.busy || (action === 'wake' ? !this.data.canWake : !this.data.canControl)) return;
    const id = this.data.selectedId, client = this.client, route = action === 'wake' ? this.wakeRoute : this.route;
    wx.showModal({title: `确定${ACTIONS[action]}？`, content: `目标电脑：${this.data.device}`,
      success: async ({confirm}) => {
        if (!confirm || id !== this.data.selectedId || client !== this.client || this.data.busy) return;
        this.serial = (this.serial || 0) + 1;
        this.setData({busy: true, canControl: false, canWake: false, feedback: '正在发送指令…'});
        try {
          if (route === 'local' && action === 'wake') {
            broadcastWake(wx, () => this.setData({feedback: '部分唤醒包发送失败，请检查局域网连接'}), this.pairing());
            this.setData({feedback: '已发送唤醒包，正在等待电脑上线'});
          } else if (route === 'local') {
            const pairing = this.pairing();
            const response = await new Promise((resolve, reject) => wx.request({
              url: `http://${pairing.host}:48211/api/power`, method: 'POST', timeout: 5000,
              header: {Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json'}, data: {action},
              success: resolve, fail: () => reject(new Error('未收到确认，请先刷新状态再决定是否重试'))}));
            if (response.statusCode !== 202) throw new Error('局域网指令未被接受，请刷新状态');
            this.setData({feedback: `${ACTIONS[action]}指令已送达`});
          } else {
            let result = await client.call(`/api/v2/devices/${encodeURIComponent(id)}/commands`, 'POST', {action});
            if (result.accepted && result.command_id) {
              this.setData({feedback: 'Cloud 已接收，正在等待电脑或网关确认'});
              for (let attempt = 0; attempt < 23 && result.state === 'accepted'; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (this.visible === false) break;
                result = await client.call(`/api/v2/commands/${encodeURIComponent(result.command_id)}`);
              }
            }
            if (result.state === 'failed' || result.ok === false) throw new Error('设备未能完成操作，请刷新状态');
            this.setData({feedback: result.state === 'accepted' ? '尚未收到设备确认，请刷新状态查看' : `${ACTIONS[action]}指令已送达`});
          }
        } catch (error) { this.setData({feedback: error.message}); }
        finally { this.setData({busy: false}); if (this.visible !== false) this.refresh(); }
      }});
  }
});
