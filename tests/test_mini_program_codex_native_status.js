const test = require('node:test'), assert = require('node:assert/strict');
const {CodexController} = require('../mini_program/utils/codex/controller');
const {ResourceBrowser} = require('../mini_program/utils/codex/resources');
test('小程序额度与上下文来自原生接口，失败和切换电脑清除旧数据', async () => {
  let failed = false; const calls = [];
  const client = {request:async method => {calls.push(method); if(failed) throw new Error('原窗口额度不可读'); return {rateLimits:{primary:{usedPercent:15}}};},connect(){},stop(){}};
  const controller = new CodexController(client); controller.state = 'runtime_ready'; controller.threadId = 'a';
  await controller.nativeUsage.readQuota(); assert.equal(controller.nativeUsage.state.snapshots[0].primary.usedPercent,15); assert.deepEqual(calls,['account/rateLimits/read']);
  const count = totalTokens => ({totalTokens,inputTokens:totalTokens,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0});
  controller.onEvent({method:'thread/tokenUsage/updated',params:{threadId:'a',tokenUsage:{total:count(10),last:count(5),modelContextWindow:20}}});
  assert.equal(controller.nativeUsage.context('a').usage.remainingContextPercent,75); assert.equal(controller.nativeUsage.context('b').usage,null);
  failed = true; await controller.nativeUsage.readQuota(); assert.equal(controller.nativeUsage.state.snapshots.length,0); assert.match(controller.nativeUsage.state.reason,/不可读/);
  controller.chooseDevice('other'); assert.equal(controller.nativeUsage.context('a').usage,null); controller.dispose();
});
test('小程序技能目录只读当前页，翻页保留所选项目，断线丢弃迟到结果',async () => {
  const calls = [], client = {request:async(method,params) => {calls.push({method,params}); return {data:[{skills:[{name:params.cursor || 'first',path:'fixture/SKILL.md',enabled:true}]}],nextCursor:params.cursor ? null : 'second'};}};
  const resource = new ResourceBrowser(client,()=>true,()=>{});
  await resource.directoryCatalog('skill','D:/Fixture'); assert.equal(calls.length,1); assert.equal(calls[0].params.limit,24); assert.equal(resource.catalog.rows[0].name,'first');
  await resource.catalogPager.next(); assert.equal(resource.catalog.page,2); assert.equal(calls[1].params.cwd,'D:/Fixture'); assert.equal(calls[1].params.cursor,'second');
  await resource.catalogPager.previous(); assert.equal(resource.catalog.page,1);
  let release; client.request = () => new Promise(resolve => release = resolve);
  const old = resource.directoryCatalog('plugin','D:/Fixture'); resource.reset(); release({marketplaces:[{name:'old',plugins:[{name:'stale'}]}]}); await old;
  assert.equal(resource.catalog.rows.length,0);
});
