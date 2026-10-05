const test = require('node:test');
const assert = require('node:assert/strict');
const {linkTarget, fileTarget, documentPages} = require('../mini_program/utils/codex/document');

test('Markdown 文件链接只接受项目文件或允许复制的外部地址', () => {
  assert.deepEqual(linkTarget('docs/readme.md#intro'), {target: 'docs/readme.md', external: false});
  assert.deepEqual(linkTarget('C:/Fixture/readme.md:12:4'), {target: 'C:/Fixture/readme.md', external: false});
  assert.deepEqual(linkTarget('https://example.com/a.md'), {target: 'https://example.com/a.md', external: true});
  assert.equal(linkTarget('javascript:alert(1)'), null);
  assert.equal(linkTarget('\\\\server\\share\\secret.md'), null);
  assert.deepEqual(fileTarget('next.md', 'docs/guide.md'), {target: 'docs/next.md', external: false});
  assert.deepEqual(fileTarget('C:/Fixture/readme.md', 'docs/guide.md'), {target: 'C:/Fixture/readme.md', external: false});
});

test('Markdown 文档按原生可点击链接、标题、列表、表格和代码块分块', () => {
  const pages = documentPages('# 文档标题\n\n- [入口](README.md)\n\n|列|值|\n|---|---|\n|A|B|\n\n```js\nconst ok = true;\n```');
  assert.equal(pages.length, 1);
  const kinds = pages[0].blocks.map(block => block.kind);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'list', 'paragraph', 'table', 'paragraph', 'code']);
  assert.deepEqual(pages[0].blocks[2].rows[0].parts.find(part => part.kind === 'link'), {text: '入口', kind: 'link', target: 'README.md'});
  assert.equal(pages[0].blocks.at(-1).text, 'const ok = true;');
  const source = '文档😀'.repeat(12000), longPages = documentPages('```text\n' + source + '\n```');
  assert.ok(longPages.length > 1);
  assert.equal(longPages.flatMap(page => page.blocks).map(block => block.text).join(''), source);
});

test('小程序页面点击项目 Markdown 链接后打开渲染详情', async () => {
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[require.resolve('../mini_program/pages/codex/codex')];
  require('../mini_program/pages/codex/codex');
  delete global.Page;
  const page = {...definition, data: structuredClone(definition.data), visible: true, setData(patch) { Object.assign(this.data, patch); }};
  const controller = {key: 'chat', epoch: 1, selection: 2, ready: true, current: {cwd: 'C:/Fixture/Project'}, resources: {state: {}, async open(cwd, path) { this.state = {cwd, selected: {path, content: '# 预览文档\n\n[继续](README.md)'}, error: ''}; }}, notify() {}};
  page.controller = controller;
  await page.openLink({currentTarget: {dataset: {target: 'docs/readme.md'}}});
  assert.equal(page.data.detailKind, 'document');
  assert.equal(page.data.detailTitle, 'docs/readme.md');
  assert.equal(page.data.detailBlocks[0].kind, 'heading');
  assert.ok(page.data.detailBlocks.some(block => block.parts && block.parts.some(part => part.kind === 'link')));
  let copied;
  page.copyText = text => { copied = text; };
  page.copyDetail();
  assert.equal(copied, '# 预览文档\n\n[继续](README.md)');
  await page.openLink({currentTarget: {dataset: {target: 'next.md', base: page.data.detailTitle}}});
  assert.equal(page.data.detailTitle, 'docs/next.md');
  let zipPath;
  page.openFiles = event => { zipPath = event.currentTarget.dataset.path; };
  await page.openLink({currentTarget: {dataset: {target: 'windows/out/package.zip'}}});
  assert.equal(zipPath, 'windows/out/package.zip');
  let complete;
  controller.resources.open = async () => { await new Promise(resolve => { complete = resolve; }); };
  const pending = page.openLink({currentTarget: {dataset: {target: 'late.md'}}});
  controller.selection++;
  complete();
  await pending;
  assert.equal(page.data.detailTitle, 'docs/next.md', '切换会话后过期文件读取不覆盖详情');
});
