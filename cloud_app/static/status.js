(() => {
  const stateLabels = {online: '在线', offline: '离线', transitioning: '正在执行电源操作',
    unknown: '状态未知', removed: '已移除'};
  const setText = (card, field, value) => card.querySelectorAll(`[data-status-${field}]`)
    .forEach(element => { element.textContent = value; });
  const relativeTime = value => {
    if (value == null) return '暂无记录';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - value);
    return seconds < 60 ? '刚刚' : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` :
      seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 86400)} 天前`;
  };

  function renderCard(card, status) {
    card.dataset.state = status.state;
    if (status.last_seen_at != null) card.dataset.lastSeen = status.last_seen_at;
    const known = ['online', 'offline', 'transitioning'].includes(status.state);
    const canControl = known && status.state === 'online' && !!status.remote_control_available;
    setText(card, 'badge', stateLabels[status.state] || stateLabels.unknown);
    card.querySelectorAll('[data-status-badge]').forEach(badge => badge.classList.toggle('good', status.state === 'online'));
    card.querySelectorAll('[data-status-dot]').forEach(dot => {
      dot.classList.toggle('online', status.state === 'online');
      dot.classList.toggle('offline', status.state !== 'online');
    });
    if (status.name != null) setText(card, 'name', status.name);
    card.querySelectorAll('form input[name="action"]').forEach(input => {
      const button = input.form.querySelector('button[type="submit"]');
      const unavailable = input.value === 'wake'
        ? !known || status.state === 'transitioning' || !status.wake_available : !canControl;
      if (button.dataset) button.dataset.unavailable = String(unavailable);
      button.disabled = unavailable || button.dataset?.busy === 'true';
    });
    const connection = !known ? '暂时无法取得设备状态，请检查连接。' : status.state === 'transitioning'
      ? '正在执行电源操作，等待状态更新。' : status.cloud_agent === 'online'
        ? 'Cloud 已连接，可直接远程控制。' : canControl ? '通过唤醒网关连接。' : status.state === 'online'
          ? '电脑在线，Cloud 未连接且未启用网关备用控制。' : 'Cloud 未连接。';
    setText(card, 'connection', connection);
    setText(card, 'wake-state', !known ? '状态未知' : status.wake_available ? '已就绪' : status.wake_unavailable_reason || '尚未配置');
    card.querySelectorAll('form input[name="action"]').forEach(input => {
      if (!['wake', 'sleep'].includes(input.value)) return;
      const button = input.form.querySelector('button[type="submit"]');
      if (!button.classList) return;
      const primary = input.value === 'wake' ? status.state === 'offline' : status.state !== 'offline';
      button.classList.toggle('primary', primary);
      button.classList.toggle('secondary', !primary);
    });
    const hint = status.state === 'transitioning' ? '等待电脑完成电源操作。' :
      known ? status.state === 'offline' && status.wake_available ? '电脑已离线，可以使用远程开机。' :
        '电脑当前不可远程控制。' : '状态尚未确认，暂时不能发送电源指令。';
    setText(card, 'control-hint', hint);
    card.querySelectorAll('[data-status-control-hint]').forEach(element => { element.hidden = canControl; });
    setText(card, 'wake-hint', known ? `${status.wake_unavailable_reason || '远程唤醒不可用'}，远程开机不可用。` : '等待同步唤醒网关状态。');
    card.querySelectorAll('[data-status-wake-hint]').forEach(element => { element.hidden = known && !!status.wake_available; });
    setText(card, 'cloud', !known ? '状态未知' : status.cloud_agent === 'online' ? '已连接' : '未连接');
    setText(card, 'setup', known ? status.wake_setup_message || '等待配置状态更新。' : '配置状态暂时未知，连接恢复后自动更新。');
    card.querySelectorAll('[data-gateway-target]').forEach(element => {
      const target = status.wake_targets?.find(item => item.device_id === element.dataset.gatewayTarget);
      element.textContent = known ? target?.message || '等待配置状态更新。' : '配置状态暂时未知，连接恢复后自动更新。';
    });
    if (known) {
      setText(card, 'version', status.version || '尚未上报');
      setText(card, 'lan', status.lan_ip || '尚未上报');
      setText(card, 'wol', status.wol_capable === true ? '系统允许唤醒' : status.wol_capable === false ? '请检查电脑设置' : '尚未上报');
      setText(card, 'gateway', status.wake_gateway ? `${status.wake_gateway.name} · ${stateLabels[status.wake_gateway.state] || '状态未知'}` : '未配置');
      setText(card, 'seen', relativeTime(status.last_seen_at));
    } else {
      setText(card, 'gateway', '状态未知');
    }
    card.querySelectorAll('[data-status-rdp]').forEach(element => {
      element.hidden = status.state !== 'online' || !status.lan_ip;
      const address = status.lan_ip?.includes(':') ? `[${status.lan_ip}]` : status.lan_ip;
      element.querySelector('[data-rdp-link]').href = `rdp://full%20address%3Ds%3A${encodeURIComponent(address || '')}%3A3389`;
      element.querySelector('[data-copy-ip]').dataset.copyIp = status.lan_ip || '';
    });
  }

  // Node tests exercise the same rendering used by the browser.
  if (typeof module !== 'undefined' && module.exports) module.exports = {renderCard};
  if (typeof window !== 'undefined') window.LanPowerStatus = {renderCard, relativeTime};
  if (typeof document === 'undefined' || !document.querySelector('[data-status-sync]')) return;
  if (document.body?.dataset.page === 'dashboard' && typeof EventSource !== 'undefined') return;
  const cards = [...document.querySelectorAll('[data-status-id]')];
  const message = document.querySelector('[data-status-sync]');
  let serial = 0, controller, timer;

  async function sync() {
    if (document.hidden) return;
    const requestId = ++serial;
    clearTimeout(timer);
    controller?.abort();
    const current = controller = new AbortController();
    const deadline = setTimeout(() => current.abort(), 8000);
    try {
      const response = await fetch('/api/v2/devices', {credentials: 'same-origin', cache: 'no-store', signal: current.signal});
      if (!response.ok) throw new Error('status unavailable');
      const devices = await response.json();
      if (!Array.isArray(devices)) throw new Error('invalid status');
      if (requestId !== serial || document.hidden) return;
      const statuses = new Map(devices.map(device => [device.device_id, device]));
      cards.forEach(card => renderCard(card, statuses.get(card.dataset.statusId) || {state: 'removed'}));
      document.querySelectorAll('[data-status-summary]').forEach(element => {
        const [type, state] = element.dataset.statusSummary.split('-');
        element.textContent = devices.filter(device => device.device_type === type && device.state === state).length;
      });
      message.textContent = '状态已同步 · 每 5 秒更新';
      if (message.dataset) message.dataset.state = 'synced';
    } catch {
      if (requestId !== serial || document.hidden) return;
      cards.forEach(card => renderCard(card, {state: 'unknown'}));
      document.querySelectorAll('[data-status-summary]').forEach(element => { element.textContent = '—'; });
      message.textContent = '暂时无法同步状态，正在重试。';
      if (message.dataset) message.dataset.state = 'error';
    } finally {
      clearTimeout(deadline);
      if (requestId === serial && !document.hidden) timer = setTimeout(sync, 5000);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
    else { serial++; controller?.abort(); clearTimeout(timer); }
  });
  window.addEventListener('focus', sync);
  window.addEventListener('online', sync);
  window.addEventListener('pageshow', sync);
  sync();
})();
