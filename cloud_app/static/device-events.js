(() => {
  if (!document.querySelector('[data-device-events]') || typeof EventSource === 'undefined') return;
  const {renderCard, relativeTime} = window.LanPowerStatus;
  const message = document.querySelector('[data-status-sync]');
  let stream, relativeTimer;

  function connect() {
    if (document.hidden || stream) return;
    clearInterval(relativeTimer);
    relativeTimer = setInterval(updateRelativeTimes, 15000);
    const current = stream = new EventSource('/api/v2/events/devices');
    current.addEventListener('devices', event => {
      if (current !== stream || document.hidden) return;
      try {
        const devices = JSON.parse(event.data);
        if (!Array.isArray(devices)) return;
        const statuses = new Map(devices.map(device => [device.device_id, device]));
        document.querySelectorAll('[data-device-id]').forEach(card => {
          renderCard(card, statuses.get(card.dataset.deviceId) || {state: 'removed'});
        });
        document.querySelectorAll('[data-status-summary]').forEach(element => {
          const [type, state] = element.dataset.statusSummary.split('-');
          element.textContent = devices.filter(device => device.device_type === type && device.state === state).length;
        });
        message.textContent = '状态已同步 · 实时更新';
        message.dataset.state = 'synced';
      } catch { /* A malformed event must not break automatic reconnection. */ }
    });
    current.addEventListener('error', () => {
      if (current !== stream) return;
      document.querySelectorAll('[data-device-id]').forEach(card => renderCard(card, {state: 'unknown'}));
      message.textContent = '正在重新连接…';
      message.dataset.state = 'error';
      // EventSource handles retries; no additional requests or dialogs.
    });
  }
  function disconnect() { stream?.close(); stream = null; clearInterval(relativeTimer); }
  document.addEventListener('visibilitychange', () => document.hidden ? disconnect() : connect());
  window.addEventListener('pagehide', disconnect);
  window.addEventListener('pageshow', connect);
  window.addEventListener('online', connect);
  function updateRelativeTimes() {
    if (document.hidden) return;
    document.querySelectorAll('[data-device-id][data-last-seen]').forEach(card => {
      card.querySelectorAll('[data-status-seen]').forEach(element => {
        element.textContent = relativeTime(Number(card.dataset.lastSeen));
      });
    });
  }
  connect();
})();
