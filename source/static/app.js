(() => {
  'use strict';
  const keyName = 'lanpower_access_token';
  const actions = document.querySelectorAll('[data-action]');
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');
  const deviceName = document.getElementById('device-name');
  const deviceDetail = document.getElementById('device-detail');
  const feedback = document.getElementById('feedback');
  const pairPanel = document.getElementById('pair-panel');
  const pairInput = document.getElementById('pair-input');
  const pairError = document.getElementById('pair-error');
  const actionNames = {sleep: '睡眠', hibernate: '休眠', restart: '重启', shutdown: '关机'};

  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const newToken = fragment.get('access');
  if (newToken && /^[a-f\d]{64}$/i.test(newToken)) {
    localStorage.setItem(keyName, newToken);
    history.replaceState(null, '', window.location.pathname);
  }

  function token() { return localStorage.getItem(keyName); }
  async function timedFetch(path, options, milliseconds) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), milliseconds);
    try {
      return await fetch(path, {...options, signal: controller.signal});
    } finally {
      clearTimeout(timeout);
    }
  }
  function showPairing(message = '') {
    pairPanel.classList.remove('hidden');
    pairError.textContent = message;
  }
  function setStatus(state, text, detail) {
    statusPill.className = `status-pill ${state}`;
    statusText.textContent = text;
    deviceDetail.textContent = detail;
    actions.forEach(button => { button.disabled = state !== 'online'; });
  }
  async function refresh() {
    if (!token()) {
      setStatus('offline', '未配对', '在电脑配对页面扫码后即可控制');
      deviceName.textContent = '等待配对';
      showPairing();
      return;
    }
    setStatus('checking', '正在连接', '正在检查电脑状态…');
    try {
      const response = await timedFetch('/api/status', {
        cache: 'no-store',
        headers: {'Authorization': `Bearer ${token()}`}
      }, 3500);
      if (response.status === 401) {
        setStatus('offline', '配对失效', '请重新在电脑上扫码配对');
        showPairing('当前密钥无效，请重新配对。');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      deviceName.textContent = data.device || 'Windows 电脑';
      setStatus('online', '在线', '可以发送电源指令');
      pairPanel.classList.add('hidden');
    } catch (_) {
      setStatus('offline', '未连接', '请确认 iPhone 与电脑在同一 Wi-Fi');
    }
  }
  async function sendAction(action) {
    const name = actionNames[action];
    if (!name || !window.confirm(`确定让电脑${name}吗？`)) return;
    feedback.classList.remove('error-text');
    feedback.textContent = '正在发送指令…';
    actions.forEach(button => { button.disabled = true; });
    try {
      const response = await timedFetch('/api/power', {
        method: 'POST',
        cache: 'no-store',
        headers: {'Authorization': `Bearer ${token()}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({action})
      }, 5000);
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      feedback.textContent = `指令已送达，电脑即将${name}。`;
      if (action === 'shutdown' || action === 'hibernate' || action === 'sleep' || action === 'restart') {
        setStatus('checking', '正在切换', '请等待电脑完成操作');
      }
    } catch (error) {
      feedback.classList.add('error-text');
      feedback.textContent = `发送失败：${error.message}`;
      await refresh();
    }
  }

  document.getElementById('pair-button').addEventListener('click', () => {
    const entered = pairInput.value.trim();
    if (!/^[a-f\d]{64}$/i.test(entered)) {
      pairError.textContent = '请输入电脑配对页面显示的 64 位密钥。';
      return;
    }
    localStorage.setItem(keyName, entered);
    pairInput.value = '';
    pairError.textContent = '';
    refresh();
  });
  document.getElementById('refresh-button').addEventListener('click', refresh);
  document.getElementById('forget-button').addEventListener('click', () => {
    if (!window.confirm('确定清除这台 iPhone 的配对信息吗？')) return;
    localStorage.removeItem(keyName);
    feedback.textContent = '';
    refresh();
  });
  actions.forEach(button => button.addEventListener('click', () => sendAction(button.dataset.action)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  refresh();
})();
