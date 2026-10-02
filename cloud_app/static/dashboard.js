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
  if (typeof document === 'undefined' || !document.querySelector('[data-device-events]')) return;

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

  document.querySelectorAll('[data-rdp-link]').forEach(link => link.addEventListener('click', async event => {
    event.preventDefault();
    if (leaving || link.getAttribute('aria-busy') === 'true') return;
    const message = link.closest('[data-status-rdp]').querySelector('[data-rdp-message]');
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    link.setAttribute('aria-busy', 'true');
    feedback(message, '正在准备远程桌面连接文件…');
    try {
      const response = await fetch(link.href, {credentials: 'same-origin', cache: 'no-store',
        signal: controller.signal});
      if (response.status === 401) throw new Error('登录已过期，请刷新页面并重新登录');
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/x-rdp')) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || '连接文件下载失败，请稍后重试');
      }
      const file = await response.blob();
      if (leaving) return;
      const url = URL.createObjectURL(file);
      const download = document.createElement('a');
      download.href = url;
      download.download = link.download || 'LanPower.rdp';
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      feedback(message, '已开始下载。打开下载的 .rdp 文件，使用 Windows 账户连接电脑。', 'success');
    } catch (error) {
      if (!leaving) feedback(message, error.name === 'AbortError' ? '下载超时，请重试' :
        error instanceof TypeError ? '网络连接失败，请稍后重试' : error.message, 'warning');
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
      link.removeAttribute('aria-busy');
    }
  }));

  document.querySelectorAll('[data-copy-ip]').forEach(button => button.addEventListener('click', async () => {
    const message = button.parentElement.querySelector('[data-copy-result]');
    try {
      await navigator.clipboard.writeText(button.dataset.copyIp);
      message.textContent = 'IP 已复制';
    } catch { message.textContent = `请手动复制：${button.dataset.copyIp}`; }
  }));
})();
