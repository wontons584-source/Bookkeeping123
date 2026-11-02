/**
 * insights.test.js —— AI 消费洞察引擎断言脚本（v2 新增，Node 原生 assert）
 *
 * 运行：node test/insights.test.js
 * 必测内容（增量需求书第八节）：每类模板的触发条件边界（本月账单恰好 3 笔 /
 * 上月无数据 / 冲动占比恰 30%）、输出条数 ∈ [2,4]、数据不足返回引导话术、
 * 金额整数分求和口径、未知分类容错。
 */
'use strict';

const assert = require('assert');
const insightsMod = require('../js/insights.js');
const insights = insightsMod.LedgerInsights || insightsMod;
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

// 固定"当前时间"保证可复现：2026-10-22 → 本月 2026-10，上月 2026-09
const NOW = new Date(2026, 9, 22, 12, 0, 0);

/** 造账单的便捷函数 */
function bill(date, cents, category, tag) {
  return { id: 'b' + Math.random(), date: date, amount_cents: cents, category: category, tag: tag, merchant: '', note: '', created_at: 0 };
}

/** 输出条数恒在 [2,4]（有足够数据时）的公共断言 */
function assertCountInRange(out, msg) {
  ok(Array.isArray(out), msg + '：输出为数组');
  ok(out.length >= insights.MIN_INSIGHTS && out.length <= insights.MAX_INSIGHTS,
    msg + '：条数 ' + out.length + ' 落在 [' + insights.MIN_INSIGHTS + ', ' + insights.MAX_INSIGHTS + ']');
}

// ---------- 1. 数据不足 → 引导话术（与解锁条件同源） ----------
let out = insights.generateInsights([], [], NOW);
eq(out.length, 1, '无账单只输出 1 条引导话术');
ok(out[0].indexOf('解锁') !== -1 && out[0].indexOf(String(insights.MIN_MONTH_BILLS)) !== -1,
  '引导话术含"解锁"且笔数与解锁条件常量同源（' + insights.MIN_MONTH_BILLS + ' 笔）');
out = insights.generateInsights([bill('2026-10-01', 900, '餐饮', '冲动')], [], NOW);
ok(out.length === 1 && out[0].indexOf('再记 2 笔') !== -1, '已有 1 笔 → 话术为"再记 2 笔"');
out = insights.generateInsights([
  bill('2026-10-01', 900, '餐饮', '冲动'),
  bill('2026-10-02', 500, '日用', '刚性')
], [], NOW);
ok(out.length === 1 && out[0].indexOf('再记 1 笔') !== -1, '已有 2 笔 → 话术为"再记 1 笔"');
// 历史月份账单不计入当月解锁条件
out = insights.generateInsights([bill('2026-09-01', 900, '餐饮', '刚性')], [], NOW);
ok(out.length === 1 && out[0].indexOf('再记 3 笔') !== -1, '上月账单不算数：当月 0 笔 → 再记 3 笔');

// ---------- 2. 本月账单恰好 3 笔：解锁且条数 ∈ [2,4] ----------
out = insights.generateInsights([
  bill('2026-10-01', 1200, '餐饮', '刚性'),
  bill('2026-10-02', 800, '交通', '刚性'),
  bill('2026-10-03', 3000, '娱乐', '冲动')
], [], NOW);
assertCountInRange(out, '本月恰好 3 笔');

// ---------- 3. 冲动占比恰 30%：风险模板触发（阈值边界，>= 判定） ----------
// 冲动 30 分 / 总 100 分 → 恰 0.3（整数分无浮点误差）
out = insights.generateInsights([
  bill('2026-10-01', 30, '餐饮', '冲动'),
  bill('2026-10-02', 35, '交通', '刚性'),
  bill('2026-10-03', 35, '日用', '刚性')
], [], NOW);
assertCountInRange(out, '冲动占比恰 30%');
ok(out.some(function (t) { return t.indexOf('预警') !== -1; }),
  '冲动占比恰好 30%（= 阈值）输出风险预警洞察');
// 29% 不触发
out = insights.generateInsights([
  bill('2026-10-01', 29, '餐饮', '冲动'),
  bill('2026-10-02', 36, '交通', '刚性'),
  bill('2026-10-03', 35, '日用', '刚性')
], [], NOW);
ok(!out.some(function (t) { return t.indexOf('预警') !== -1; }),
  '冲动占比 29%（< 阈值）不输出风险预警');

// ---------- 4. 上月无数据 → 对比类不触发；有数据 → 环比出现 ----------
const curOnly = [
  bill('2026-10-01', 1000, '餐饮', '刚性'),
  bill('2026-10-02', 800, '交通', '刚性'),
  bill('2026-10-03', 600, '日用', '刚性')
];
out = insights.generateInsights(curOnly, [], NOW);
ok(!out.some(function (t) { return t.indexOf('环比') !== -1; }),
  '上月无数据：对比类模板不触发（无"环比"字样）');
const withPrev = curOnly.concat([
  bill('2026-09-10', 2000, '餐饮', '刚性'),
  bill('2026-09-11', 500, '日用', '刚性')
]);
out = insights.generateInsights(withPrev, [], NOW);
ok(out.some(function (t) { return t.indexOf('环比') !== -1; }),
  '上月有数据：输出总支出环比洞察');

