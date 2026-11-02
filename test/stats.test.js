/**
 * stats.test.js —— Node 原生 assert 断言脚本（不引入测试框架）
 *
 * 运行：node test/stats.test.js
 * 直接 require UMD 导出的 js/stats.js（见需求书 8.1）。
 * 必测边界：金额 0.01 元（最小分）、空账单列表、全部冲动标签、未知分类容错、
 * 账户求和含 0 余额账户；另补：当月过滤边界、分精度、建议阈值两侧。
 */
'use strict';

const assert = require('assert');
const stats = require('../js/stats.js');

let passed = 0;

function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  passed++;
}

// 固定"当前时间"保证测试可复现：2026-10-22（本地时区）
const NOW = new Date(2026, 9, 22, 12, 0, 0);

// ---------- 1. 空账单列表 ----------
eq(stats.sumAmounts([]), 0, '空账单列表总额为 0');
eq(stats.computeRatios([]).total_cents, 0, '空账单列表 computeRatios 总额为 0');
eq(stats.computeRatios([]).impulsive_ratio, 0, '空账单列表冲动占比为 0');
eq(stats.getAdvice([]).length, 0, '空账单列表不输出任何建议');
eq(stats.sumAccounts([]), 0, '空账户列表总资产为 0');

// ---------- 2. 金额 0.01 元（最小分）----------
const minBills = [
  { id: 'b1', date: '2026-10-01', amount_cents: 1, category: '其他', tag: '刚性', note: '', created_at: 1 }
];
eq(stats.sumAmounts(minBills), 1, '最小金额 0.01 元 = 1 分');
eq(stats.formatYuan(1), '0.01', '1 分展示为 "0.01"');
eq(stats.computeRatios(minBills).by_category['其他'].ratio, 1, '单笔最小金额分类占比为 1');

// ---------- 3. 全部账单都是冲动标签 ----------
const allImpulsive = [
  { id: 'b1', date: '2026-10-01', amount_cents: 25, category: '交通', tag: '冲动', note: '', created_at: 1 },
  { id: 'b2', date: '2026-10-02', amount_cents: 25, category: '日用', tag: '冲动', note: '', created_at: 2 },
  { id: 'b3', date: '2026-10-03', amount_cents: 25, category: '其他', tag: '冲动', note: '', created_at: 3 },
  { id: 'b4', date: '2026-10-04', amount_cents: 25, category: '交通', tag: '冲动', note: '', created_at: 4 }
];
const impRatios = stats.computeRatios(allImpulsive);
eq(impRatios.impulsive_ratio, 1, '全部冲动标签时冲动占比为 1');
eq(impRatios.impulsive_cents, 100, '全部冲动标签时冲动金额为 100 分');
const impAdvice = stats.getAdvice(allImpulsive);
ok(impAdvice.length >= 1 && impAdvice[0].indexOf('冲动') !== -1, '全部冲动标签输出含"冲动"的建议');

// ---------- 4. 含未知分类值的容错 ----------
const unknownCatBills = [
  { id: 'b1', date: '2026-10-01', amount_cents: 100, category: '盲盒', tag: '刚性', note: '', created_at: 1 },
  { id: 'b2', date: '2026-10-02', amount_cents: 50, category: '餐饮', tag: '冲动', note: '', created_at: 2 }
];
const unknownSums = stats.summarizeByCategory(unknownCatBills);
eq(unknownSums['其他'], 100, '未知分类"盲盒"容错归入"其他"');
eq(unknownSums['餐饮'], 50, '已知分类正常汇总');
eq(stats.sumAmounts(unknownCatBills), 150, '未知分类金额不丢，总额 150 分');
const unknownRatios = stats.computeRatios(unknownCatBills);
eq(unknownRatios.total_cents, 150, '未知分类不导致 computeRatios 总额错误');
ok(Array.isArray(stats.getAdvice(unknownCatBills)), '未知分类不导致建议函数报错');
// 未知分类账单 tag 异常时也不崩（tag 非冲动 → 不计入冲动金额）
const weirdTag = [{ id: 'b1', date: '2026-10-01', amount_cents: 10, category: '餐饮', tag: '未知标签', created_at: 1 }];
eq(stats.computeRatios(weirdTag).impulsive_cents, 0, '未知 tag 值容错：不计入冲动金额');

