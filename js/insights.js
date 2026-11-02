/**
 * insights.js —— AI 消费洞察引擎（v2 新增，端侧 AI 三件套之三）
 *
 * 设计约束（v2 增量需求书 5.4③、A11）：
 * - 纯函数模块：不碰 DOM、不碰存储；依赖 stats.js 的统计纯函数（UMD 双环境），
 *   不依赖 app/store，Node 下经 require('./stats.js') 复用
 * - generateInsights(bills, accounts, now) → string[]
 * - 模板库 ≥10 个、五类各 ≥2（结构/对比/习惯/风险/资产），每个模板带触发条件
 *   （最少样本量）；满足条件者按相关度排序取前 2–4 条
 * - 本月账单 < MIN_MONTH_BILLS 笔：输出引导话术，话术与解锁条件共用同一常量
 * - 环比对比需要上月数据，上月无数据则对比类模板不触发
 * - 输出条数必须落在 [2, 4]：上限截断；下限由两个恒触发的总览兜底模板保证
 * - v1 固定 3 条建议规则在本模块整体替代（v1 getAdvice 已从 stats.js 移除）
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'));
  } else {
    root.LedgerInsights = factory(root.LedgerStats);
  }
})(typeof self !== 'undefined' ? self : this, function (stats) {
  'use strict';

  if (!stats) {
    throw new Error('insights.js 依赖 stats.js：请确保先加载/引入 stats.js');
  }

  // ---------- 阈值常量（命名常量，测试直接引用；引导话术与解锁条件同源） ----------
  var MIN_MONTH_BILLS = 3;                 // 本月解锁洞察的最少账单笔数
  var IMPULSIVE_RISK_RATIO = 0.3;          // 冲动占比 ≥ 30% → 风险预警
  var FUN_RISK_RATIO = 0.25;               // 娱乐占比 ≥ 25% → 风险预警
  var FREQUENT_SMALL_MIN_COUNT = 5;        // 高频小额：同分类笔数 ≥ 5
  var FREQUENT_SMALL_MAX_AVG_CENTS = 3000; // 高频小额：平均单笔 < 30 元（3000 分）
  var BIG_SINGLE_MIN_CENTS = 5000;         // 大额单笔：单笔 ≥ 50 元（5000 分）
  var MOM_CATEGORY_MIN_CHANGE = 0.05;      // 分类环比占比变化 ≥ 5 个百分点才触发
  var MIN_INSIGHTS = 2;                    // 输出条数下限
  var MAX_INSIGHTS = 4;                    // 输出条数上限

  function pct(ratio) {
    return (ratio * 100).toFixed(1);
  }

  function yuan(cents) {
    return stats.formatYuan(cents);
  }

  /** 统计本月各分类笔数（未知分类容错归入"其他"，口径与 stats.summarizeByCategory 一致） */
  function countByCategory(bills) {
    var counts = {};
    var i;
    for (i = 0; i < stats.CATEGORIES.length; i++) {
      counts[stats.CATEGORIES[i]] = 0;
    }
    for (i = 0; i < bills.length; i++) {
      var cat = bills[i] && bills[i].category;
      if (stats.CATEGORIES.indexOf(cat) === -1) {
        cat = '其他';
      }
      counts[cat] += 1;
    }
    return counts;
  }

  /**
   * 生成消费洞察。每次视图重算即时调用，无持久化。
   * @param {Array} bills 全部历史账单（本函数内部按当月/上月过滤）
   * @param {Array} accounts 账户数组（资产类模板需要）
   * @param {Date} [now] 系统当前时间（注入以便测试；缺省取当前时间）
   * @returns {string[]} 2–4 条洞察文案；数据不足时为 1 条引导话术
   */
  function generateInsights(bills, accounts, now) {
    bills = Array.isArray(bills) ? bills : [];
    accounts = Array.isArray(accounts) ? accounts : [];
    now = (now instanceof Date) ? now : new Date();

    var curYm = stats.currentMonthPrefix(now);
    var prevYm = stats.previousMonthPrefix(now);
    var cur = stats.filterByMonth(bills, curYm);
    var prev = stats.filterByMonth(bills, prevYm);

    // 数据不足：只输出引导话术（与解锁条件同一常量，保证"话术=条件"同源）
    if (cur.length < MIN_MONTH_BILLS) {
      return ['当月记账满 ' + MIN_MONTH_BILLS + ' 笔解锁消费洞察，再记 ' +
        (MIN_MONTH_BILLS - cur.length) + ' 笔就好。'];
    }

    var ratios = stats.computeRatios(cur);
    var prevRatios = stats.computeRatios(prev);
    var counts = countByCategory(cur);
    var assetsTotal = stats.sumAccounts(accounts);
    var candidates = [];

    // ============ 结构类（3 个：前 2 个恒触发，兜底保证下限 2 条） ============

    // 结构-总览（恒触发）：本月笔数与合计
    candidates.push({
      type: '结构',
      relevance: 0.01,
      text: '本月共记录 ' + cur.length + ' 笔账单，合计支出 ' + yuan(ratios.total_cents) + ' 元。'
    });

    // 结构-刚性/冲动构成（恒触发）
    var rigidCents = ratios.total_cents - ratios.impulsive_cents;
    var rigidRatio = ratios.total_cents > 0 ? rigidCents / ratios.total_cents : 0;
    candidates.push({
      type: '结构',
      relevance: 0.02,
      text: '本月刚性支出占 ' + pct(rigidRatio) + '%、冲动支出占 ' + pct(ratios.impulsive_ratio) + '%。'
    });

    // 结构-最大占比分类（total > 0 时触发）
    var topCat = null;
    var topRatio = 0;
    var i;
    for (i = 0; i < stats.CATEGORIES.length; i++) {
      var catName = stats.CATEGORIES[i];
      var r = ratios.by_category[catName].ratio;
      if (r > topRatio) {
        topRatio = r;
        topCat = catName;
      }
    }
    if (topCat && ratios.total_cents > 0) {
      candidates.push({
        type: '结构',
        relevance: topRatio,
        text: '本月「' + topCat + '」支出占 ' + pct(topRatio) + '%，是最大的开销去向，合计 ' +
          yuan(ratios.by_category[topCat].cents) + ' 元。'
      });
    }

    // ============ 对比类（2 个：上月有数据才触发） ============

    // 对比-总支出环比
    if (prevRatios.total_cents > 0) {
      var totalChange = stats.momChangeRatio(ratios.total_cents, prevRatios.total_cents);
      var direction = ratios.total_cents >= prevRatios.total_cents ? '增加' : '减少';
      candidates.push({
        type: '对比',
        relevance: totalChange,
        text: '本月支出 ' + yuan(ratios.total_cents) + ' 元，上月 ' + yuan(prevRatios.total_cents) +
          ' 元，环比' + direction + ' ' + pct(totalChange) + '%。'
      });
    }

    // 对比-分类环比（找占比变化最大的分类）
    var maxChangeCat = null;
    var maxChangeAbs = 0;
    var maxChangeCur = 0;
    var maxChangePrev = 0;
    for (i = 0; i < stats.CATEGORIES.length; i++) {
      var cName = stats.CATEGORIES[i];
      var curRatio = ratios.by_category[cName].ratio;
      var prevRatio = prevRatios.by_category[cName].ratio;
      var diff = curRatio - prevRatio;
      if (Math.abs(diff) > maxChangeAbs) {
        maxChangeAbs = Math.abs(diff);
        maxChangeCat = cName;
        maxChangeCur = curRatio;
        maxChangePrev = prevRatio;
      }
    }
    if (prev.length > 0 && maxChangeCat && maxChangeAbs >= MOM_CATEGORY_MIN_CHANGE) {
      candidates.push({
        type: '对比',
        relevance: maxChangeAbs,
        text: '「' + maxChangeCat + '」支出占比从上月的 ' + pct(maxChangePrev) + '% 变为本月的 ' +
          pct(maxChangeCur) + '%，波动最明显。'
      });
    }

    // ============ 习惯类（2 个） ============

    // 习惯-高频小额：同分类笔数 ≥5 且平均单笔 < 30 元
    var smallCat = null;
    var smallCount = 0;
    var smallAvg = 0;
    for (i = 0; i < stats.CATEGORIES.length; i++) {
      var sName = stats.CATEGORIES[i];
      var cnt = counts[sName];
      var centsSum = ratios.by_category[sName].cents;
      if (cnt >= FREQUENT_SMALL_MIN_COUNT && centsSum > 0 && centsSum / cnt < FREQUENT_SMALL_MAX_AVG_CENTS) {
        if (cnt > smallCount) {
          smallCat = sName;
          smallCount = cnt;
          smallAvg = centsSum / cnt;
        }
      }
    }
    if (smallCat) {
      candidates.push({
        type: '习惯',
        relevance: smallCount / 20,
        text: '「' + smallCat + '」本月累计 ' + smallCount + ' 笔、平均每笔 ' + yuan(Math.round(smallAvg)) +
          ' 元，高频小额特征明显，积少成多也要留意。'
      });
    }

    // 习惯-大额单笔：本月最大单笔 ≥ 50 元
    var maxBill = null;
    for (i = 0; i < cur.length; i++) {
      var b = cur[i];
      var c = b && b.amount_cents;
      if (typeof c === 'number' && isFinite(c) && (!maxBill || c > maxBill.amount_cents)) {
        maxBill = b;
      }
    }
    if (maxBill && maxBill.amount_cents >= BIG_SINGLE_MIN_CENTS) {
      var bigRatio = ratios.total_cents > 0 ? maxBill.amount_cents / ratios.total_cents : 0;
      candidates.push({
        type: '习惯',
        relevance: maxBill.amount_cents / 20000,
        text: '本月最大单笔支出 ' + yuan(maxBill.amount_cents) + ' 元（' +
          (stats.CATEGORIES.indexOf(maxBill.category) === -1 ? '其他' : maxBill.category) +
          (maxBill.merchant ? ' · ' + maxBill.merchant : '') + '），占总支出 ' + pct(bigRatio) + '%。'
      });
    }

    // ============ 风险类（2 个） ============

    // 风险-冲动占比 ≥ 30% 预警
    if (ratios.impulsive_ratio >= IMPULSIVE_RISK_RATIO) {
      candidates.push({
        type: '风险',
        relevance: 1 + ratios.impulsive_ratio,
        text: '冲动消费占比达 ' + pct(ratios.impulsive_ratio) + '%，已越过 ' +
          (IMPULSIVE_RISK_RATIO * 100) + '% 预警线，建议给"想要型"消费设个月度上限。'
      });
    }

    // 风险-娱乐占比 ≥ 25%
    var funRatio = ratios.by_category['娱乐'].ratio;
    if (funRatio >= FUN_RISK_RATIO) {
      candidates.push({
        type: '风险',
        relevance: 0.5 + funRatio,
        text: '娱乐支出占 ' + pct(funRatio) + '%（预警阈值 ' + (FUN_RISK_RATIO * 100) +
          '%），本月娱乐花得偏多。'
      });
    }

    // ============ 资产类（2 个） ============

    // 资产-余额消耗速度：按本月日均消费估算家底可撑天数
    var daysElapsed = now.getDate();
    if (assetsTotal > 0 && ratios.total_cents > 0 && daysElapsed >= 1) {
      var dailySpend = ratios.total_cents / daysElapsed;
      var daysLeft = Math.floor(assetsTotal / dailySpend);
      candidates.push({
        type: '资产',
        relevance: 0.4,
        text: '按本月日均 ' + yuan(Math.round(dailySpend)) + ' 元的消费速度，当前总资产 ' +
          yuan(assetsTotal) + ' 元大约还够撑 ' + daysLeft + ' 天。'
      });
    }

    // 资产-家底告急：本月支出已超过总资产
    if (assetsTotal > 0 && ratios.total_cents > assetsTotal) {
      candidates.push({
        type: '资产',
        relevance: 2,
        text: '本月支出 ' + yuan(ratios.total_cents) + ' 元已超过当前总资产 ' + yuan(assetsTotal) +
          ' 元，家底告急，注意节流。'
      });
    }

    // 按相关度排序（同相关度按模板登记顺序，保证输出确定），上限截断到 4 条。
    // 两个恒触发兜底模板保证 candidates ≥ 2，即输出条数恒落在 [2, 4]。
    for (i = 0; i < candidates.length; i++) {
      candidates[i].order = i;
    }
    candidates.sort(function (a, b) {
      if (b.relevance !== a.relevance) {
        return b.relevance - a.relevance;
      }
      return a.order - b.order;
    });
    var output = [];
    for (i = 0; i < candidates.length && output.length < MAX_INSIGHTS; i++) {
      output.push(candidates[i].text);
    }
    return output;
  }

  return {
    MIN_MONTH_BILLS: MIN_MONTH_BILLS,
    IMPULSIVE_RISK_RATIO: IMPULSIVE_RISK_RATIO,
    FUN_RISK_RATIO: FUN_RISK_RATIO,
    FREQUENT_SMALL_MIN_COUNT: FREQUENT_SMALL_MIN_COUNT,
    FREQUENT_SMALL_MAX_AVG_CENTS: FREQUENT_SMALL_MAX_AVG_CENTS,
    BIG_SINGLE_MIN_CENTS: BIG_SINGLE_MIN_CENTS,
    MIN_INSIGHTS: MIN_INSIGHTS,
    MAX_INSIGHTS: MAX_INSIGHTS,
    generateInsights: generateInsights
  };
});
