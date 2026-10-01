(() => {
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  async function waitForWake(readStatus, {wait = delay, now = Date.now, signal} = {}) {
    const deadline = now() + 120000;
    for (let attempt = 0; attempt < 24; attempt++) {
      signal?.throwIfAborted();
      await wait(Math.min(5000, Math.max(0, deadline - now())));
      signal?.throwIfAborted();
      try {
        const status = await readStatus(Math.max(1, Math.min(4500, deadline - now())));
        if (status.online === true) return true;
      } catch { /* A booting computer or a brief network failure can recover. */ }
      signal?.throwIfAborted();
      if (now() >= deadline) break;
    }
    return false;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {waitForWake};
  if (typeof document === 'undefined' || !document.querySelector('[data-device-groups]')) return;

  const csrf = document.querySelector('meta[name="lp-csrf"]').content;
  const pending = new Set();
  let lifetime = new AbortController();
  let leaving = false;
  window.addEventListener('pagehide', () => { leaving = true; lifetime.abort(); pending.forEach(controller => controller.abort()); });
  window.addEventListener('pageshow', () => { leaving = false; if (lifetime.signal.aborted) lifetime = new AbortController(); });

  async function request(url, payload, timeout = 10000) {
    if (leaving) throw new Error('页面已关闭');
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {method: payload === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: payload === undefined ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
        body: payload === undefined ? undefined : JSON.stringify(payload)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '请求未完成，请稍后重试');
      return result;
    } finally { clearTimeout(timer); pending.delete(controller); }
  }
  function feedback(element, text, tone = '') {
    element.textContent = text;
    element.dataset.tone = tone;
    element.hidden = false;
  }

  document.querySelectorAll('[data-wake-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const card = form.closest('[data-device-id]');
    const button = form.querySelector('button');
    if (button.disabled || button.dataset.busy === 'true') return;
    const label = button.querySelector('[data-action-text]');
    const message = card.querySelector('[data-wake-message]');
    const endpoint = `/api/v2/devices/${encodeURIComponent(card.dataset.deviceId)}`;
    button.disabled = true;
    button.dataset.busy = 'true';
    label.textContent = '唤醒中…';
    feedback(message, '正在发送唤醒指令…');
    try {
      const result = await request(`${endpoint}/commands`, {action: 'wake'});
      if (!result.ok && !result.accepted) throw new Error(result.error || '唤醒指令未被接收');
      feedback(message, '已发送，正在等待电脑上线…');
      const online = await waitForWake(timeout => request(`${endpoint}/online`, undefined, timeout),
        {signal: lifetime.signal});
      if (online) {
        feedback(message, '唤醒成功', 'success');
        label.textContent = '唤醒成功';
        await delay(3000);
      } else {
        feedback(message, '设备未响应，请检查 BIOS 是否开启 Wake-on-LAN', 'warning');
      }
    } catch (error) {
      if (!leaving) feedback(message, error.name === 'AbortError' ? '连接超时，请稍后重试' : error.message, 'warning');
    } finally {
      delete button.dataset.busy;
      label.textContent = '开机';
      button.disabled = button.dataset.unavailable === 'true';
    }
  }));

  document.querySelectorAll('[data-group-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const card = form.closest('[data-device-id]');
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const {group} = await request(`/api/v2/devices/${encodeURIComponent(card.dataset.deviceId)}/group`,
        {group: form.elements.group.value});
      const container = document.querySelector('[data-device-groups]');
      let destination = [...container.children].find(section => section.dataset.group === group);
      if (!destination) {
        destination = document.createElement('section');
        destination.className = 'device-group';
        destination.dataset.group = group;
        const heading = document.createElement('h3');
        heading.textContent = group || '未分组';
        const grid = document.createElement('div');
        grid.className = 'device-grid';
        destination.append(heading, grid);
        container.append(destination);
      }
      const previous = card.closest('[data-group]');
      destination.querySelector('.device-grid').append(card);
      card.querySelector('[data-group-label]').textContent = group || '未分组';
      form.elements.group.value = group;
      if (!previous.querySelector('[data-device-id]')) previous.remove();
      card.querySelector('.group-editor').open = false;
      feedback(form.querySelector('[data-group-message]'), '已保存', 'success');
    } catch (error) { feedback(form.querySelector('[data-group-message]'), error.message, 'warning'); }
    finally { button.disabled = false; }
  }));

  const batch = document.querySelector('[data-batch-form]');
  const selectAll = document.querySelector('[data-select-all]');
  const checkboxes = [...document.querySelectorAll('[data-device-select]')];
  function selection() {
    const selected = checkboxes.filter(checkbox => checkbox.checked);
    selectAll.checked = selected.length === checkboxes.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < checkboxes.length;
    document.querySelector('[data-selection-count]').textContent = `已选 ${selected.length} 台（最多 20 台）`;
    return selected.map(checkbox => checkbox.closest('[data-device-id]'));
  }
  checkboxes.forEach(checkbox => checkbox.addEventListener('change', selection));
  selectAll.addEventListener('change', () => { checkboxes.forEach(checkbox => { checkbox.checked = selectAll.checked; }); selection(); });
  batch.addEventListener('submit', async event => {
    // app.js dispatches the second submit only after the user confirms.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const cards = selection(), button = batch.querySelector('button[type="submit"]');
    const message = batch.querySelector('[data-batch-message]');
    if (button.disabled) return;
    if (!cards.length || cards.length > 20) { feedback(message, '请选择 1–20 台电脑', 'warning'); return; }
    button.disabled = true;
    feedback(message, '正在发送批量指令…');
    cards.forEach(card => feedback(card.querySelector('[data-batch-result]'), '正在发送…'));
    try {
      const {results} = await request('/api/v2/devices/batch-command',
        {device_ids: cards.map(card => card.dataset.deviceId), action: batch.elements.action.value}, 45000);
      results.forEach(result => {
        const card = cards.find(item => item.dataset.deviceId === result.device_id);
        if (card) feedback(card.querySelector('[data-batch-result]'), result.ok ? '指令已接收' :
          `未发送成功：${result.error || '设备不可用'}`, result.ok ? 'success' : 'warning');
      });
      feedback(message, `处理完成：${results.filter(result => result.ok).length} 台已接收，${results.filter(result => !result.ok).length} 台未成功`);
    } catch (error) {
      feedback(message, error.message, 'warning');
      cards.forEach(card => feedback(card.querySelector('[data-batch-result]'), '结果未确认，请查看活动记录', 'warning'));
    } finally { button.disabled = false; }
  });

  document.querySelectorAll('[data-copy-ip]').forEach(button => button.addEventListener('click', async () => {
    const message = button.parentElement.querySelector('[data-copy-result]');
    try {
      await navigator.clipboard.writeText(button.dataset.copyIp);
      message.textContent = 'IP 已复制';
    } catch { message.textContent = `请手动复制：${button.dataset.copyIp}`; }
  }));
})();