// ---------- 5. 账户余额求和（含 0 余额账户）----------
eq(stats.sumAccounts([
  { id: 'a1', name: '微信', balance_cents: 32000 },
  { id: 'a2', name: '支付宝', balance_cents: 18000 },
  { id: 'a3', name: '现金', balance_cents: 0 }
]), 50000, '三个账户含 0 余额求和 = 50000 分 = 500.00 元');
eq(stats.formatYuan(stats.sumAccounts([
  { balance_cents: 10050 }, { balance_cents: 20000 }
])), '300.50', '100.50 + 200.00 元整数分求和转元 = "300.50"（验收第 5 条）');

// ---------- 6. 当月过滤边界（上月/下月账单不进统计）----------
eq(stats.currentMonthPrefix(NOW), '2026-10', '当前月份前缀计算正确');
const mixedMonths = [
  { id: 'b1', date: '2026-09-30', amount_cents: 999, category: '餐饮', tag: '刚性', created_at: 1 }, // 上月最后一天
  { id: 'b2', date: '2026-10-01', amount_cents: 10, category: '餐饮', tag: '刚性', created_at: 2 },  // 本月第一天
  { id: 'b3', date: '2026-10-31', amount_cents: 20, category: '娱乐', tag: '冲动', created_at: 3 },  // 本月最后一天
  { id: 'b4', date: '2026-11-01', amount_cents: 888, category: '餐饮', tag: '刚性', created_at: 4 }  // 下月第一天
];
const monthBills = stats.filterByCurrentMonth(mixedMonths, NOW);
eq(monthBills.length, 2, '当月过滤只保留本月两条');
eq(stats.sumAmounts(monthBills), 30, '上月/下月账单金额不进本月统计');
eq(stats.filterByMonth(mixedMonths, '2026-09').length, 1, '指定月份过滤可用');

// ---------- 7. 分精度：0.10 + 0.20 → 30 分 → "0.30"（验收第 7 条）----------
const tinyBills = [
  { id: 'b1', date: '2026-10-01', amount_cents: 10, category: '日用', tag: '刚性', created_at: 1 },
  { id: 'b2', date: '2026-10-02', amount_cents: 20, category: '日用', tag: '刚性', created_at: 2 }
];
eq(stats.sumAmounts(tinyBills), 30, '整数分求和 10 + 20 = 30 分（无浮点误差）');
eq(stats.formatYuan(stats.sumAmounts(tinyBills)), '0.30', '30 分展示为 "0.30" 而非 0.30000000000000004');

// ---------- 8. 冲动阈值两侧：0.40 命中 / 0.39 未命中 ----------
// 总额恒为 100 分，冲动金额分别取 40 / 39（分类避开餐饮、娱乐，排除其他规则干扰）
const impHit = [
  { amount_cents: 40, category: '交通', tag: '冲动', date: '2026-10-01' },
  { amount_cents: 30, category: '日用', tag: '刚性', date: '2026-10-02' },
  { amount_cents: 30, category: '其他', tag: '刚性', date: '2026-10-03' }
];
const impMiss = [
  { amount_cents: 39, category: '交通', tag: '冲动', date: '2026-10-01' },
  { amount_cents: 31, category: '日用', tag: '刚性', date: '2026-10-02' },
  { amount_cents: 30, category: '其他', tag: '刚性', date: '2026-10-03' }
];
ok(stats.getAdvice(impHit).some(function (a) { return a.indexOf('冲动') !== -1; }),
  '冲动占比恰好 40%（= 阈值）输出冲动建议');
ok(!stats.getAdvice(impMiss).some(function (a) { return a.indexOf('冲动') !== -1; }),
  '冲动占比 39%（< 阈值）不输出冲动建议');

