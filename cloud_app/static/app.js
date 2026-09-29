document.querySelectorAll('form[data-confirm], form[data-confirm-message]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const action = form.dataset.confirm;
    const message = form.dataset.confirmMessage || (action ? `确定要让电脑${action}吗？` : '');
    if (message && !window.confirm(message)) event.preventDefault();
  });
});

const decodeBase64url = (value) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), c => c.charCodeAt(0));
};

const encodeBase64url = (value) => {
  if (value == null) return null;
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const publicKeyOptions = (options) => {
  const result = { ...options, challenge: decodeBase64url(options.challenge) };
  if (options.user) result.user = { ...options.user, id: decodeBase64url(options.user.id) };
  for (const field of ['allowCredentials', 'excludeCredentials']) {
    if (options[field]) result[field] = options[field].map(item => ({ ...item, id: decodeBase64url(item.id) }));
  }
  return result;
};

const credentialJSON = (credential) => {
  const response = { clientDataJSON: encodeBase64url(credential.response.clientDataJSON) };
  for (const field of ['attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    if (field in credential.response) response[field] = encodeBase64url(credential.response[field]);
  }
  if (credential.response.getTransports) response.transports = credential.response.getTransports();
  return { id: credential.id, rawId: encodeBase64url(credential.rawId), type: credential.type,
    response, clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment };
};

const authRequest = async (path, payload) => {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json',
      'X-Auth-Token': document.querySelector('meta[name="lp-auth"]')?.content || '',
      'X-CSRF-Token': document.querySelector('meta[name="lp-csrf"]')?.content || '' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成，请重试');
  return data;
};

const finishAuth = (result, form) => {
  if (!result.recovery_codes?.length) {
    window.location.assign(result.redirect);
    return;
  }
  form.hidden = true;
  const panel = document.querySelector('[data-recovery-panel]');
  const list = panel.querySelector('[data-recovery-codes]');
  list.replaceChildren(...result.recovery_codes.map(code => {
    const item = document.createElement('li');
    item.textContent = code;
    return item;
  }));
  panel.hidden = false;
  const checkbox = panel.querySelector('[data-recovery-saved]');
  const button = panel.querySelector('[data-recovery-continue]');
  checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
  button.addEventListener('click', () => { window.location.assign(result.redirect); });
};

document.querySelectorAll('form[data-auth]').forEach(form => {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const error = document.querySelector('[data-auth-error]');
    error.hidden = true;
    button.disabled = true;
    try {
      const mode = form.dataset.auth;
      if (mode === 'recovery') {
        finishAuth(await authRequest('/api/v2/auth/recovery', { code: new FormData(form).get('code') }), form);
        return;
      }
      if (!window.PublicKeyCredential || !navigator.credentials) {
        throw new Error('当前浏览器无法使用 Passkey，请使用支持 Passkey 的浏览器并通过 HTTPS 访问。');
      }
      const registration = mode !== 'passkey-login';
      const path = `/api/v2/auth/passkeys/${registration ? 'register' : 'login'}`;
      const proof = mode === 'setup' ? { setup_code: new FormData(form).get('setup_code') } : {};
      const ceremony = await authRequest(`${path}/options`, proof);
      const options = { publicKey: publicKeyOptions(ceremony.options) };
      const credential = registration ? await navigator.credentials.create(options) : await navigator.credentials.get(options);
      if (!credential) throw new Error('未完成 Passkey 验证，请重试');
      const result = await authRequest(`${path}/verify`, { ...proof, challenge_id: ceremony.challenge_id,
        credential: credentialJSON(credential) });
      finishAuth(result, form);
    } catch (failure) {
      error.textContent = failure.name === 'NotAllowedError' ? '验证已取消或超时，请重试。'
        : failure.name === 'InvalidStateError' ? '此设备已保存这个 Passkey，请使用其他验证器。'
        : failure.message || '暂时无法完成验证，请重试。';
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
});

const resultCard = document.querySelector('[data-command-id]');
if (resultCard) {
  const commandId = resultCard.dataset.commandId;
  const title = document.getElementById('command-title');
  const progress = document.getElementById('command-progress');
  const poll = async () => {
    try {
      const response = await fetch(`/api/v2/commands/${encodeURIComponent(commandId)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('status unavailable');
      const result = await response.json();
      if (result.state === 'accepted') {
        window.setTimeout(poll, 1500);
        return;
      }
      title.textContent = result.state === 'completed' ? '命令已完成' : result.state === 'transitioning' ? '电脑已确认' : '操作未完成';
      progress.textContent = result.error || (result.state === 'completed' ? '电脑已确认。' : result.state === 'transitioning' ? '电脑正在执行电源操作。' : '电脑未能执行。');
    } catch {
      progress.textContent = '暂时无法取得结果，请稍后查看活动记录。';
    }
  };
  window.setTimeout(poll, 1500);
}
