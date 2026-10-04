// Real browser original images and chunked submission with isolated RPC fixtures.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
async function until(check) { for (let i=0;i<1000;i++) { if (check()) return; await new Promise(resolve=>setTimeout(resolve,10)); } throw new Error('chunked submission did not finish'); }

(async () => {
  const base = process.env.LANPOWER_DEV_URL || 'https://localhost:8443';
  const password = fs.readFileSync(path.resolve(__dirname, '../deploy/docker/private/dev-login.txt'), 'utf8').match(/^Password: (.+)$/m)[1].trim();
  const calls = [], errors = [], images = [], root = 'D:/Projects/ImageSubmission';
  let queueVisible = true, rejectFirst = true;
  const metadata = id => ({id, name: id === 'image-chat' ? '图片发送验收' : '切换会话验收', cwd: root, createdAt: 100, updatedAt: 100, control: 'shared', status: {type: 'idle'}});
  async function rpc(request) {
    calls.push(request);
    const p = request.params || {};
    switch (request.method) {
      case 'lanpower/status': return {result: {projects: [{name: 'ImageSubmission', path: root}], sharedControl: true, desktopControl: true, queueSupported: true, submissionReceipts: true, activeTurns: [], pendingApprovals: []}};
      case 'model/list': return {result: {data: [{id: 'gpt-6', isDefault: true}]}};
      case 'collaborationMode/list': return {result: {data: [{mode: 'default'}]}};
      case 'lanpower/files/upload': {
        assert.equal(p.cwd, root); assert.equal(p.name,'original.txt');
        assert.equal(Buffer.from(p.base64,'base64').length,2 * 1024 * 1024);
        assert.ok(Buffer.from(p.base64,'base64').every(byte => byte === 120));
        return {result:{path:root+'/attachments/original.txt'}};
      }
      case 'thread/list': case 'lanpower/library/list': return {result: {data: ['image-chat', 'other-chat'].map(metadata)}};
      case 'thread/read': return {result: {thread: {...metadata(p.threadId), turns: []}}};
      case 'thread/queue/list': return {result: {data: queueVisible && p.threadId === 'image-chat' ? [{id: 'queued-images', input: [{type: 'text', text: '编辑前的两张截图'}, ...images.map(url => ({type: 'image', url}))]}] : []}};
      case 'turn/start': case 'turn/steer': case 'thread/queue/update': {
        const urls = p.input.filter(item => item.type === 'image').map(item => item.url);
        assert.ok(urls.every(url => images.includes(url)), 'original image bytes must survive every hop');
        if (rejectFirst) { rejectFirst = false; return {error: {code: -32602, message: 'invalid_params', data: {notSent: true}}}; }
        if (request.method === 'thread/queue/update') queueVisible = false;
        return {result: {receipt: {state: 'accepted'}}};
      }
      default: return {result: {data: []}};
    }
  }
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 980}, serviceWorkers: 'block'});
  try {
    if (process.env.LANPOWER_IMAGE_UI_DIR) {
      await context.route('**/static/codex-ui/**', route => {
        const name = new URL(route.request().url()).pathname.split('/static/codex-ui/')[1];
        return route.fulfill({path: path.join(process.env.LANPOWER_IMAGE_UI_DIR, name), contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript'});
      });
    }
    await context.exposeBinding('__imageRpc', (_, request) => rpc(request));
    await context.addInitScript(() => {
      window.WebSocket = class {
        static OPEN = 1; readyState = 1;
        constructor() { setTimeout(() => {this.onopen?.({}); this.frame({type: 'state', state: 'runtime_ready'});}, 20); }
        frame(value) { this.onmessage?.({data: JSON.stringify(value)}); }
        uploads = new Map(); bufferedAmount = 0;
        async send(raw) {
          let frame = JSON.parse(raw);
          if (frame.type === 'rpc_upload') {
            const parts = this.uploads.get(frame.id) || []; if (parts.length !== frame.index) throw new Error('unordered upload');
            parts.push(frame.data); this.uploads.set(frame.id,parts);
            if (parts.length !== frame.count) return;
            this.uploads.delete(frame.id); frame = JSON.parse(parts.join(''));
          }
          if (frame.type !== 'rpc') return;
          const reply = await window.__imageRpc(frame.payload); this.frame({type: 'rpc', payload: {id: frame.payload.id, ...reply}});
        }
        close() { this.readyState = 3; }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => errors.push('resource:' + new URL(request.url()).pathname));
    page.on('dialog', dialog => dialog.accept());
    images.push(...await page.evaluate(() => {
      const result = [];
      for (let number = 0; number < 2; number++) {
        const canvas = document.createElement('canvas'); canvas.width = 2100; canvas.height = 1400;
        const ctx = canvas.getContext('2d'); let selected = '';
        for (const height of [40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240]) {
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.font = '28px sans-serif'; ctx.fillStyle = '#333333';
          for (let row = 0; row < 20; row++) ctx.fillText(`Screenshot ${number + 1}: readable text row ${row + 1}`, 40, 50 + row * 48);
          const noise = ctx.createImageData(600, height); let seed = 314159 + number;
          for (let offset = 0; offset < noise.data.length; offset += 4) {
            for (let channel = 0; channel < 3; channel++) {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; noise.data[offset + channel] = seed >>> 24;}
            noise.data[offset + 3] = 255;
          }
          ctx.putImageData(noise, 1400, 100);
          selected = canvas.toDataURL('image/png');
          if (selected.length >= 480000 && selected.length <= 640000) break;
        }
        result.push(selected);
      }
      return result;
    }));
    assert.ok(images.every(url => url.length <= 700000), JSON.stringify(images.map(url => url.length)));
    const originalTotal = images.reduce((sum, url) => sum + url.length, 0);
    assert.ok(originalTotal > 850000);
    const files = images.map((url, index) => ({name: `screenshot-${index}.png`, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64')}));
    await page.goto(base + '/login');
    await page.locator('[name=username]').fill('admin'); await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL('**/dashboard'), page.locator('form[action="/login"] button').click()]);
    await page.goto(base + '/remote');
    await page.waitForFunction(() => document.querySelector('[data-thread-id="image-chat"]'),undefined,{timeout:10000}).catch(async error => {
      if (process.env.LANPOWER_IMAGE_REPORT_DIR) await page.screenshot({path:path.join(process.env.LANPOWER_IMAGE_REPORT_DIR,'browser-debug.png')});
      console.log(JSON.stringify({fixtureMethods:calls.map(call=>call.method),errors}));
      throw error;
    });
    await page.locator('[data-thread-id="image-chat"] .lp-thread-title').click();
    const input = page.locator('.thread-composer-input');
    const picker = () => page.locator('input[type=file][multiple]').first();
    const sent = () => calls.filter(call => ['turn/start', 'turn/steer', 'thread/queue/update'].includes(call.method));
    await picker().setInputFiles(files);
    await page.waitForFunction(() => document.querySelectorAll('.thread-composer-attachment').length === 2 && !document.querySelector('.thread-composer-input').disabled);
    await input.fill('两张截图发送后保留失败草稿'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.lp-send-receipt')?.textContent.includes('发送失败'));
    assert.equal(sent().length, 1); assert.equal(await input.inputValue(), '两张截图发送后保留失败草稿');
    assert.equal(await page.locator('.thread-composer-attachment').count(), 2);
    assert.ok(!(await page.locator('.thread-composer').textContent()).includes('700000'));
    await page.locator('.queued-row-edit').click();
    await page.waitForFunction(() => document.querySelector('.thread-composer-input')?.value === '编辑前的两张截图');
    await input.fill('编辑后的两张截图'); await input.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.lp-edit-queue') && document.querySelector('.thread-composer-input')?.value === '');
    const update = sent().find(call => call.method === 'thread/queue/update');
    assert.ok(update); assert.equal(update.params.queuedSubmissionId, 'queued-images');
    await picker().setInputFiles(Array.from({length:10},(_,i)=>({...files[i%2],name:`original-${i}.png` })));
    await page.waitForFunction(() => document.querySelectorAll('.thread-composer-attachment').length === 10 && !document.querySelector('.thread-composer-input').disabled);
    await input.fill('十张原图 '+ '中🎨'.repeat(20000)); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.thread-composer-input')?.value === '' && document.querySelectorAll('.thread-composer-attachment').length === 0);
    await until(() => sent().at(-1).params.input.filter(item=>item.type==='image').length===10);
    assert.equal(sent().at(-1).params.input.filter(item => item.type === 'image').length, 10); assert.ok(sent().at(-1).params.input[0].text.length>16000);
    await picker().setInputFiles(files);
    await page.waitForFunction(() => document.querySelectorAll('.thread-composer-attachment').length === 2 && !document.querySelector('.thread-composer-input').disabled);
    await page.locator('form.thread-composer').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('.thread-composer-attachment').length === 0);
    await until(() => sent().at(-1).params.input.filter(item=>item.type==='image').length===2 && sent().at(-1).params.input.every(item=>item.type!=='text'));
    assert.equal(sent().at(-1).params.input.filter(item => item.type === 'text').length, 0);
    await picker().setInputFiles([{name:'original.txt',mimeType:'text/plain',buffer:Buffer.alloc(2 * 1024 * 1024,120)}]);
    await page.waitForFunction(() => document.querySelectorAll('.thread-composer-file-chip').length === 1 && !document.querySelector('.thread-composer-input').disabled);
    await input.fill('读取我上传的完整文件'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.thread-composer-file-chip').length === 0);
    await until(() => sent().at(-1).params.input[0]?.text?.includes(root+'/attachments/original.txt'));
    assert.ok(sent().at(-1).params.input[0].text.includes(root+'/attachments/original.txt'));
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    assert.deepEqual(errors, []);
    const report = {originalTotal, submittedImageTotals: sent().map(call => call.params.input.filter(item => item.type === 'image').reduce((sum, item) => sum + item.url.length, 0)), newImages: true, queuedEdit: true, tenOriginalImages: true, originalBytesPreserved:true, ordinaryFileUpload:true, imagesOnly: true, rejectedDraftPreserved: true, widths: [1440, 390, 320], browserErrors: errors.length};
    if (process.env.LANPOWER_IMAGE_REPORT_DIR) {
      fs.mkdirSync(process.env.LANPOWER_IMAGE_REPORT_DIR, {recursive: true});
      fs.writeFileSync(path.join(process.env.LANPOWER_IMAGE_REPORT_DIR, 'browser-result.json'), JSON.stringify(report, null, 2));
      fs.writeFileSync(path.join(process.env.LANPOWER_IMAGE_REPORT_DIR, 'prepared-rpc.json'), JSON.stringify(update));
    }
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(error => {console.error(error.stack); process.exitCode = 1;});
