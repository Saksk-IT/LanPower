const test = require('node:test'), assert = require('node:assert/strict');
const {fileChangeSummary, fileDiffLines} = require('../mini_program/utils/codex/file-changes');
const {itemRow, projectConversation, conversationWindow, changesSummary} = require('../mini_program/utils/codex/conversation');
const changes = [
  {path:'edited.js',kind:{type:'update'},diff:'@@ -4,2 +4,3 @@\n-old\n+new\n same\n+next'},
  {path:'added.js',kind:{type:'add'},diff:'const first = 1;\r\nconst last = 2;\r\n'},
  {path:'deleted.js',kind:{type:'delete'},diff:'removed contents\n'},
  {path:'old.js',kind:{type:'update',move_path:'new.js'},diff:''},
];
test('原生新增和删除的纯内容也计数，移动保留目标；两端共用摘要且不改原记录', () => {
  const before = JSON.stringify(changes), summary = fileChangeSummary(changes);
  assert.equal(summary.label,'已更改 4 个文件'); assert.equal(summary.kinds,'1 修改，1 新增，1 删除，1 移动');
  assert.equal(summary.added,4); assert.equal(summary.removed,2); assert.equal(summary.files[3].movedToPath,'new.js');
  assert.equal(JSON.stringify(changes),before);
  const web = changes.map((change,index) => ({path:change.path,operation:change.kind.type,movedToPath:change.kind.move_path || null,
    diff:change.diff,addedLineCount:[2,2,0,0][index],removedLineCount:[1,0,1,0][index]}));
  assert.deepEqual(fileChangeSummary(web),summary);
  assert.equal(changesSummary({turns:[{id:'turn',items:[{type:'fileChange',changes}]}]}).added,4);
});
test('收起和展开的文件列表都不向视图传输完整差异，仍保留逐文件增删统计', () => {
  const thread={turns:[{id:'t',status:'inProgress',items:[{id:'files',type:'fileChange',status:'completed',changes}]}]};
  const openGroup=new Set(['activity:t:files']);
  const folded=conversationWindow(projectConversation(thread,new Set(),openGroup)).messages.find(row=>row.itemId==='files');
  assert.equal(folded.added,4);assert.deepEqual(folded.files,[]);assert.equal(folded.text,'');
  const expanded=conversationWindow(projectConversation(thread,new Set(),new Set([...openGroup,'t:files']))).messages.find(row=>row.itemId==='files');
  assert.equal(expanded.files.length,4);assert.equal(expanded.files[1].added,2);assert.equal(expanded.files[3].movedToPath,'new.js');
  assert.equal(JSON.stringify(expanded).includes('const last'),false);
});
test('逐行差异保留原行号、增删标记和完整新增内容，空差异不生成虚构代码', () => {
  const lines=fileDiffLines(changes[0].diff);
  assert.deepEqual(lines.filter(row=>row.kind==='add').map(row=>[row.newLine,row.text]),[[4,'new'],[6,'next']]);
  assert.equal(lines.find(row=>row.kind==='remove').oldLine,4);
  assert.deepEqual(fileDiffLines('+actual content\n','add').map(row=>[row.kind,row.text]),[['add','+actual content']]);
  assert.deepEqual(fileDiffLines('','update'),[]);
});
let definition;global.Page = value => definition=value;require('../mini_program/pages/codex/codex');delete global.Page;
function pageFor(files) {
  const page={...definition,data:structuredClone(definition.data),controller:{rows:[itemRow({id:'files',type:'fileChange',changes:files},{id:'t',status:'completed'},0)]}};
  page.setData = patch => Object.assign(page.data,patch);return page;
}
test('点击文件只打开该文件差异，复制保留原始内容，不请求电脑写操作', () => {
  const page=pageFor(changes);page.openFileChange({currentTarget:{dataset:{key:'t:files',index:1}}});
  assert.equal(page.data.detailTitle,'added.js');assert.equal(page.data.detailKind,'diff');
  assert.deepEqual(page.data.detailDiffLines.map(row=>row.text),['const first = 1;','const last = 2;']);
  page.copyText = text => assert.equal(text,changes[1].diff);page.copyDetail();
  page.openFileChange({currentTarget:{dataset:{key:'t:files',index:3}}});assert.equal(page.data.detailTitle,'old.js → new.js');assert.deepEqual(page.data.detailDiffLines,[]);
});
test('长差异分段渲染保留完整 Unicode、真实行号和末尾内容', () => {
  const diff=Array.from({length:250},(_,index)=>'行 '+index).join('\n')+'\n'+'😀'.repeat(2400)+'\n完整末尾\n';
  const page=pageFor([{path:'long.txt',kind:{type:'add'},diff}]);page.openFileChange({currentTarget:{dataset:{key:'t:files',index:0}}});
  assert.ok(page.data.detailPages>1);assert.ok(page.diffPages.every(rows=>Buffer.byteLength(JSON.stringify(rows))<100000));
  const rows=page.diffPages.flat();assert.equal(rows.filter(row=>!row.continuation).map(row=>row.text).slice(0,250).join('\n'),diff.split('\n').slice(0,250).join('\n'));
  assert.equal(rows.filter(row=>row.newLine===251).map(row=>row.text).join(''),'😀'.repeat(2400));
  assert.ok(rows.every(row=>!/[\uD800-\uDBFF]$/.test(row.text) && !/^[\uDC00-\uDFFF]/.test(row.text)));
  page.detailPage({currentTarget:{dataset:{direction:100}}});assert.equal(page.data.detailDiffLines.at(-1).text,'完整末尾');assert.equal(page.detailText,diff);
});
test('命令输出里的文档链接不生成聊天链接，回复中的正常链接保留', () => {
  const output='[三端账号登录](docs/account.md)\n[指南](docs/guide.md)\n[指南](docs/guide.md)';
  const thread={turns:[{id:'t',status:'inProgress',items:[
    {id:'command',type:'commandExecution',command:'read README.md',status:'completed',exitCode:0,aggregatedOutput:output},
    {id:'reply',type:'agentMessage',phase:'commentary',text:'[文档](docs/guide.md)'},
  ]}]};
  for(const expanded of [false,true]) {
    const rows=projectConversation(thread,new Set(),new Set(['activity:t:command',...(expanded?['t:command']:[])]));
    const view=conversationWindow(rows);assert.deepEqual(view.messages.find(row=>row.itemId==='command').links,[]);
    assert.deepEqual(view.messages.find(row=>row.itemId==='reply').links,[{label:'文档',target:'docs/guide.md'}]);
  }
});
test('命令详情不受历史刷新锁阻挡，保留原命令、目录、退出码与完整输出', () => {
  const output='[三端账号登录](docs/account.md)\n'+'完整输出\n'.repeat(2000)+'真实末尾';
  const row=itemRow({id:'cmd',type:'commandExecution',command:'read README.md',cwd:'D:/Fixture/Project',status:'completed',exitCode:1,aggregatedOutput:output},{id:'t'},0);
  const page={...definition,data:structuredClone(definition.data),chatUpdating:{rendering:false},controller:{rows:[row]}};
  page.setData=patch=>Object.assign(page.data,patch);page.openCommandDetail({currentTarget:{dataset:{key:'t:cmd'}}});
  assert.equal(page.data.sheet,'detail');assert.equal(page.data.detailTitle,'命令详情');assert.equal(page.data.detailKind,'code');
  assert.ok(page.detailText.includes('read README.md'));assert.ok(page.detailText.includes('D:/Fixture/Project'));assert.ok(page.detailText.includes('退出码：1'));
  assert.ok(page.detailText.endsWith('真实末尾'));assert.ok(page.data.detailPages>1);
  page.copyText=text=>assert.ok(text.includes(output));page.copyDetail();
});
test('连续命令、文件和多个思考只产生一个大折叠，思考正文需独立展开', () => {
  for(const status of ['inProgress','completed']) {
    const command=id=>({id,type:'commandExecution',status:'completed',exitCode:0,command:'verify'});
    const reasoning=id=>({id,type:'reasoning',summary:['公开摘要 '+id],content:['private-reasoning']});
    const thread={turns:[{id:'t',status,items:[command('c1'),reasoning('r1'),{id:'f',type:'fileChange',status:'completed',changes},reasoning('r2'),command('c2'),reasoning('r3')]}]};
    const before=JSON.stringify(thread),closed=projectConversation(thread),groups=closed.filter(row=>row.kind==='activityGroup');
    assert.equal(groups.length,1);assert.equal(closed.filter(row=>row.kind==='reasoning').length,0);
    const expanded=projectConversation(thread,new Set(),new Set([groups[0].key]));
    assert.equal(expanded.filter(row=>row.kind==='activityGroup').length,1);assert.equal(expanded.filter(row=>row.kind==='reasoning').length,3);
    const view=conversationWindow(expanded);assert.ok(view.messages.filter(row=>row.kind==='reasoning').every(row=>!row.text&&!row.expanded));
    const inner=conversationWindow(projectConversation(thread,new Set(),new Set([groups[0].key,'t:r2'])));
    assert.equal(inner.messages.find(row=>row.key==='t:r2').text,'公开摘要 r2');assert.equal(inner.messages.find(row=>row.key==='t:r1').text,'');
    assert.equal(JSON.stringify(thread),before);assert.equal(JSON.stringify(inner).includes('private-reasoning'),false);
  }
});
