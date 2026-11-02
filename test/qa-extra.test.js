/**
 * qa-extra.test.js —— QA 独立边界探测（第二层验证，不改动 stats.test.js）
 *
 * 运行：node test/qa-extra.test.js
 * 覆盖工程师主测试未覆盖的边界：
 *   1. 空账户/空账单求和容错、数组元素为 null/undefined 的容错
 *   2. 负数金额入参的容错（stats 层不抛异常，行为可预期）
 *   3. formatYuan 对 1 分 / 99 分 / 负数 / 0 / 非整数分的表现
 *   4. 极大金额（99999999999 分）求和仍落在安全整数范围内且精确
 *   5. getAdvice([]) 返回空数组不抛异常
 *   6. speech.js 纯解析函数在 Node 下可独立运行（金额提取/分类关键词/异常入参）
 *   7. store.js 在无 localStorage 环境（Node）下 loadAll 不崩溃、返回空状态
 */
'use strict';

const assert = require('assert');
const stats = require('../js/stats.js');

let passed = 0;
function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  passed++;
}
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}
function noThrow(fn, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(err === null, msg + (err ? '（实际抛出：' + err.message + '）' : ''));
}

// ---------- 1. 空数组 / 脏元素容错 ----------
eq(stats.sumAmounts([]), 0, '空账单数组求和为 0');
eq(stats.sumAccounts([]), 0, '空账户数组求和为 0');
eq(stats.sumAmounts([null, undefined, {}, { amount_cents: 100 }]), 100,
  'null/undefined/空对象元素被跳过，只累加合法金额');
eq(stats.sumAccounts([null, {}, { balance_cents: 500 }]), 500,
  '账户求和跳过 null/空对象元素');
noThrow(function () { stats.summarizeByCategory([null, undefined]); }, 'summarizeByCategory 对 null 元素不抛异常');

// ---------- 2. 负数金额入参的容错（stats 层行为记录） ----------
// 需求 6.2 规定 amount_cents >= 1，负数应由 store.js normalizeBill 拦截（store.js:77）；
// stats 层不负责拦截，但必须不抛异常、行为可预期（负数按负数累加）。
eq(stats.sumAmounts([{ amount_cents: -500 }, { amount_cents: 800 }]), 300,
  'stats 层负数金额按负数累加，不抛异常（拦截责任在 store 层）');
noThrow(function () { stats.getAdvice([{ amount_cents: -100, category: '餐饮', tag: '冲动' }]); },
  '全负数账单 getAdvice 不抛异常');
eq(stats.getAdvice([{ amount_cents: -100, category: '餐饮', tag: '冲动' }]).length, 0,
  '全负数账单总额 <= 0 时 getAdvice 返回空数组');

// ---------- 3. formatYuan 边界 ----------
eq(stats.formatYuan(1), '0.01', '1 分 → "0.01"');
eq(stats.formatYuan(99), '0.99', '99 分 → "0.99"');
eq(stats.formatYuan(100), '1.00', '100 分 → "1.00"');
eq(stats.formatYuan(0), '0.00', '0 分 → "0.00"');
eq(stats.formatYuan(-5), '-0.05', '负数分 → "-0.05"（展示层行为可预期）');
eq(stats.formatYuan(10.4), '0.10', '非整数分先取整再转元');

// ---------- 4. 极大金额：99999999999 分 ≈ 9.99 亿元 ----------
const BIG = 99999999999; // < Number.MAX_SAFE_INTEGER (9007199254740991)
eq(stats.formatYuan(BIG), '999999999.99', '极大金额单笔展示精确到分');
eq(stats.sumAmounts([{ amount_cents: BIG }, { amount_cents: BIG }]), 199999999998,
  '两笔极大金额整数求和精确无误差');
// 8 万笔 × 99999999999 分 = 7999999999920000 分，仍在 MAX_SAFE_INTEGER 内，求和精确
const manyBig = [];
for (let i = 0; i < 80000; i++) manyBig.push({ amount_cents: BIG });
eq(stats.sumAmounts(manyBig), 80000 * BIG,
  '8 万笔极大金额求和仍在安全整数范围内且精确');
ok(Number.MAX_SAFE_INTEGER >= 80000 * BIG, '8 万笔极大金额之和确在 Number.MAX_SAFE_INTEGER 之下');

// ---------- 5. getAdvice([]) ----------
const emptyAdvice = stats.getAdvice([]);
ok(Array.isArray(emptyAdvice) && emptyAdvice.length === 0, 'getAdvice([]) 返回空数组不抛异常');

// ---------- 6. speech.js 纯解析函数（Node 下独立可跑） ----------
// speech.js / store.js 的 UMD 守卫在浏览器挂 window，在 Node 下挂在 module.exports.Ledger* 属性上
const speechMod = require('../js/speech.js');
const speech = speechMod.LedgerSpeech || speechMod;
const storeMod = require('../js/store.js');
const store = storeMod.LedgerStore || storeMod;
eq(speech.extractAmountYuan('奶茶9块'), 9, '"奶茶9块" 提取金额 9（阿拉伯数字）');
eq(speech.extractAmountYuan('食堂吃饭12.50'), 12.5, '支持两位小数金额提取');
eq(speech.extractAmountYuan('奶茶九块'), null, '纯中文数字"九块"解析不出金额（已在代码注释声明本期范围外）');
eq(speech.extractAmountYuan('没有数字'), null, '无数字文本返回 null');
eq(speech.extractAmountYuan(undefined), null, '非字符串入参返回 null 不抛异常');
eq(speech.matchCategory('点了一杯奶茶'), '餐饮', '关键词命中分类：奶茶→餐饮');
eq(speech.matchCategory('打车回学校'), '交通', '关键词命中分类：打车→交通');
eq(speech.matchCategory('买了个盲盒'), '娱乐', '关键词命中分类：盲盒→娱乐');
eq(speech.matchCategory('随便说说'), null, '无关键词命中返回 null');
noThrow(function () { speech.parseTranscript(undefined); speech.parseTranscript(123); },
  'parseTranscript 对非法入参不抛异常');
const parsed = speech.parseTranscript('奶茶9块');
eq(parsed.amount_yuan, 9, 'parseTranscript 返回金额');
eq(parsed.category, '餐饮', 'parseTranscript 返回分类');
eq(parsed.note, '奶茶9块', 'parseTranscript 备注为原始识别文本');
ok(!('amount_cents' in parsed) && !('bills' in parsed),
  'parseTranscript 返回结构中无任何落库字段（T6：只预填，绝不产生账单）');

// ---------- 7. store.js 在无 localStorage 环境（Node）下的健壮性 ----------
let loaded = null;
noThrow(function () { loaded = store.loadAll(); }, '无 localStorage 环境 loadAll 不崩溃');
ok(loaded && Array.isArray(loaded.bills) && Array.isArray(loaded.accounts) &&
   loaded.bills.length === 0 && loaded.accounts.length === 0,
  '无 localStorage 环境下 loadAll 兜底返回空状态');
eq(store.saveBills([{ id: 'x' }]), false, '无 localStorage 环境 saveBills 返回 false（配额/写入失败同路径）');

console.log(passed + ' assertions passed');
