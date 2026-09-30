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
    const known = ['online', 'offline', 'transitioning'].includes(status.state);
    const canControl = known && status.state === 'online' && !!status.remote_control_available;
    setText(card, 'badge', stateLabels[status.state] || stateLabels.unknown);
    card.querySelectorAll('[data-status-badge]').forEach(badge => badge.classList.toggle('good', status.state === 'online'));
    if (status.name != null) setText(card, 'name', status.name);
    card.querySelectorAll('form input[name="action"]').forEach(input => {
      input.form.querySelector('button[type="submit"]').disabled = input.value === 'wake'
        ? !known || status.state !== 'offline' || !status.wake_available : !canControl;
    });
    const connection = !known ? '暂时无法取得设备状态，请检查连接。' : status.state === 'transitioning'
      ? '正在执行电源操作，等待状态更新。' : status.cloud_agent === 'online'
        ? 'Cloud 已连接，可直接远程控制。' : canControl ? '通过唤醒网关连接。' : status.state === 'online'
          ? '电脑在线，Cloud 未连接且未启用网关备用控制。' : 'Cloud 未连接。';
    setText(card, 'connection', connection + (known ? status.wake_available ? ' 远程唤醒可用。' : ' 远程唤醒不可用。' : ''));
    const hint = status.state === 'transitioning' ? '等待电脑完成电源操作。' :
      known ? '电脑当前不可远程控制。' : '状态尚未确认，暂时不能发送电源指令。';
    setText(card, 'control-hint', hint);
    card.querySelectorAll('[data-status-control-hint]').forEach(element => { element.hidden = canControl; });
    setText(card, 'wake-hint', known ? `${status.wake_unavailable_reason || '远程唤醒不可用'}，远程开机不可用。` : '等待同步唤醒网关状态。');
    card.querySelectorAll('[data-status-wake-hint]').forEach(element => { element.hidden = known && !!status.wake_available; });
    setText(card, 'cloud', !known ? '状态未知' : status.cloud_agent === 'online' ? '已连接' : '未连接');
    if (known) {
      setText(card, 'version', status.version || '尚未上报');
      setText(card, 'lan', status.lan_ip || '尚未上报');
      setText(card, 'wol', status.wol_capable === true ? '系统允许唤醒' : status.wol_capable === false ? '请检查电脑设置' : '尚未上报');
      setText(card, 'gateway', status.wake_gateway ? `${status.wake_gateway.name} · ${stateLabels[status.wake_gateway.state] || '状态未知'}` : '未配置');
      setText(card, 'seen', relativeTime(status.last_seen_at));
    } else {
      setText(card, 'gateway', '状态未知');
    }
  }

  // Node tests exercise the same rendering used by the browser.
  if (typeof module !== 'undefined' && module.exports) module.exports = {renderCard};
  if (typeof document === 'undefined' || !document.querySelector('[data-status-sync]')) return;
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
      message.textContent = '状态已同步，每 5 秒自动更新。';
    } catch {
      if (requestId !== serial || document.hidden) return;
      cards.forEach(card => renderCard(card, {state: 'unknown'}));
      document.querySelectorAll('[data-status-summary]').forEach(element => { element.textContent = '—'; });
      message.textContent = '暂时无法同步状态，正在重试。';
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
