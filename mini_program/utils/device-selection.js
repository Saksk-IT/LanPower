const {storageKey} = require('./environment');
const CACHE_KEY = 'lanpower_device_cache_v2';

function deviceCache(wxApi, client) {
  if (!client) return null;
  const cache = wxApi.getStorageSync(storageKey(wxApi, CACHE_KEY));
  return cache && cache.url === client.session.url && cache.client_id === client.session.client_id && Array.isArray(cache.devices) ? cache : null;
}

function selectedDevice(wxApi, client) {
  const cache = deviceCache(wxApi, client);
  return cache && typeof cache.selectedId === 'string' ? cache.selectedId : '';
}

function saveDeviceSelection(wxApi, client, devices, selectedId) {
  if (!client || client.closed) return;
  if (client.assertCurrent) { try { client.assertCurrent(); } catch (_) { return; } }
  wxApi.setStorageSync(storageKey(wxApi, CACHE_KEY), {
    url: client.session.url, client_id: client.session.client_id,
    devices: devices.map(device => ({device_id: device.device_id, name: device.name, device_type: 'windows'})),
    selectedId: selectedId || ''
  });
}

module.exports = {CACHE_KEY, deviceCache, selectedDevice, saveDeviceSelection};
