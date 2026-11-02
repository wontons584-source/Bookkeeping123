/**
 * stats.js —— 统计计算与建议规则（纯函数模块）
 *
 * 设计约束（需求书 5.2）：
 * - 不碰 DOM、不碰 localStorage，输入数据、输出结果
 * - UMD 双环境守卫：浏览器挂到 window.LedgerStats；Node 通过 module.exports 供测试 require
 * - 金额一律以"分"为单位的整数（*_cents），求和先整数相加、展示时再转元
 * - 枚举常量统一定义在此，全项目禁止散落魔法字符串
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LedgerStats = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 支出分类枚举（钉死 6 值，见需求书 6.2） */
  var CATEGORIES = ['餐饮', '交通', '学习', '娱乐', '日用', '其他'];

  /** 消费标签枚举（2 值，由用户录入时主动选择，系统不自动判定） */
  var TAGS = ['刚性', '冲动'];
  var TAG_RIGID = '刚性';
  var TAG_IMPULSIVE = '冲动';

  /** 建议规则阈值（命名常量，规则与文案一一对应，测试直接引用） */
  var IMPULSIVE_RATIO_THRESHOLD = 0.4;  // 冲动消费占比 ≥ 40% → 冲动类建议
  var FOOD_RATIO_THRESHOLD = 0.5;       // 餐饮占比 ≥ 50% → 餐饮类建议
  var FUN_RATIO_THRESHOLD = 0.25;       // 娱乐占比 ≥ 25% → 娱乐类建议

  var ADVICE_BALANCED = '本月消费结构均衡，各类开销都在合理范围内，继续保持理性消费的好习惯。';
  var ADVICE_IMPULSIVE = '冲动消费占比 {pct}%（阈值 40%），本月花钱容易上头：奶茶、网购这类"想要"的开销砍一半，省下的钱够吃一周食堂。';
  var ADVICE_FOOD = '餐饮占比 {pct}%（阈值 50%），吃饭花得偏多：多在食堂吃、少点外卖，把每周下馆子的次数减一次。';
  var ADVICE_FUN = '娱乐占比 {pct}%（阈值 25%），娱乐开销偏高：给娱乐设一个每周上限，先把学习和日用保障好。';

  /** 数字补两位，用于 YYYY-MM 拼接 */
  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /**
   * 求和：整数分相加（先加总、后转元），规避浮点精度问题（验收第 7 条）
   * @param {Array<{amount_cents:number}>} bills
   * @returns {number} 总额（分）
   */
  function sumAmounts(bills) {
    var total = 0;
    var i;
    for (i = 0; i < bills.length; i++) {
      var c = bills[i] && bills[i].amount_cents;
      if (typeof c === 'number' && isFinite(c)) {
        total += Math.round(c);
      }
    }
    return total;
  }

  /**
   * 按 YYYY-MM 过滤账单（统计范围已拍板 A1：当前自然月）
   * @param {Array} bills
   * @param {string} ymPrefix 形如 "2026-10"
   * @returns {Array} date 的 YYYY-MM 等于 ymPrefix 的账单
   */
  function filterByMonth(bills, ymPrefix) {
    var result = [];
    var i;
    for (i = 0; i < bills.length; i++) {
      var d = bills[i] && bills[i].date;
      if (typeof d === 'string' && d.slice(0, 7) === ymPrefix) {
        result.push(bills[i]);
      }
    }
    return result;
  }

  /**
   * 由 Date 对象计算 "YYYY-MM" 前缀（本地时区）
   * @param {Date} now
   * @returns {string}
   */
  function currentMonthPrefix(now) {
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1);
  }

  /**
   * 过滤出当前自然月账单（所有统计共用同一口径，见需求书 3.4"统计范围"）
   * @param {Array} bills
   * @param {Date} now 系统当前时间（参数注入以便测试）
   * @returns {Array}
   */
  function filterByCurrentMonth(bills, now) {
    return filterByMonth(bills, currentMonthPrefix(now));
  }

  /**
   * 按分类汇总（分）。未知分类值容错：归入"其他"，不报错、不丢金额（8.1 必测项）
   * @param {Array} bills
   * @returns {Object<string,number>} 6 个分类键 → 金额（分）
   */
  function summarizeByCategory(bills) {
    var sums = {};
    var i;
    for (i = 0; i < CATEGORIES.length; i++) {
      sums[CATEGORIES[i]] = 0;
    }
    for (i = 0; i < bills.length; i++) {
      var bill = bills[i];
      var c = bill && bill.amount_cents;
      if (typeof c !== 'number' || !isFinite(c)) {
        continue;
      }
      var cat = bill.category;
      if (CATEGORIES.indexOf(cat) === -1) {
        cat = '其他';
      }
      sums[cat] += Math.round(c);
    }
    return sums;
  }

  /**
   * 计算占比（含总额、分类占比、冲动金额与占比）
   * @param {Array} bills
   * @returns {{total_cents:number, by_category:Object, impulsive_cents:number, impulsive_ratio:number}}
   */
  function computeRatios(bills) {
    var total = sumAmounts(bills);
    var sums = summarizeByCategory(bills);
    var byCategory = {};
    var i;
    for (i = 0; i < CATEGORIES.length; i++) {
      var cat = CATEGORIES[i];
      byCategory[cat] = {
        cents: sums[cat],
        ratio: total > 0 ? sums[cat] / total : 0
      };
    }
    var impulsive = 0;
    for (i = 0; i < bills.length; i++) {
      var bill = bills[i];
      var c = bill && bill.amount_cents;
      if (bill && bill.tag === TAG_IMPULSIVE && typeof c === 'number' && isFinite(c)) {
        impulsive += Math.round(c);
      }
    }
    return {
      total_cents: total,
      by_category: byCategory,
      impulsive_cents: impulsive,
      impulsive_ratio: total > 0 ? impulsive / total : 0
    };
  }

  /**
   * 分转元展示字符串（如 30 → "0.30"）
   * @param {number} cents
   * @returns {string}
   */
  function formatYuan(cents) {
    return (Math.round(cents) / 100).toFixed(2);
  }

  /**
   * 消费分析与省钱建议（核心作业点，规则全部写死、阈值用命名常量）
   * 多条规则同时命中时按优先级输出多条：冲动 > 餐饮 > 娱乐；
   * 一条都不命中时输出均衡话术；无账单（总额为 0）时输出空数组。
   * @param {Array} bills （调用方保证已按当月过滤）
   * @returns {string[]} 建议文案列表
   */
  function getAdvice(bills) {
    var total = sumAmounts(bills);
    if (total <= 0) {
      return [];
    }
    var ratios = computeRatios(bills);
    var result = [];
    var pct = function (r) { return (r * 100).toFixed(1); };

    // 规则一（优先级最高）：冲动消费占比
    if (ratios.impulsive_ratio >= IMPULSIVE_RATIO_THRESHOLD) {
      result.push(ADVICE_IMPULSIVE.replace('{pct}', pct(ratios.impulsive_ratio)));
    }
    // 规则二：餐饮占比显著偏高
    var foodRatio = ratios.by_category['餐饮'].ratio;
    if (foodRatio >= FOOD_RATIO_THRESHOLD) {
      result.push(ADVICE_FOOD.replace('{pct}', pct(foodRatio)));
    }
    // 规则三：娱乐占比偏高
    var funRatio = ratios.by_category['娱乐'].ratio;
    if (funRatio >= FUN_RATIO_THRESHOLD) {
      result.push(ADVICE_FUN.replace('{pct}', pct(funRatio)));
    }
    // 一条都不命中 → 正常话术
    if (result.length === 0) {
      result.push(ADVICE_BALANCED);
    }
    return result;
  }

  /**
   * 总资产求和：所有账户 balance_cents 整数相加（B1：与账单完全解耦）
   * @param {Array<{balance_cents:number}>} accounts
   * @returns {number} 总额（分）
   */
  function sumAccounts(accounts) {
    var total = 0;
    var i;
    for (i = 0; i < accounts.length; i++) {
      var b = accounts[i] && accounts[i].balance_cents;
      if (typeof b === 'number' && isFinite(b)) {
        total += Math.round(b);
      }
    }
    return total;
  }

  return {
    CATEGORIES: CATEGORIES,
    TAGS: TAGS,
    TAG_RIGID: TAG_RIGID,
    TAG_IMPULSIVE: TAG_IMPULSIVE,
    IMPULSIVE_RATIO_THRESHOLD: IMPULSIVE_RATIO_THRESHOLD,
    FOOD_RATIO_THRESHOLD: FOOD_RATIO_THRESHOLD,
    FUN_RATIO_THRESHOLD: FUN_RATIO_THRESHOLD,
    sumAmounts: sumAmounts,
    filterByMonth: filterByMonth,
    filterByCurrentMonth: filterByCurrentMonth,
    currentMonthPrefix: currentMonthPrefix,
    summarizeByCategory: summarizeByCategory,
    computeRatios: computeRatios,
    formatYuan: formatYuan,
    getAdvice: getAdvice,
    sumAccounts: sumAccounts
  };
});
