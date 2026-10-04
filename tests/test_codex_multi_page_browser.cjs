// Read-only acceptance against the installed local Cloud, Service and user Host.
// It never submits a turn, answers an approval, or changes native history.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
let stage = 'launch';
(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const output = path.resolve(__dirname, '../private/codex-multipage-20261004/browser'); fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext(), first = await context.newPage(), errors = [];
    first.on('pageerror', error => errors.push(error.name));
    context.on('page', page => page.on('pageerror', error => errors.push(error.name)));
    const password = fs.readFileSync(process.env.LANPOWER_DEV_LOGIN_FILE || path.resolve(__dirname, '../deploy/docker/private/dev-login.txt'), 'utf8').match(/^Password: (.+)$/m)[1].trim();
    stage = 'login'; await first.goto(base + '/login');
    await first.locator('[name=username]').fill('admin'); await first.locator('[name=password]').fill(password);
    await Promise.all([first.waitForURL('**/dashboard'), first.locator('form[action="/login"] button').click()]);
    const devices = await first.evaluate(() => fetch('/api/v2/devices').then(r => r.json()));
    let device;
    for (const candidate of devices) {
      const remote = await first.evaluate(id => fetch('/api/v2/remote/status/' + encodeURIComponent(id)).then(r => r.ok ? r.json() : null), candidate.device_id);
      if (remote?.connected) {device = candidate.device_id; break;}
    }
    assert.ok(device, 'connected Windows Host required');
    const url = base + '/remote?computer=' + encodeURIComponent(device);
    stage = 'first-page'; await first.goto(url);
    await first.waitForFunction(() => document.querySelector('.lp-connection')?.textContent.includes('已连接'), null, {timeout: 60000});
    stage = 'second-page'; const second = await context.newPage(); await second.goto(url);
    await second.waitForFunction(() => document.querySelector('.lp-connection')?.textContent.includes('已连接'), null, {timeout: 60000});
    await first.waitForFunction(() => document.querySelector('.lp-connection')?.textContent.includes('已连接'), null, {timeout: 60000});
    assert.ok((await first.locator('.lp-connection').textContent()).includes('已连接'));
    for (const page of [first, second]) assert.ok(!(await page.locator('body').textContent()).includes('请关闭该页面后重连'));
    stage = 'native-history';
    for (const page of [first, second]) await page.locator('.lp-thread').first().waitFor({state: 'visible', timeout: 60000});
    await first.locator('.lp-thread').first().click(); await second.locator('.lp-thread').first().click();
    for (const page of [first, second]) await page.locator('.thread-composer-input').waitFor({state: 'visible', timeout: 60000});
    stage = 'colliding-rpc-ids';
    const routing = await second.evaluate(async device => {
      const sockets = [];
      function open() {return new Promise((resolve, reject) => {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/v2/remote/client/' + encodeURIComponent(device), 'lanpower.codex.v1');
        const timer = setTimeout(() => reject(new Error('ready_timeout')), 30000); sockets.push(socket);
        socket.onmessage = ({data}) => {
          const frame = JSON.parse(data);
          if (frame.type === 'ping') socket.send('{"type":"pong"}');
          if (frame.type === 'state' && frame.state === 'runtime_ready') {clearTimeout(timer); resolve(socket);}
        };
        socket.onclose = () => {clearTimeout(timer); reject(new Error('connection_closed'));};
      });}
      function request(socket, method) {return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rpc_timeout')), 35000);
        socket.onmessage = ({data}) => {
          const frame = JSON.parse(data);
          if (frame.type === 'ping') socket.send('{"type":"pong"}');
          if (frame.type === 'rpc' && frame.payload?.id === 1 && !frame.payload.method) {
            clearTimeout(timer); frame.payload.error ? reject(new Error('rpc_rejected')) : resolve(frame.payload.result);
          }
        };
        socket.send(JSON.stringify({type: 'rpc', payload: {id: 1, method, params: {}}}));
      });}
      try {
        const a = await open(), b = await open();
        const [status, models] = await Promise.all([request(a, 'lanpower/status'), request(b, 'model/list')]);
        const isolated = Array.isArray(status.projects) && !status.data && Array.isArray(models.data) && !models.projects;
        a.close();
        const after = await request(b, 'lanpower/status');
        return {isolated, remainingRpcWorks: Array.isArray(after.projects)};
      } finally {for (const socket of sockets) socket.close();}
    }, device);
    assert.ok(routing.isolated && routing.remainingRpcWorks);
    stage = 'close-one-page'; await first.close();
    await second.reload();
    await second.waitForFunction(() => document.querySelector('.lp-connection')?.textContent.includes('已连接'), null, {timeout: 60000});
    await second.locator('.thread-composer-input').waitFor({state: 'visible', timeout: 60000});
    const health = await second.evaluate(() => fetch('/healthz').then(r => r.json()));
    assert.equal(health.version, '1.16.2'); assert.equal(errors.length, 0);
    const report = {version: health.version, localHttps: health.ok, twoPagesReady: true, bothReadNativeHistory: true,
      ...routing, closeAndRefreshRetainAccess: true, browserErrors: errors.length, inferenceSubmitted: false};
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(error => {console.error(JSON.stringify({failure: 'multi_page_browser_check_failed', stage, type: error.name})); process.exitCode = 1;});
