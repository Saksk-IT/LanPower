const test = require('node:test'), assert = require('node:assert/strict');
const {CodexController} = require('../mini_program/utils/codex/controller');
let definition;global.Page = value => definition = value;require('../mini_program/pages/codex/codex');delete global.Page;

function setup(t) {
  const c = new CodexController({stop:()=>{},request:async()=>{throw new Error('详情点击不应请求写入');}});
  c.state = 'runtime_ready';c.deviceId = 'fixture';c.threadId = 'chat';
  c.current = {id:'chat',turns:[{id:'t',status:'completed',items:[
    {id:'cmd',type:'commandExecution',command:'verify fixture',cwd:'C:/Fixture',status:'completed',exitCode:0,aggregatedOutput:'完整命令输出'},
    {id:'reason',type:'reasoning',summary:['公开思考摘要']},
    {id:'web',type:'webSearch',status:'completed',action:{type:'search',queries:['公开查询']}},
    {id:'files',type:'fileChange',status:'completed',changes:[{path:'public.txt',kind:{type:'add'},diff:'完整新文件内容\n'}]},
  ]}]};
  c.expandedActivities.add('activity:t:cmd');
  const page = {...definition,data:structuredClone(definition.data),controller:c,visible:true,follow:false};
  page.data.view = 'chat';page.setData = (patch,done) => {Object.assign(page.data,patch);if(done)done();};
  page.paint = () => {page.setData(c.messages());return Promise.resolve();};page.paint();
  c.changed = () => page.schedulePaint();
  t.after(()=>{clearTimeout(page.paintTimer);c.dispose();delete global.wx;});
  return {c,page};
}
const tap = (key,extra={}) => ({currentTarget:{dataset:{key,...extra}}});
const markedTap = (key,action,extra={}) => ({currentTarget:{dataset:{}},target:{dataset:{}},mark:{workdrawer:true,activitykey:key,activityaction:action,...extra}});

test('历史刷新期间点击内部思考、网页和文件仍立即更新，保持大抽屉展开',async t=>{
  const {c,page}=setup(t);
  for(const key of ['t:reason','t:web','t:files']) {
    page.chatUpdating={controller:c,context:c.key,epoch:c.epoch,selection:c.selection,rendering:false};
    await page.toggleRow(tap(key));
    assert.equal(c.expandedActivities.has(key),true,key+' 的点击不能被历史刷新锁丢弃');
    assert.equal(page.data.messages.find(row=>row.key===key).expanded,true);
    assert.equal(c.expandedActivities.has('activity:t:cmd'),true);
  }
});

test('模板内点击文字或箭头通过事件标记定位记录，命令和文件详情保留完整内容',async t=>{
  const {page}=setup(t);
  await page.activityTap(markedTap('t:reason','toggle'));
  assert.equal(page.data.messages.find(row=>row.key==='t:reason').text,'公开思考摘要');
  await page.activityTap(markedTap('t:web','toggle'));
  assert.ok(page.data.messages.find(row=>row.key==='t:web').text.includes('公开查询'));
  page.activityTap(markedTap('t:cmd','command'));
  assert.equal(page.data.sheet,'detail');assert.ok(page.detailText.includes('完整命令输出'));page.closeSheet();
  await page.activityTap(markedTap('t:files','toggle'));
  page.activityTap(markedTap('t:files','file',{activityindex:0}));
  assert.equal(page.data.detailTitle,'public.txt');assert.equal(page.detailText,'完整新文件内容\n');
});

test('内层原生触摸不触发外层历史滚动，内容区点击不会误展开',async t=>{
  const {c,page}=setup(t);page.follow=true;let held=0;c.holdWindow=()=>held++;
  page.chatTouchStart({mark:{workdrawer:true},touches:[{clientY:100}]});
  page.chatTouchMove({mark:{workdrawer:true},touches:[{clientY:200}]});
  assert.equal(held,0);assert.equal(page.follow,true);assert.equal(page.touchY,undefined);
  await page.activityTap({currentTarget:{dataset:{}},target:{dataset:{}},mark:{workdrawer:true}});
  assert.equal(c.expandedActivities.size,1);
});

test('原生布局查询未回调时展开仍完成，后续折叠点击不会一直被锁住',async t=>{
  const {c,page}=setup(t);let queries=0;
  global.wx={createSelectorQuery:()=>{queries++;const q={in:()=>q,select:()=>q,selectAll:()=>q,boundingClientRect:()=>q,scrollOffset:()=>q,exec:()=>{}};return q;}};
  await page.toggleRow(tap('t:reason'));
  assert.ok(queries>0);assert.equal(c.expandedActivities.has('t:reason'),true);assert.equal(page.chatUpdating,null);
  await page.toggleRow(tap('t:reason'));
  assert.equal(c.expandedActivities.has('t:reason'),false);assert.equal(page.chatUpdating,null);
});

test('快速点击多个内部记录不会丢失，旧历史加载完成仍保留已打开的内容',async t=>{
  const {c,page}=setup(t);let finish;
  const history=page.updateChat(()=>new Promise(resolve=>finish=resolve));
  await Promise.all([page.toggleRow(tap('t:reason')),page.toggleRow(tap('t:web'))]);
  assert.equal(page.data.messages.find(row=>row.key==='t:reason').expanded,true);
  assert.equal(page.data.messages.find(row=>row.key==='t:web').expanded,true);
  finish();await history;
  assert.equal(c.expandedActivities.has('t:reason'),true);assert.equal(c.expandedActivities.has('t:web'),true);
  assert.equal(page.chatUpdating,null);
});
