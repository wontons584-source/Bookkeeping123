/**
 * recommend.test.js —— 智能分类推荐断言脚本（v2 新增，Node 原生 assert）
 *
 * 运行：node test/recommend.test.js
 * 必测内容（增量需求书第八节）：词典命中（商户名/口语词各 ≥5 例）、无命中返回 null、
 * 多词条命中取首个、理由文本含命中词、推荐值与词典配置一致、空字符串/纯符号输入。
 */
'use strict';

const assert = require('assert');
const recommendMod = require('../js/recommend.js');
const recommend = recommendMod.LedgerRecommend || recommendMod;

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}
function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  passed++;
}

// ---------- 1. 词典规模与分类覆盖 ----------
ok(recommend.dictionarySize() >= 40, '词典规模 ≥40 词条（实际 ' + recommend.dictionarySize() + '）');
const categories = new Set(recommend.DICTIONARY.map(function (e) { return e.category; }));
for (const cat of ['餐饮', '交通', '娱乐', '学习', '日用', '其他']) {
  ok(categories.has(cat), '词典覆盖分类：' + cat);
}
ok(recommend.DICTIONARY.every(function (e) {
  return e.tag === '刚性' || e.tag === '冲动';
}), '每个词条都携带 刚性/冲动 标签');

// ---------- 2. 商户名命中（≥5 例） ----------
const merchantCases = [
  ['蜜雪冰城', '餐饮', '冲动'],
  ['瑞幸咖啡', '餐饮', '冲动'],
  ['美团外卖', '餐饮', '冲动'],
  ['滴滴出行', '交通', '刚性'],
  ['星巴克', '餐饮', '冲动']
];
for (const [text, cat, tag] of merchantCases) {
  const r = recommend.recommend(text);
  ok(r !== null, '商户名命中："' + text + '" 出推荐');
  eq(r.category, cat, '"' + text + '" 推荐分类为 ' + cat);
  eq(r.tag, tag, '"' + text + '" 推荐标签为 ' + tag);
}

// ---------- 3. 口语词命中（≥5 例） ----------
const colloquialCases = [
  ['点了一杯奶茶', '餐饮', '冲动'],
  ['中午在食堂吃饭', '餐饮', '刚性'],
  ['打车回学校', '交通', '刚性'],
  ['熬夜吃个宵夜', '餐饮', '冲动'],
  ['打印复习资料', '学习', '刚性'],
  ['取个快递', '日用', '刚性']
];
for (const [text, cat, tag] of colloquialCases) {
  const r = recommend.recommend(text);
  ok(r !== null, '口语词命中："' + text + '" 出推荐');
  eq(r.category, cat, '"' + text + '" 推荐分类为 ' + cat);
}

// ---------- 4. 无命中返回 null ----------
eq(recommend.recommend('xyz123'), null, '英文乱串无命中返回 null');
eq(recommend.recommend(''), null, '空字符串返回 null');
eq(recommend.recommend('   '), null, '纯空格返回 null');
eq(recommend.recommend('!!!@#￥%……'), null, '纯符号返回 null');
eq(recommend.recommend(undefined), null, 'undefined 入参返回 null 不抛异常');
eq(recommend.recommend(123), null, '数字入参返回 null 不抛异常');

// ---------- 5. 多词条命中取词典顺序第一个 ----------
// 奶茶（词典序在前，冲动）先于 食堂（刚性）
let multi = recommend.recommend('食堂旁边的奶茶店');
ok(multi !== null && multi.hit === '奶茶', '多命中取首个："食堂旁边的奶茶店" 命中"奶茶"');
eq(multi.category, '餐饮', '首个命中词条的分类为餐饮');
eq(multi.tag, '冲动', '首个命中词条的标签为冲动（而非食堂的刚性）');
// 打印（学习）先于 纸巾（日用）
multi = recommend.recommend('打印纸巾都买了');
eq(multi.hit, '打印', '多命中取首个："打印纸巾都买了" 命中"打印"');
eq(multi.category, '学习', '"打印"分类为学习（而非纸巾的日用）');
// 蜜雪冰城 先于 地铁
multi = recommend.recommend('蜜雪冰城买完坐地铁');
eq(multi.hit, '蜜雪冰城', '多命中取首个："蜜雪冰城买完坐地铁" 命中"蜜雪冰城"');

// ---------- 6. 理由文本必须包含命中词 ----------
const reasonCases = ['蜜雪冰城', '盲盒', '地铁', '网课', '洗衣液', '火锅'];
for (const text of reasonCases) {
  const r = recommend.recommend(text);
  ok(r !== null && r.reason.indexOf(r.hit) !== -1,
    '理由含命中词："' + text + '" → 理由文本包含"' + r.hit + '"');
}

// ---------- 7. 推荐值与词典配置一致（全量词条逐条核对） ----------
for (const entry of recommend.DICTIONARY) {
  const r = recommend.recommend(entry.word);
  ok(r !== null, '词条自身必命中：' + entry.word);
  eq(r.category, entry.category, '词条 ' + entry.word + ' 推荐分类与词典配置一致');
  eq(r.tag, entry.tag, '词条 ' + entry.word + ' 推荐标签与词典配置一致');
  eq(r.hit, entry.word, '词条 ' + entry.word + ' 命中词为其自身');
}

// ---------- 8. 英文词条大小写不敏感 ----------
const ktv = recommend.recommend('KTV');
ok(ktv !== null && ktv.hit === 'ktv', '"KTV"（大写输入）命中小写词条 ktv（大小写不敏感）');

console.log(passed + ' assertions passed');
