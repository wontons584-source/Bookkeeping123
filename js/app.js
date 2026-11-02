/**
 * app.js —— 页面渲染与事件绑定（唯一的 DOM 操作入口）
 *
 * 设计约束（需求书 5.2）：
 * - 只做渲染和事件绑定：数据一律从 store.js 取，计算一律调 stats.js
 * - 视图联动 T4/T5：任何账单/账户变更后，列表、饼图、消费分析、总资产整体重算
 * - 语音 T6/T7/T8：识别结果只预填表单，用户点保存才落库
 * - OCR 仅占位提示，无任何识别代码路径
 * - 删除账单必须 confirm，取消则无任何变化（T2/T3）
 */
(function () {
  'use strict';

  var stats = window.LedgerStats;
  var store = window.LedgerStore;
  var speech = window.LedgerSpeech;

  /** 内存态数据（唯一来源是 store.js） */
  var bills = [];
  var accounts = [];
  /** Chart.js 饼图实例，重绘前必须销毁 */
  var pieChart = null;

  /** 分类配色（饼图分区颜色，与 6 个枚举一一对应） */
  var CATEGORY_COLORS = {
    '餐饮': '#ef4444',
    '交通': '#3b82f6',
    '学习': '#10b981',
    '娱乐': '#f59e0b',
    '日用': '#8b5cf6',
    '其他': '#6b7280'
  };

  // ---------- 小工具 ----------

  function $(id) {
    return document.getElementById(id);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** 今天的本地日期 YYYY-MM-DD（表单默认值） */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 分 → 元展示字符串 */
  function fmt(cents) {
    return stats.formatYuan(cents);
  }

  /** HTML 转义，防止商户/备注里的特殊字符破坏列表结构 */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 在指定提示区显示一行文案 */
  function setTip(id, text) {
    var el = $(id);
    if (el) {
      el.textContent = text;
      el.style.display = text ? 'block' : 'none';
    }
  }

  // ---------- 初始化 ----------

  function init() {
    populateCategorySelect();
    $('bill-date').value = todayStr();

    var loaded = store.loadAll();
    bills = loaded.bills;
    accounts = loaded.accounts;

    bindEvents();
    renderAll();
  }

  /** 分类下拉从 stats 枚举常量生成，不写魔法字符串 */
  function populateCategorySelect() {
    var sel = $('bill-category');
    sel.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '请选择分类';
    sel.appendChild(placeholder);
    for (var i = 0; i < stats.CATEGORIES.length; i++) {
      var opt = document.createElement('option');
      opt.value = stats.CATEGORIES[i];
      opt.textContent = stats.CATEGORIES[i];
      sel.appendChild(opt);
    }
  }

  function bindEvents() {
    $('bill-form').addEventListener('submit', onSaveBill);
    $('bill-list').addEventListener('click', onDeleteBillClick);
    $('account-form').addEventListener('submit', onAddAccount);
    $('account-list').addEventListener('click', onUpdateBalanceClick);
    $('speech-btn').addEventListener('click', onSpeechClick);
    $('ocr-btn').addEventListener('click', function () {
      setTip('ocr-tip', '截图识别功能开发中');
    });
  }

  // ---------- 账单：录入（T1）----------

  /**
   * 保存账单：校验失败给具体提示，不静默；通过后写存储，成功才更新内存态并重算视图
   */
  function onSaveBill(e) {
    e.preventDefault();
    setTip('form-error', '');
    setTip('speech-tip', '');
    setTip('ocr-tip', '');

    // 金额：界面输入元（支持小数），保存时 Math.round(yuan * 100) 转分
    var yuan = parseFloat($('bill-amount').value);
    if (!isFinite(yuan) || yuan <= 0) {
      setTip('form-error', '请输入大于 0 的合法金额，例如 12.50');
      return;
    }
    var cents = Math.round(yuan * 100);
    if (cents < 1) {
      setTip('form-error', '金额太小，最小支持 0.01 元');
      return;
    }

    // 日期：合法 YYYY-MM-DD
    var date = $('bill-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date.replace(/-/g, '/')).getTime())) {
      setTip('form-error', '请选择合法的日期');
      return;
    }

    // 分类：必须从 6 个枚举中选
    var category = $('bill-category').value;
    if (stats.CATEGORIES.indexOf(category) === -1) {
      setTip('form-error', '请选择消费分类');
      return;
    }

    // 标签：刚性/冲动必选，系统不自动判定
    var tagInput = document.querySelector('input[name="bill-tag"]:checked');
    if (!tagInput) {
      setTip('form-error', '请选择消费标签（刚性 / 冲动）');
      return;
    }

    var bill = {
      id: store.generateId(),
      date: date,
      amount_cents: cents,
      merchant: $('bill-merchant').value.trim().slice(0, 20),
      category: category,
      tag: tagInput.value,
      note: $('bill-note').value.trim().slice(0, 50),
      created_at: Date.now()
    };

    // 新账单 created_at 最大，置于数组头部（列表排序固定：created_at 倒序，新的在上）
    var nextBills = [bill].concat(bills);
    if (!store.saveBills(nextBills)) {
      // 配额写满：提示且不更新内存态，不静默丢数据
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    bills = nextBills;
    resetBillForm();
    renderAll();
  }

  /** 保存成功后清空表单，日期恢复为今天 */
  function resetBillForm() {
    $('bill-amount').value = '';
    $('bill-merchant').value = '';
    $('bill-category').value = '';
    $('bill-note').value = '';
    $('bill-date').value = todayStr();
    var checked = document.querySelector('input[name="bill-tag"]:checked');
    if (checked) {
      checked.checked = false;
    }
  }

  // ---------- 账单：删除（T2/T3）----------

  function onDeleteBillClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[data-del-id]') : null;
    if (!btn) {
      return;
    }
    var id = btn.getAttribute('data-del-id');
    // 确认弹窗；点取消则无任何变化
    if (!window.confirm('确认删除这条账单吗？删除后不可恢复')) {
      return;
    }
    var nextBills = [];
    for (var i = 0; i < bills.length; i++) {
      if (bills[i].id !== id) {
        nextBills.push(bills[i]);
      }
    }
    if (!store.saveBills(nextBills)) {
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    bills = nextBills;
    renderAll();
  }

  // ---------- 渲染 ----------

  function renderAll() {
    renderList();
    renderStats();
    renderAccounts();
  }

  /** 账单列表：全部历史账单（统计只算本月，见 A1） */
  function renderList() {
    var ul = $('bill-list');
    if (bills.length === 0) {
      ul.innerHTML = '<li class="empty">暂无账单，先在上方记一笔吧。</li>';
    } else {
      var html = '';
      for (var i = 0; i < bills.length; i++) {
        var b = bills[i];
        html += '<li class="bill-item">' +
          '<span class="bill-date">' + escapeHtml(b.date) + '</span>' +
          '<span class="bill-category">' + escapeHtml(b.category) + '</span>' +
          '<span class="bill-tag tag-' + (b.tag === stats.TAG_IMPULSIVE ? 'impulsive' : 'rigid') + '">' + escapeHtml(b.tag) + '</span>' +
          '<span class="bill-merchant">' + (b.merchant ? escapeHtml(b.merchant) : '-') + '</span>' +
          '<span class="bill-note">' + (b.note ? escapeHtml(b.note) : '') + '</span>' +
          '<span class="bill-amount">' + fmt(b.amount_cents) + ' 元</span>' +
          '<button type="button" data-del-id="' + escapeHtml(b.id) + '">删除</button>' +
          '</li>';
      }
      ul.innerHTML = html;
    }
    // 列表区的"本月合计"与饼图/分析同口径（本月），避免"列表和统计对不上"的困惑
    var monthBills = stats.filterByCurrentMonth(bills, new Date());
    $('list-total').textContent =
      '本月合计：' + fmt(stats.sumAmounts(monthBills)) + ' 元（统计范围为本月，下方列表展示全部 ' + bills.length + ' 条历史账单）';
  }

  /** 本月统计：饼图 + 消费分析（A1：只统计 date 的 YYYY-MM 等于当前自然月的账单） */
  function renderStats() {
    var monthBills = stats.filterByCurrentMonth(bills, new Date());
    var ratios = stats.computeRatios(monthBills);
    $('month-total').textContent = fmt(ratios.total_cents) + ' 元';

    // 消费分析
    var adviceUl = $('advice-list');
    var advices = stats.getAdvice(monthBills);
    if (advices.length === 0) {
      adviceUl.innerHTML = '<li class="empty">本月暂无账单，先记一笔再看分析。</li>';
    } else {
      var html = '';
      for (var i = 0; i < advices.length; i++) {
        html += '<li>' + escapeHtml(advices[i]) + '</li>';
      }
      adviceUl.innerHTML = html;
    }

    renderPieChart(monthBills, ratios);
  }

  /** 饼图：本月无账单显示空态文案，不画空图、不报错；有数据则销毁重建 */
  function renderPieChart(monthBills, ratios) {
    var canvas = $('pie-chart');
    var emptyEl = $('pie-empty');

    if (pieChart) {
      pieChart.destroy();
      pieChart = null;
    }

    var labels = [];
    var data = [];
    var colors = [];
    for (var i = 0; i < stats.CATEGORIES.length; i++) {
      var cat = stats.CATEGORIES[i];
      if (ratios.by_category[cat].cents > 0) {
        labels.push(cat);
        data.push(ratios.by_category[cat].cents);
        colors.push(CATEGORY_COLORS[cat]);
      }
    }

    if (monthBills.length === 0 || data.length === 0) {
      canvas.style.display = 'none';
      emptyEl.style.display = 'block';
      return;
    }

    canvas.style.display = 'block';
    emptyEl.style.display = 'none';
    pieChart = new window.Chart(canvas.getContext('2d'), {
      type: 'pie',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: colors
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.label + '：' + fmt(ctx.parsed) + ' 元';
              }
            }
          }
        }
      }
    });
  }

  // ---------- 账户（B1：与账单完全解耦，纯手动维护）----------

  function onAddAccount(e) {
    e.preventDefault();
    setTip('account-error', '');

    var name = $('acc-name').value.trim();
    if (!name || name.length > 10) {
      setTip('account-error', '账户名称不能为空且不超过 10 个字');
      return;
    }
    var yuan = parseFloat($('acc-balance').value);
    if (!isFinite(yuan) || yuan < 0) {
      setTip('account-error', '余额需为不小于 0 的数字，例如 320 或 100.50');
      return;
    }
    var account = {
      id: store.generateId(),
      name: name,
      balance_cents: Math.round(yuan * 100)
    };
    var nextAccounts = accounts.concat([account]);
    if (!store.saveAccounts(nextAccounts)) {
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    accounts = nextAccounts;
    $('acc-name').value = '';
    $('acc-balance').value = '';
    renderAccounts();
  }

  /** 修改账户余额（B1"纯手动维护"的应有之义）：行内输入新余额后点更新 */
  function onUpdateBalanceClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[data-update-id]') : null;
    if (!btn) {
      return;
    }
    var id = btn.getAttribute('data-update-id');
    var li = btn.closest('li[data-acc-id]');
    var input = li ? li.querySelector('input.acc-balance-input') : null;
    if (!input) {
      return;
    }
    var yuan = parseFloat(input.value);
    if (!isFinite(yuan) || yuan < 0) {
      setTip('account-error', '余额需为不小于 0 的数字');
      return;
    }
    var nextAccounts = [];
    for (var i = 0; i < accounts.length; i++) {
      var acc = accounts[i];
      if (acc.id === id) {
        // 创建新对象而非原地改，保证只有保存成功后才更新内存态
        acc = { id: acc.id, name: acc.name, balance_cents: Math.round(yuan * 100) };
      }
      nextAccounts.push(acc);
    }
    if (!store.saveAccounts(nextAccounts)) {
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    accounts = nextAccounts;
    setTip('account-error', '');
    renderAccounts();
  }

  function renderAccounts() {
    var ul = $('account-list');
    if (accounts.length === 0) {
      ul.innerHTML = '<li class="empty">暂无账户，添加微信 / 支付宝 / 现金试试。</li>';
    } else {
      var html = '';
      for (var i = 0; i < accounts.length; i++) {
        var a = accounts[i];
        html += '<li class="account-item" data-acc-id="' + escapeHtml(a.id) + '">' +
          '<span class="acc-name">' + escapeHtml(a.name) + '</span>' +
          '<span class="acc-balance">' + fmt(a.balance_cents) + ' 元</span>' +
          '<input type="number" step="0.01" min="0" class="acc-balance-input" placeholder="新余额（元）" />' +
          '<button type="button" data-update-id="' + escapeHtml(a.id) + '">更新余额</button>' +
          '</li>';
      }
      ul.innerHTML = html;
    }
    // 总资产 = 所有账户 balance_cents 整数求和后转元（B1，与账单无关）
    $('total-assets').textContent = fmt(stats.sumAccounts(accounts)) + ' 元';
  }

  // ---------- 语音口述（T6/T7/T8）----------

  function onSpeechClick() {
    setTip('speech-tip', '');
    setTip('ocr-tip', '');
    if (!speech.isSupported()) {
      setTip('speech-tip', '当前环境不支持语音记账，请手动填写');
      return;
    }
    setTip('speech-tip', '正在聆听，请说出这笔开销，例如"食堂吃饭十二块"……');
    var started = speech.start(onSpeechResult, onSpeechError);
    if (!started) {
      setTip('speech-tip', '当前环境不支持语音记账，请手动填写');
    }
  }

  /** 识别成功：只预填表单（草稿），绝不直接落库 */
  function onSpeechResult(text) {
    var parsed = speech.parseTranscript(text);
    var prefilled = [];
    if (parsed.amount_yuan !== null) {
      $('bill-amount').value = parsed.amount_yuan;
      prefilled.push('金额');
    }
    if (parsed.category) {
      $('bill-category').value = parsed.category;
      prefilled.push('分类');
    }
    if (parsed.note) {
      $('bill-note').value = parsed.note.slice(0, 50);
      prefilled.push('备注');
    }
    if (parsed.amount_yuan === null) {
      setTip('speech-tip', '已识别"' + text + '"，但未能解析出金额，请手动填写金额后保存。');
    } else {
      setTip('speech-tip', '识别结果已预填（' + prefilled.join('、') + '），请确认无误后点"保存账单"。');
    }
  }

  function onSpeechError(message) {
    setTip('speech-tip', message);
  }

  // DOMContentLoaded 后启动（脚本在 body 底部以经典 script 引入，此守卫双保险）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
