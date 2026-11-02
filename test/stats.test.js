/**
 * stats.test.js —— Node 原生 assert 断言脚本（不引入测试框架）
 *
 * 运行：node test/stats.test.js
 * 直接 require UMD 导出的 js/stats.js（见需求书 8.1）。
 * 必测边界：金额 0.01 元（最小分）、空账单列表、全部冲动标签、未知分类容错、
 * 账户求和含 0 余额账户；另补：当月过滤边界、分精度、上月月份前缀、环比变化率。
 * v2 变更：v1 固定建议规则（getAdvice）整体废弃 → 对应死用例删除，
 * 其"冲动占比阈值判定"等能力由 test/insights.test.js 的洞察引擎用例承接。
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

// ---------- 8. 枚举与常量导出完整性 ----------
eq(stats.CATEGORIES.length, 6, '分类枚举共 6 值');
eq(stats.TAGS.length, 2, '标签枚举共 2 值');
eq(typeof stats.getAdvice, 'undefined', 'v1 固定建议规则 getAdvice 已整体移除（由洞察引擎替代）');

// ---------- 9. 上月月份前缀（v2 新增：环比对比所需）----------
eq(stats.previousMonthPrefix(NOW), '2026-09', '上月月份前缀计算正确');
eq(stats.previousMonthPrefix(new Date(2026, 0, 15)), '2025-12', '1 月的上月正确回退到上一年 12 月');
eq(stats.previousMonthPrefix(new Date(2026, 2, 1)), '2026-02', '3 月的上月为 2 月');
eq(stats.previousMonthPrefix(new Date(2025, 11, 31)), '2025-11', '12 月的上月为 11 月（同年）');

// ---------- 10. 环比变化率（v2 新增：洞察引擎对比类所需）----------
eq(stats.momChangeRatio(200, 100), 1, '环比变化率 200 vs 100 = +100%');
eq(stats.momChangeRatio(100, 200), 0.5, '环比变化率 100 vs 200 = 50%（取绝对值）');
eq(stats.momChangeRatio(100, 100), 0, '金额持平环比变化率为 0');
eq(stats.momChangeRatio(100, 0), 0, '上期为 0 无法比较，返回 0（不抛异常）');
eq(stats.momChangeRatio(0, 100), 1, '本期为 0、上期 100 → 降幅 100%');

console.log(passed + ' assertions passed');
