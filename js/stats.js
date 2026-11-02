/**
 * stats.js —— 统计计算（纯函数模块）
 *
 * 设计约束（v1 需求书 5.2 + v2 增量需求书 5.1/5.4③）：
 * - 不碰 DOM、不碰 localStorage，输入数据、输出结果
 * - UMD 双环境守卫：浏览器挂到 window.LedgerStats；Node 通过 module.exports 供测试 require
 * - 金额一律以"分"为单位的整数（*_cents），求和先整数相加、展示时再转元
 * - 枚举常量统一定义在此，全项目禁止散落魔法字符串
 * - v2 变更：v1 固定 3 条建议规则（getAdvice）整体废弃，由 insights.js 洞察引擎替代；
 *   本文件补充环比等洞察所需的统计纯函数（previousMonthPrefix / momChangeRatio）
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
   * 上一个月的 "YYYY-MM" 前缀（v2 新增：环比对比所需，跨年正确回退）
   * @param {Date} now
   * @returns {string} 形如 "2026-09"；1 月返回上一年 "YYYY-12"
   */
  function previousMonthPrefix(now) {
    var year = now.getFullYear();
    var month = now.getMonth(); // 0-based
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    return year + '-' + pad2(month + 1);
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
   * 环比变化率（v2 新增：洞察引擎对比类模板所需）。
   * |本期 - 上期| / 上期；上期 <= 0 或非有限数时返回 0（无法比较则视为无变化）。
   * @param {number} currentCents 本期金额（分）
   * @param {number} previousCents 上期金额（分）
   * @returns {number} 非负变化率（0~∞）
   */
  function momChangeRatio(currentCents, previousCents) {
    if (typeof previousCents !== 'number' || !isFinite(previousCents) || previousCents <= 0) {
      return 0;
    }
    if (typeof currentCents !== 'number' || !isFinite(currentCents)) {
      return 0;
    }
    return Math.abs(currentCents - previousCents) / previousCents;
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
    sumAmounts: sumAmounts,
    filterByMonth: filterByMonth,
    filterByCurrentMonth: filterByCurrentMonth,
    currentMonthPrefix: currentMonthPrefix,
    previousMonthPrefix: previousMonthPrefix,
    summarizeByCategory: summarizeByCategory,
    computeRatios: computeRatios,
    formatYuan: formatYuan,
    momChangeRatio: momChangeRatio,
    sumAccounts: sumAccounts
  };
});
