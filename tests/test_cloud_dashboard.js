const assert = require('node:assert/strict');
const {waitForWake} = require('../cloud_app/static/dashboard.js');

async function run() {
  let now = 0, reads = 0;
  const options = {now: () => now, wait: async ms => { now += ms; }};
  assert.equal(await waitForWake(async () => ({online: ++reads === 3}), options), true);
  assert.equal(now, 15000);
  now = reads = 0;
  assert.equal(await waitForWake(async () => { reads++; return {online: false}; }, options), false);
  assert.equal(reads, 24);
  assert.equal(now, 120000);
  now = reads = 0;
  assert.equal(await waitForWake(async () => {
    if (++reads < 3) throw new Error('temporary network error');
    return {online: true};
  }, options), true);
  now = reads = 0;
  assert.equal(await waitForWake(async () => {
    reads++; now += 4500; throw new Error('timeout');
  }, options), false);
  assert.ok(now >= 120000 && now <= 124500 && reads <= 24);
  const controller = new AbortController();
  await assert.rejects(waitForWake(async () => assert.fail('cancelled page must stop polling'), {
    ...options, signal: controller.signal, wait: async () => controller.abort()
  }), {name: 'AbortError'});
  console.log('Cloud wake success, 120-second limit, network recovery and cancellation: PASS');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
