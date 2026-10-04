const test = require('node:test');
const assert = require('node:assert/strict');
const {buildLibrary, defaultPreferences} = require('../mini_program/utils/codex/model');
const {homePreferences, homeLibrary, quotaSummary} = require('../mini_program/utils/codex/home');

test('最近合并项目和独立会话，按实际更新时间排序并尊重收纳与搜索', () => {
  const preferences = defaultPreferences(); preferences.hidden = ['d:/hidden'];
  const threads = [
    {id:'project',name:'修复项目',cwd:'D:/Project',updatedAt:1000},
    {id:'chat',name:'独立会话',cwd:'',updatedAt:2000},
    {id:'hidden',name:'已收纳会话',cwd:'D:/Hidden',updatedAt:3000}
  ];
  const projects = [{name:'项目',path:'D:/Project'}, {name:'已收纳',path:'D:/Hidden'}];
  const library = buildLibrary(projects, threads, preferences);
  assert.deepEqual(homeLibrary(library, homePreferences(), 'all', [], []).recent.map(row=>row.id), ['chat','project']);
  const independent = homeLibrary(library, homePreferences(), 'chats', [], []);
  assert.equal(independent.timeline,true); assert.deepEqual(independent.groups,[]); assert.deepEqual(independent.recent.map(row=>row.id),['chat']);
  assert.deepEqual(homeLibrary(buildLibrary(projects, threads, preferences, '已收纳'), homePreferences(), 'all', [], []).recent.map(row=>row.id), ['hidden']);
  assert.deepEqual(threads.map(row=>row.updatedAt),[1000,2000,3000], '显示方式不改变原生会话时间');
});

test('优先级先显示待回复，再显示运行、置顶和其他会话', () => {
  const rows = ['old','pinned','running','pending','new'].map((id,index)=>({id,updatedAt:index+1,running:id==='running'}));
  const home = homeLibrary({projects:[],chats:rows}, {order:'priority'}, 'all', ['pending'], ['pinned']);
  assert.deepEqual(home.recent.map(row=>row.id), ['pending','running','pinned','new','old']);
  assert.deepEqual(rows.map(row=>row.id), ['old','pinned','running','pending','new']);
});

test('首页偏好校验持久化值，默认按项目且优先显示最近', () => {
  assert.deepEqual(homePreferences(null),{order:'project',recentFirst:true});
  assert.deepEqual(homePreferences({order:'unknown',recentFirst:false}),{order:'project',recentFirst:false});
  assert.deepEqual(homePreferences({order:'priority',recentFirst:true}),{order:'priority',recentFirst:true});
});

test('菜单剩余用量来自原生窗口，无窗口时不生成百分比', () => {
  assert.deepEqual(quotaSummary([]),[]);
  assert.deepEqual(quotaSummary([{limitId:'credits',credits:{balance:'10'}}]),[]);
  const rows = quotaSummary([{limitId:'codex',primary:{windowDurationMins:300,usedPercent:49},secondary:{windowDurationMins:10080,usedPercent:65}}]);
  assert.deepEqual(rows.map(row=>[row.label,row.remaining]),[['5 小时',51],['每周',35]]);
});
