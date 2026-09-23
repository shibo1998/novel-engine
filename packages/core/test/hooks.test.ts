import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHookAnchor, parseHookSpecs, DEFAULT_HOOK_TAIL_CHARS } from '../src/index.js';

test('checkHookAnchor：锚词片段出现在末尾窗口内 → ok', () => {
  const text = '前面很长很长的一段铺垫。' + '垫'.repeat(100) + '“周末，横江武馆，验验成色。”';
  const r = checkHookAnchor(text, ['周末，武馆，验验成色']);
  assert.equal(r.checked, true);
  // 片段匹配：按标点切出 ≥4 码点的子句，"验验成色" 命中（"武馆" 仅 2 字，低于下限被丢弃）
  assert.equal(r.ok, true);
});

test('checkHookAnchor：全是短片段的锚词会被整体丢弃 → 红灯（宁缺勿乱）', () => {
  // 这是刻意的取舍：2 字片段词面噪音太大，容易在任何句子里偶然命中。
  // 丢掉它换来的代价是可能漏报，但比天天假绿安全。
  const r = checkHookAnchor('结尾就是这句：横江武馆。', ['武馆']);
  assert.equal(r.checked, true, '锚词非空 → 仍算检过');
  assert.equal(r.ok, false, '片段全被丢弃 → 无从命中');
});

test('checkHookAnchor：锚词完全不在末尾 → 红灯', () => {
  const text = '结尾是一段与钩子无关的景物描写，冷风灌进走廊。';
  const r = checkHookAnchor(text, ['想让人忘了你爸，就待在榜尾']);
  assert.equal(r.checked, true);
  assert.equal(r.ok, false);
  assert.ok(r.tail.length > 0, '红灯必须回传实际末段，供人眼复核');
});

test('checkHookAnchor：改写措辞仍能命中（不要求整串全等）', () => {
  // 实测中最常见的情形：细纲 "都给我留一份"，正文写成 "都得给我留一份原底"
  const tail = '“你欠我一次。往后你每次体测的数据，都得给我留一份原底。”';
  const text = 'x'.repeat(50) + tail;
  const r = checkHookAnchor(text, ['你欠我一次。往后你每次体测的数据，都给我留一份']);
  assert.equal(r.ok, true, '片段命中即可，细纲与正文的变体差异不该误报');
});

test('checkHookAnchor：窗口按码点算，取的是结尾而非开头', () => {
  const head = '钩子内容出现在很靠前的位置。';
  const body = head + '垫'.repeat(500);
  const r = checkHookAnchor(body, ['钩子内容出现在很靠前的位置']);
  assert.equal(r.ok, false, '超出末尾窗口的内容不算数——钩子必须在章末');
  assert.equal([...r.tail].length, DEFAULT_HOOK_TAIL_CHARS, '窗口长度按码点');
});

test('checkHookAnchor：无锚词 → checked=false 且 ok=true（跳过 ≠ 通过）', () => {
  const r = checkHookAnchor('任意正文', []);
  assert.equal(r.ok, true);
  assert.equal(r.checked, false, 'checked=false 是调用方区分「没标」与「检过」的唯一依据');
  assert.deepEqual(r.hits, {});
});

test('parseHookSpecs：解析真书标注格式（章号 + ｜钩子·型：内容）', () => {
  const outline = [
    '# 第一卷细纲',
    '1 榜尾王座：评级榜更新日｜钩子·对白炸弹：「再信你一次」（正文已定收尾）',
    '5 被盯上：许昂察觉异样｜钩子·新威胁压顶：许昂临走丢下一句「周末，武馆，验验成色」',
    '',
    '## 第二幕',
    '11 仪器惊叹号：全场死寂｜钩子·对白炸弹：赵主任：「这台仪器前天刚校准」',
  ].join('\n');
  const specs = parseHookSpecs(outline);
  assert.equal(specs.length, 3, '只认带 ｜钩子· 标注的章行，标题行/幕标题行不算');
  assert.deepEqual(specs[0]?.anchors, ['再信你一次']);
  assert.equal(specs[0]?.chapterNo, 1);
  assert.equal(specs[1]?.chapterNo, 5);
});

test('parseHookSpecs：人名不进锚词（实测教训：把人名当锚词 = 必然误报）', () => {
  const outline = '26 集训初见：冷面女武师带队｜钩子·执念动作：点名点到「林小满」时她顿了一下';
  const specs = parseHookSpecs(outline);
  // 「林小满」是 3 汉字纯名，应被剔除 → 该章无可判定锚词
  assert.deepEqual(specs[0]?.anchors, [], '人名没有区分度，必须剔除');
});

test('parseHookSpecs：显式 hookAnchors 覆盖自动提炼', () => {
  const outline = '7 面馆夜话：母亲翻出父亲旧物｜钩子·执念动作：她把信放回抽屉 hookAnchors: ["抽屉", "停了一秒"]';
  const specs = parseHookSpecs(outline);
  assert.deepEqual(specs[0]?.anchors, ['抽屉', '停了一秒']);
});

test('parseHookSpecs：无钩子标注的章 → 不产出 spec（宁缺勿乱）', () => {
  const specs = parseHookSpecs('42 世界观翻转：垫底不是因为他弱，是仪器读不出他');
  assert.deepEqual(specs, []);
});

test('parseHookSpecs：细纲是人工文档，畸形行不该抛错', () => {
  const outline = ['不是章行', '5', '5 ', '7 只有章号没有钩子', ''].join('\n');
  assert.doesNotThrow(() => parseHookSpecs(outline));
});