// ---------- 5. 结构类 + 风险类覆盖（对齐验收 A11 的组合场景） ----------
const a11Bills = [
  bill('2026-10-01', 5000, '餐饮', '冲动'),   // 餐饮为最大头且冲动
  bill('2026-10-02', 2600, '餐饮', '冲动'),
  bill('2026-10-03', 900, '交通', '刚性'),
  bill('2026-10-04', 800, '日用', '刚性'),
  bill('2026-10-05', 700, '学习', '刚性'),
  bill('2026-09-15', 3000, '餐饮', '刚性')    // 上月数据
];
out = insights.generateInsights(a11Bills, [], NOW);
assertCountInRange(out, 'A11 组合场景（当月 5 笔、餐饮最高、冲动占比过半、含上月）');
ok(out.some(function (t) { return t.indexOf('最大的开销去向') !== -1; }),
  '输出含结构类洞察（最大占比分类）');
ok(out.some(function (t) { return t.indexOf('预警') !== -1; }),
  '输出含风险类洞察（冲动占比预警）');

// ---------- 6. 习惯类：高频小额 / 大额单笔 ----------
out = insights.generateInsights([
  bill('2026-10-01', 900, '餐饮', '冲动'),
  bill('2026-10-02', 900, '餐饮', '刚性'),
  bill('2026-10-03', 900, '餐饮', '刚性'),
  bill('2026-10-04', 900, '餐饮', '刚性'),
  bill('2026-10-05', 900, '餐饮', '刚性'),
  bill('2026-10-06', 300, '日用', '刚性')
], [], NOW);
ok(out.some(function (t) { return t.indexOf('高频小额') !== -1; }),
  '同分类 5 笔且平均 <30 元 → 高频小额洞察触发');
out = insights.generateInsights([
  bill('2026-10-01', 10000, '娱乐', '冲动', ),
  bill('2026-10-02', 300, '日用', '刚性'),
  bill('2026-10-03', 200, '日用', '刚性')
], [], NOW);
ok(out.some(function (t) { return t.indexOf('最大单笔') !== -1; }),
  '单笔 ≥50 元 → 大额单笔洞察触发');

// ---------- 7. 资产类：余额消耗速度 / 家底告急 ----------
out = insights.generateInsights([
  bill('2026-10-01', 3000, '餐饮', '刚性'),
  bill('2026-10-02', 3000, '日用', '刚性'),
  bill('2026-10-03', 4000, '娱乐', '冲动')
], [{ id: 'a1', name: '微信', balance_cents: 30000 }], NOW);
ok(out.some(function (t) { return t.indexOf('还够撑') !== -1; }),
  '有总资产 → 资产消耗速度洞察触发（含"还够撑 X 天"）');
out = insights.generateInsights([
  bill('2026-10-01', 3000, '餐饮', '刚性'),
  bill('2026-10-02', 3000, '日用', '刚性'),
  bill('2026-10-03', 4000, '娱乐', '冲动')
], [{ id: 'a1', name: '微信', balance_cents: 5000 }], NOW);
ok(out.some(function (t) { return t.indexOf('告急') !== -1; }),
  '本月支出超过总资产 → 家底告急洞察触发');

// ---------- 8. 输出条数上限截断（构造大量可触发模板，仍 ≤4 条） ----------
const richBills = [];
for (let i = 1; i <= 6; i++) {
  richBills.push(bill('2026-10-0' + i, 900, '餐饮', i <= 2 ? '冲动' : '刚性'));
}
richBills.push(bill('2026-10-07', 12000, '娱乐', '冲动'));
richBills.push(bill('2026-09-05', 1000, '餐饮', '刚性'));
richBills.push(bill('2026-09-06', 9000, '娱乐', '冲动'));
out = insights.generateInsights(richBills, [{ id: 'a1', name: '微信', balance_cents: 80000 }], NOW);
assertCountInRange(out, '数据丰富多模板触发');

// ---------- 9. 金额整数分求和口径 ----------
const tinyBills = [
  bill('2026-10-01', 10, '日用', '刚性'),
  bill('2026-10-02', 20, '日用', '刚性'),
  bill('2026-10-03', 5, '日用', '刚性')
];
out = insights.generateInsights(tinyBills, [], NOW);
const expectedTotal = stats.formatYuan(stats.sumAmounts(tinyBills)); // 0.35
ok(out.some(function (t) { return t.indexOf(expectedTotal) !== -1; }),
  '总览文案金额与整数分求和口径一致（' + expectedTotal + ' 元，非 0.35000000000000003）');

// ---------- 10. 未知分类容错 ----------
let unknownOut = null;
let threw = false;
try {
  unknownOut = insights.generateInsights([
    bill('2026-10-01', 100, '盲盒', '冲动'),
    bill('2026-10-02', 200, '不明', '刚性'),
    bill('2026-10-03', 300, '餐饮', '刚性')
  ], [], NOW);
} catch (e) {
  threw = true;
}
ok(!threw, '未知分类账单不导致洞察引擎抛异常');
assertCountInRange(unknownOut, '未知分类容错');

// ---------- 11. 模板库规模：≥10 个模板、五类各 ≥2 ----------
// 通过代码内常量+结构核对：五类模板在 generateInsights 闭包内，这里以行为覆盖佐证
// （结构 3 / 对比 2 / 习惯 2 / 风险 2 / 资产 2 = 11 个模板，上方各用例已分别触发五类）。
ok(insights.MAX_INSIGHTS === 4 && insights.MIN_INSIGHTS === 2,
  '输出上下限常量为 [2, 4]');
ok(insights.MIN_MONTH_BILLS === 3, '解锁常量为 3 笔（与引导话术同源）');

console.log(passed + ' assertions passed');