// ---------- 9. 餐饮阈值两侧：0.50 命中 / 0.49 未命中 ----------
const foodHit = [
  { amount_cents: 50, category: '餐饮', tag: '刚性', date: '2026-10-01' },
  { amount_cents: 50, category: '交通', tag: '刚性', date: '2026-10-02' }
];
const foodMiss = [
  { amount_cents: 49, category: '餐饮', tag: '刚性', date: '2026-10-01' },
  { amount_cents: 51, category: '交通', tag: '刚性', date: '2026-10-02' }
];
ok(stats.getAdvice(foodHit).some(function (a) { return a.indexOf('餐饮') !== -1; }),
  '餐饮占比恰好 50%（= 阈值）输出餐饮建议');
ok(!stats.getAdvice(foodMiss).some(function (a) { return a.indexOf('餐饮') !== -1; }),
  '餐饮占比 49%（< 阈值）不输出餐饮建议');

// ---------- 10. 娱乐阈值两侧：0.25 命中 / 0.24 未命中 ----------
const funHit = [
  { amount_cents: 25, category: '娱乐', tag: '刚性', date: '2026-10-01' },
  { amount_cents: 75, category: '交通', tag: '刚性', date: '2026-10-02' }
];
const funMiss = [
  { amount_cents: 24, category: '娱乐', tag: '刚性', date: '2026-10-01' },
  { amount_cents: 76, category: '交通', tag: '刚性', date: '2026-10-02' }
];
ok(stats.getAdvice(funHit).some(function (a) { return a.indexOf('娱乐') !== -1; }),
  '娱乐占比恰好 25%（= 阈值）输出娱乐建议');
ok(!stats.getAdvice(funMiss).some(function (a) { return a.indexOf('娱乐') !== -1; }),
  '娱乐占比 24%（< 阈值）不输出娱乐建议');

// ---------- 11. 一条不命中 → 均衡话术 ----------
const balancedBills = [
  { amount_cents: 40, category: '餐饮', tag: '刚性', date: '2026-10-01' },
  { amount_cents: 30, category: '交通', tag: '刚性', date: '2026-10-02' },
  { amount_cents: 30, category: '日用', tag: '刚性', date: '2026-10-03' }
];
const balAdvice = stats.getAdvice(balancedBills);
eq(balAdvice.length, 1, '无规则命中时只输出一条话术');
ok(balAdvice[0].indexOf('均衡') !== -1, '无规则命中时输出"消费结构均衡"话术');

// ---------- 12. 多规则同时命中 → 按优先级输出多条 ----------
// 餐饮 50 分（冲动 40 + 刚性 10）+ 日用 50 分：冲动占比 0.4、餐饮占比 0.5 同时命中
const multiHit = [
  { amount_cents: 40, category: '餐饮', tag: '冲动', date: '2026-10-01' },
  { amount_cents: 10, category: '餐饮', tag: '刚性', date: '2026-10-02' },
  { amount_cents: 50, category: '日用', tag: '刚性', date: '2026-10-03' }
];
const multiAdvice = stats.getAdvice(multiHit);
eq(multiAdvice.length, 2, '两条规则命中时输出两条建议');
ok(multiAdvice[0].indexOf('冲动') !== -1, '优先级 1：冲动建议在前');
ok(multiAdvice[1].indexOf('餐饮') !== -1, '优先级 2：餐饮建议在后');

// ---------- 13. 常量导出与枚举完整性 ----------
eq(stats.CATEGORIES.length, 6, '分类枚举共 6 值');
eq(stats.TAGS.length, 2, '标签枚举共 2 值');
eq(stats.IMPULSIVE_RATIO_THRESHOLD, 0.4, '冲动阈值为命名常量 0.4');
eq(stats.FOOD_RATIO_THRESHOLD, 0.5, '餐饮阈值为命名常量 0.5');
eq(stats.FUN_RATIO_THRESHOLD, 0.25, '娱乐阈值为命名常量 0.25');

console.log(passed + ' assertions passed');
