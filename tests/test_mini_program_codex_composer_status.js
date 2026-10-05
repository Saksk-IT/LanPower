const test = require('node:test'), assert = require('node:assert/strict');
const {CodexController} = require('../mini_program/utils/codex/controller');
const {contextIndicator, effortGauge, orderedEfforts} = require('../mini_program/utils/codex/composer-status');
const {observeSettings} = require('../mini_program/utils/codex/model');
let definition; global.Page = value => definition = value;
require('../mini_program/pages/codex/codex'); delete global.Page;
function setup(t) {
  const c = new CodexController({request: async () => ({}), stop() {}});
  Object.assign(c, {state: 'runtime_ready', deviceId: 'pc', threadId: 'a', current: {id: 'a', cwd: 'C:/Fixture', turns: []}, sharedControl: true, synced: true});
  c.reconcile = () => {};
  c.models = [{id: 'model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['xhigh', 'low', 'high', 'medium'].map(reasoningEffort => ({reasoningEffort}))}];
  observeSettings(c.threadSettings, {model: 'model', reasoningEffort: 'medium'}, 'model');
  const page = {...definition, data: structuredClone(definition.data), controller: c, visible: true, follow: false, imagePaths: new Map(), libraryOffset: 0, groupOffsets: {}, chatOffset: 0};
  page.setData = patch => Object.assign(page.data, patch);
  t.after(() => c.dispose()); return {c, page};
}
const count = totalTokens => ({totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0});
function usage(c, last, window = 100) {
  c.onEvent({method: 'thread/tokenUsage/updated', params: {threadId: 'a', tokenUsage: {total: count(9000), last: count(last), modelContextWindow: window}}});
}
test('上下文圆圈随当前会话真实用量和压缩变化，不采用累计用量', async t => {
  const {c, page} = setup(t);
  usage(c, 25); await page.paint();
  assert.equal(page.data.contextUsedPercent, 25); assert.equal(page.data.contextPercent, 75);
  assert.match(page.data.contextLabel, /已用 25%.*剩余 75%/);
  const first = page.data.contextRingStyle;
  usage(c, 80); await page.paint(); assert.equal(page.data.contextUsedPercent, 80); assert.notEqual(page.data.contextRingStyle, first);
  usage(c, 10); await page.paint(); assert.equal(page.data.contextUsedPercent, 10);
  page.openStatus(); assert.equal(page.data.sheet, 'status');
});
test('会话切换、缺失上下文窗口和断线显示待确认，不冒用旧会话比例', async t => {
  const {c, page} = setup(t); usage(c, 30); await page.paint();
  c.threadId = 'b'; await page.paint(); assert.equal(page.data.contextPercent, null);
  c.threadId = 'a'; usage(c, 30, null); await page.paint(); assert.equal(page.data.contextPercent, null);
  assert.equal((decodeURIComponent(page.data.contextRingStyle).match(/<circle /g) || []).length, 1);
  usage(c, 30); c.onState('disconnected'); await page.paint(); assert.equal(page.data.contextPercent, null);
});
test('模型强度按级别排列，原生设置和本地选择分别更新仪表盘', async t => {
  const {c, page} = setup(t); await page.paint();
  assert.deepEqual(page.data.efforts, ['low', 'medium', 'high', 'xhigh']);
  const medium = page.data.effortAngle;
  c.onEvent({method: 'thread/settings/updated', params: {threadId: 'a', settings: {model: 'model', effort: 'high'}}}); await page.paint();
  assert.ok(page.data.effortAngle > medium);
  page.slideEffort({detail: {value: 3}}); await page.paint(); const selected = page.data.effortAngle;
  assert.equal(page.data.selectedEffort, 'xhigh');
  c.onEvent({method: 'thread/settings/updated', params: {threadId: 'a', settings: {effort: 'low'}}}); await page.paint();
  assert.equal(page.data.effortAngle, selected);
  page.inheritSettings(); await page.paint(); assert.ok(page.data.effortAngle < medium);
  page.openOptions(); assert.equal(page.data.sheet, 'options');
});
test('缺失强度不伪造指针，已知默认强度和超出窗口用量安全显示', () => {
  assert.equal(effortGauge('', null).effortKnown, false);
  assert.equal(effortGauge('unknown', null).effortKnown, false);
  assert.deepEqual(effortGauge('', {defaultReasoningEffort: 'high'}), effortGauge('high'));
  const angles = orderedEfforts(['ultra', 'none', 'high', 'minimal', 'low', 'xhigh', 'medium', 'max']).map(value => effortGauge(value).effortAngle);
  assert.ok(angles.every((angle, index) => index === 0 || angle > angles[index - 1]));
  assert.equal(contextIndicator({currentContextTokens: 150, modelContextWindow: 100}).contextUsedPercent, 100);
  assert.equal(contextIndicator({currentContextTokens: -1, modelContextWindow: 100}).contextUsedPercent, null);
  assert.notEqual(contextIndicator(null, 'light').contextRingStyle, contextIndicator(null, 'dark').contextRingStyle);
});
test('仪表盘蓝色弧线终点与指针角度一致，随强度共同向右延伸', () => {
  let previous = -1;
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const gauge = effortGauge(effort), svg = decodeURIComponent(gauge.effortArcStyle);
    const blue = svg.match(/stroke="#315ff5".*?stroke-dasharray="([\d.]+) ([\d.]+)" transform="rotate\((-?\d+)/);
    assert.equal(gauge.effortArcDegrees, gauge.effortAngle + 110);
    if (gauge.effortArcDegrees === 0) { assert.equal(blue, null); continue; }
    assert.ok(Number(blue[1]) > previous); previous = Number(blue[1]);
    const endpoint = Number(blue[3]) + Number(blue[1]) / (2 * Math.PI * 10) * 360;
    assert.ok(Math.abs(endpoint - (gauge.effortAngle - 90)) < 0.01, '蓝色弧线应结束在指针方向');
  }
});
