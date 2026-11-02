/**
 * app.js —— 页面渲染与事件绑定（唯一的 DOM 操作入口，v2 多账号版）
 *
 * 设计约束（v1 需求书 5.2 + v2 增量需求书 5.1/5.4/3.2/3.3）：
 * - 只做渲染和事件绑定：数据一律从 store.js 取，计算一律调 stats / auth / recommend / insights
 * - 认证线：未登录只渲染登录/注册页（不渲染任何业务数据）；登录后按角色分流
 * - 学生 → v1 完整界面（读写本人 per-user 数据）+ 邀请码 UI + 推荐卡 + 洞察区
 * - 家长 → 已绑定：只读视图（DOM 不渲染任何写入口，不是 display:none 隐藏）；
 *          未绑定：绑定引导页
 * - 视图按角色整体重渲染（innerHTML 替换），保证家长视图 DOM 中不存在表单/删除按钮
 * - 语音 T6/T7/T8 不变；预填成功后追加一次 recommend 匹配展示推荐卡（T22）
 * - 推荐只动表单，永不直接落库（T23/T24）
 * - OCR 仅占位提示，无任何识别代码路径
 * - 迁移顺序钉死（T20/T21）：决策（auth）→ 写 per-user 键 → 成功后才删旧键（store）
 */
(function () {
  'use strict';

  var stats = window.LedgerStats;
  var store = window.LedgerStore;
  var speech = window.LedgerSpeech;
  var auth = window.LedgerAuth;
  var recommend = window.LedgerRecommend;
  var insights = window.LedgerInsights;

  /** 内存态数据（唯一来源是 store.js） */
  var state = {
    user: null,   // users 表中当前登录的记录
    bills: [],    // 当前展示学生的账单（学生=本人；家长=绑定学生）
    accounts: []  // 同上
  };

  /** Chart.js 饼图实例，重绘前必须销毁 */
  var pieChart = null;

  /** 当前展示中的推荐结果（T22–T24） */
  var currentRec = null;

  /** 登录/注册后跨视图展示的一次性提示（如迁移结果），{ isError, text } */
  var pendingTip = null;

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

  /** HTML 转义，防止用户名/商户/备注里的特殊字符破坏页面结构 */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 在指定提示区显示一行文案 */
  function setTip(id, text, isError) {
    var el = $(id);
    if (!el) {
      return;
    }
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
    el.className = text ? (isError ? 'tip error' : 'tip info') : 'tip';
  }

  /** 渲染前整体替换主容器内容：旧视图节点（含可能的表单/按钮）从 DOM 中移除 */
  function renderMain(html) {
    destroyPieChart();
    currentRec = null;
    $('app-main').innerHTML = html;
  }

  /** 渲染后展示登录/注册阶段带过来的一次性提示（如迁移结果） */
  function showPendingTip() {
    if (!pendingTip) {
      return;
    }
    var tip = pendingTip;
    pendingTip = null;
    setTip('view-tip', tip.text, tip.isError);
  }

  function destroyPieChart() {
    if (pieChart) {
      pieChart.destroy();
      pieChart = null;
    }
  }

  // ==================================================================
  // 路由：未登录 → 登录/注册页；学生 → 完整界面；家长 → 引导页/只读视图
  // ==================================================================

  function route() {
    var users = store.loadUsers();
    var session = store.readSession();
    if (session && auth.isSessionValid(session, users)) {
      state.user = auth.findUser(users, session.username);
      if (state.user.role === auth.ROLE_STUDENT) {
        renderStudentView();
      } else {
        renderParentView();
      }
    } else {
      // 会话残留但无效（用户被手工删除等）：清会话按未登录处理（v2 3.3⑥）
      if (session) {
        store.clearSession();
      }
      state.user = null;
      state.bills = [];
      state.accounts = [];
      renderAuthView('login');
    }
  }

  function onLogoutClick() {
    store.clearSession();
    state.user = null;
    state.bills = [];
    state.accounts = [];
    route();
  }

  // ==================================================================
  // 登录 / 注册（线四 T10–T13）
  // ==================================================================

  function authViewHtml(mode) {
    var isLogin = mode === 'login';
    var html = '<section class="card auth-card">' +
      '<h2>账号</h2>' +
      '<div class="auth-tabs">' +
        '<button type="button" data-auth-tab="login"' + (isLogin ? ' class="active"' : '') + '>登录</button>' +
        '<button type="button" data-auth-tab="register"' + (!isLogin ? ' class="active"' : '') + '>注册</button>' +
      '</div>';
    if (isLogin) {
      html += '<form id="login-form" novalidate>' +
        '<div class="form-row"><label for="login-username">用户名</label>' +
        '<input type="text" id="login-username" maxlength="20" autocomplete="username" /></div>' +
        '<div class="form-row"><label for="login-password">密码</label>' +
        '<input type="password" id="login-password" maxlength="20" autocomplete="current-password" /></div>' +
        '<div class="form-actions"><button type="submit" class="btn-primary">登录</button></div>' +
        '<p class="tip" id="auth-tip" style="display:none;"></p>' +
        '</form>';
    } else {
      html += '<form id="register-form" novalidate>' +
        '<div class="form-row"><label for="reg-username">用户名</label>' +
        '<input type="text" id="reg-username" maxlength="20" placeholder="1–20 字，不含冒号和首尾空格" /></div>' +
        '<div class="form-row"><label for="reg-password">密码</label>' +
        '<input type="password" id="reg-password" maxlength="20" placeholder="6–20 位" autocomplete="new-password" /></div>' +
        '<div class="form-row"><span class="label-text">角色（必选，注册后不可改）</span>' +
        '<label class="radio-label"><input type="radio" name="reg-role" value="学生" /> 学生</label>' +
        '<label class="radio-label"><input type="radio" name="reg-role" value="家长" /> 家长</label></div>' +
        '<div class="form-actions"><button type="submit" class="btn-primary">注册并登录</button></div>' +
        '<p class="tip" id="auth-tip" style="display:none;"></p>' +
        '</form>';
    }
    html += '<p class="scope-note">数据只存在本机浏览器（localStorage / sessionStorage），零网络请求。</p>' +
      '</section>';
    return html;
  }

  function renderAuthView(mode) {
    renderMain(authViewHtml(mode));
    var form = $(mode === 'login' ? 'login-form' : 'register-form');
    form.addEventListener('submit', mode === 'login' ? onLoginSubmit : onRegisterSubmit);
    var tabs = document.querySelectorAll('button[data-auth-tab]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        renderAuthView(e.currentTarget.getAttribute('data-auth-tab'));
      });
    }
  }

  /** 登录（T11）：用户名不存在或密码错误统一提示"用户名或密码错误"（3.3⑥） */
  function onLoginSubmit(e) {
    e.preventDefault();
    setTip('auth-tip', '');
    var username = $('login-username').value.trim();
    var password = $('login-password').value;
    if (!username || !password) {
      setTip('auth-tip', '请输入用户名和密码', true);
      return;
    }
    var users = store.loadUsers();
    var user = auth.findUser(users, username);
    if (!user) {
      setTip('auth-tip', '用户名或密码错误', true);
      return;
    }
    auth.verifyPassword(password, user.password_hash).then(function (ok) {
      if (!ok) {
        setTip('auth-tip', '用户名或密码错误', true);
        return;
      }
      store.writeSession(auth.buildSession(user));
      route();
    }).catch(function () {
      setTip('auth-tip', '登录失败，请重试', true);
    });
  }

  /**
   * 注册（T10）：校验 → 哈希 → 组装完整记录一次写入 → 自动登录。
   * 仅"注册成功且角色=学生"这一刻触发一次 v1 迁移检查（T20/T21，PRD 6.3-1）。
   */
  function onRegisterSubmit(e) {
    e.preventDefault();
    setTip('auth-tip', '');
    var users = store.loadUsers();
    var roleInput = document.querySelector('input[name="reg-role"]:checked');
    var result = auth.validateRegistration({
      username: $('reg-username').value,
      password: $('reg-password').value,
      role: roleInput ? roleInput.value : '',
      users: users
    });
    if (!result.ok) {
      setTip('auth-tip', result.message, true);
      return;
    }
    var username = $('reg-username').value;
    var password = $('reg-password').value;
    auth.hashPassword(password).then(function (hash) {
      var user = auth.createUser({ username: username, role: roleInput.value }, hash, Date.now());
      var nextUsers = users.concat([user]);
      if (!store.saveUsers(nextUsers)) {
        // 注册失败：users 表不写入半条记录（组装完整后一次写入）
        setTip('auth-tip', '注册失败：本地存储写入失败，请重试', true);
        return;
      }
      store.writeSession(auth.buildSession(user));
      if (user.role === auth.ROLE_STUDENT) {
        runV1Migration(user.username);
      }
      route();
    }).catch(function () {
      setTip('auth-tip', '注册失败，请重试', true);
    });
  }

  /**
   * v1 数据迁移（T20/T21，触发时机钉死为"首个学生账号注册成功"）：
   * 决策（auth 纯函数）→ 写 per-user 键 → 写入确认成功后才删旧键（store）。
   * 失败：旧键保留、新账号空状态、弹提示不崩溃；旧键损坏：视为无旧数据静默跳过。
   */
  function runV1Migration(username) {
    var raw = store.getV1Raw();
    var decision = auth.decideV1Migration(raw.bills, raw.accounts);
    if (decision.action !== 'migrate') {
      return; // 无旧数据 / 旧键损坏（按无旧数据处理，不迁移不报错）
    }
    var ok = store.migrateV1ToUser(username, decision.bills, decision.accounts);
    if (ok) {
      pendingTip = {
        isError: false,
        text: '检测到 v1 旧数据，已自动迁移到你的账号（' + decision.bills.length +
          ' 笔账单、' + decision.accounts.length + ' 个账户），旧全局键已清除。'
      };
    } else {
      pendingTip = {
        isError: true,
        text: 'v1 旧数据迁移失败（本地存储写入失败）：旧数据已原样保留，你的账号暂为空状态，可稍后重试。'
      };
    }
  }

  // ==================================================================
  // 学生视图（v1 全部功能 + 邀请码 + 推荐卡 + 洞察区）
  // ==================================================================

  function studentViewHtml() {
    return '' +
      '<section class="card" id="section-welcome">' +
        '<div class="view-head">' +
          '<h2>你好，' + escapeHtml(state.user.username) + '（学生）</h2>' +
          '<button type="button" id="logout-btn">退出登录</button>' +
        '</div>' +
        '<p class="tip" id="view-tip" style="display:none;"></p>' +
        '<div id="invite-section"></div>' +
      '</section>' +

      '<section class="card" id="section-input">' +
        '<h2>一、录入账单</h2>' +
        '<form id="bill-form" novalidate>' +
          '<div class="form-row"><label for="bill-date">日期</label>' +
          '<input type="date" id="bill-date" required /></div>' +
          '<div class="form-row"><label for="bill-amount">金额（元）</label>' +
          '<input type="number" id="bill-amount" step="0.01" min="0.01" placeholder="例如 12.50" required /></div>' +
          '<div class="form-row"><label for="bill-merchant">商户（可空）</label>' +
          '<input type="text" id="bill-merchant" maxlength="20" placeholder="例如 蜜雪冰城" /></div>' +
          '<div class="form-row"><label for="bill-category">分类</label>' +
          '<select id="bill-category" required></select></div>' +
          '<div class="form-row"><span class="label-text">标签（必选）</span>' +
          '<label class="radio-label"><input type="radio" name="bill-tag" value="刚性" /> 刚性</label>' +
          '<label class="radio-label"><input type="radio" name="bill-tag" value="冲动" /> 冲动</label></div>' +
          '<div class="form-row"><label for="bill-note">备注（可空）</label>' +
          '<input type="text" id="bill-note" maxlength="50" placeholder="例如 下午加单奶茶" /></div>' +
          '<div class="form-actions">' +
            '<button type="submit" class="btn-primary">保存账单</button>' +
            '<button type="button" id="speech-btn">语音记账</button>' +
            '<button type="button" id="ocr-btn">截图识别（OCR）</button>' +
          '</div>' +
          '<p class="tip error" id="form-error" style="display:none;"></p>' +
          '<p class="tip info" id="speech-tip" style="display:none;"></p>' +
          '<p class="tip info" id="ocr-tip" style="display:none;"></p>' +
          '<div id="recommend-card" class="recommend-card" style="display:none;"></div>' +
        '</form>' +
      '</section>' +

      '<section class="card" id="section-list">' +
        '<h2>二、账单列表</h2>' +
        '<p class="list-total" id="list-total"></p>' +
        '<ul id="bill-list" class="bill-list"></ul>' +
      '</section>' +

      '<section class="card" id="section-stats">' +
        '<h2>三、本月统计</h2>' +
        '<p class="scope-note">统计范围：本月（当前自然月）。历史月份账单保留在列表中，但不参与统计。</p>' +
        '<div class="stats-grid">' +
          '<div class="stats-left">' +
            '<h3>支出分类饼图</h3>' +
            '<p class="month-total">本月支出合计：<strong id="month-total"></strong></p>' +
            '<div class="pie-wrap">' +
              '<canvas id="pie-chart" width="320" height="320"></canvas>' +
              '<p class="empty" id="pie-empty" style="display:none;">本月暂无账单，饼图将在记账后自动生成。</p>' +
            '</div>' +
          '</div>' +
          '<div class="stats-right">' +
            '<h3>AI 消费洞察</h3>' +
            '<ul id="insight-list" class="advice-list"></ul>' +
          '</div>' +
        '</div>' +
      '</section>' +

      '<section class="card" id="section-accounts">' +
        '<h2>四、账户与总资产</h2>' +
        '<p class="scope-note">账户余额纯手动维护，与账单不联动。</p>' +
        '<p class="total-assets">总资产：<strong id="total-assets">0.00 元</strong></p>' +
        '<form id="account-form" novalidate>' +
          '<div class="form-row"><label for="acc-name">账户名称（≤10 字）</label>' +
          '<input type="text" id="acc-name" maxlength="10" placeholder="例如 微信 / 支付宝 / 现金" /></div>' +
          '<div class="form-row"><label for="acc-balance">余额（元）</label>' +
          '<input type="number" id="acc-balance" step="0.01" min="0" placeholder="例如 320" /></div>' +
          '<div class="form-actions"><button type="submit" class="btn-primary">添加账户</button></div>' +
          '<p class="tip error" id="account-error" style="display:none;"></p>' +
        '</form>' +
        '<ul id="account-list" class="account-list"></ul>' +
      '</section>';
  }

  function renderStudentView() {
    state.bills = store.loadUserBills(state.user.username);
    state.accounts = store.loadUserAccounts(state.user.username);
    renderMain(studentViewHtml());
    bindStudentEvents();
    populateCategorySelect();
    $('bill-date').value = todayStr();
    renderInviteSection();
    renderStudentData();
    showPendingTip();
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

  function bindStudentEvents() {
    $('logout-btn').addEventListener('click', onLogoutClick);
    $('bill-form').addEventListener('submit', onSaveBill);
    $('bill-list').addEventListener('click', onDeleteBillClick);
    $('account-form').addEventListener('submit', onAddAccount);
    $('account-list').addEventListener('click', onUpdateBalanceClick);
    $('speech-btn').addEventListener('click', onSpeechClick);
    $('ocr-btn').addEventListener('click', function () {
      setTip('ocr-tip', '截图识别功能开发中');
    });
    // 智能分类推荐（T22）：商户或备注键入时实时匹配
    $('bill-merchant').addEventListener('input', onRecommendInput);
    $('bill-note').addEventListener('input', onRecommendInput);
    // 推荐卡动作（T23 采纳 / T24 忽略）
    $('recommend-card').addEventListener('click', onRecommendCardClick);
    // 邀请码区（线五）与解绑（T19）：事件委托，按钮由 renderInviteSection 动态生成
    $('invite-section').addEventListener('click', onInviteSectionClick);
  }

  // ---------- 邀请码（线五 T14/T15）与解绑（线六 T19）----------

  function renderInviteSection() {
    var users = store.loadUsers();
    var me = auth.findUser(users, state.user.username);
    state.user = me; // 同步内存态（邀请码/绑定状态可能已变化）
    var parent = auth.findParentOfStudent(users, me.username);
    var html = '<h3>家长绑定（邀请码）</h3>';
    if (me.invite_code) {
      html += '<p>当前有效邀请码：<strong class="invite-code">' + me.invite_code +
        '</strong>（一次性使用，绑定成功即失效；重新生成后旧码作废）</p>' +
        '<button type="button" id="invite-btn">重新生成邀请码</button>';
    } else {
      html += '<p>当前没有有效邀请码。</p>' +
        '<button type="button" id="invite-btn">生成邀请码</button>';
    }
    if (parent) {
      html += '<p>已绑定家长：<strong>' + escapeHtml(parent.username) + '</strong></p>' +
        '<button type="button" id="unbind-parent-btn">解绑家长</button>';
    } else {
      html += '<p>尚未绑定家长。把邀请码告诉家长，家长登录后输入即可完成绑定。</p>';
    }
    $('invite-section').innerHTML = html;
  }

  function onInviteSectionClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn) {
      return;
    }
    if (btn.id === 'invite-btn') {
      onGenerateInviteCode();
    } else if (btn.id === 'unbind-parent-btn') {
      onStudentUnbind();
    }
  }

  /** 生成 / 重新生成邀请码（T14/T15）：生成查重，重新生成即作废旧码 */
  function onGenerateInviteCode() {
    var users = store.loadUsers();
    var code = auth.generateInviteCode(users);
    var nextUsers = auth.replaceUser(users, auth.withInviteCode(state.user, code));
    if (!store.saveUsers(nextUsers)) {
      window.alert('本地存储写入失败，请重试');
      return;
    }
    renderInviteSection();
  }

  /** 学生解绑家长（T19）：confirm 确认；学生的邀请码不会自动恢复（需重新生成） */
  function onStudentUnbind() {
    var users = store.loadUsers();
    var parent = auth.findParentOfStudent(users, state.user.username);
    if (!parent) {
      renderInviteSection();
      return;
    }
    if (!window.confirm('确认解除与家长「' + parent.username + '」的绑定吗？')) {
      return;
    }
    var nextUsers = auth.replaceUser(users, auth.withoutBoundStudent(parent));
    if (!store.saveUsers(nextUsers)) {
      window.alert('本地存储写入失败，请重试');
      return;
    }
    renderInviteSection();
  }

  // ---------- 智能分类推荐（线八 T22–T24）----------

  /** 商户或备注键入文本 → 实时匹配词典（无命中不出卡） */
  function onRecommendInput() {
    var merchant = $('bill-merchant') ? $('bill-merchant').value : '';
    var note = $('bill-note') ? $('bill-note').value : '';
    showRecommendCard(recommend.recommend(merchant + ' ' + note));
  }

  function showRecommendCard(rec) {
    currentRec = rec;
    var el = $('recommend-card');
    if (!el) {
      return;
    }
    if (!rec) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = '智能推荐：' + escapeHtml(rec.reason) +
      ' <button type="button" data-rec-action="adopt">采纳</button>' +
      ' <button type="button" data-rec-action="ignore">忽略</button>';
  }

  /** T23 采纳：只动表单（分类 + 标签），用户仍可再改；T24 忽略：不改表单任何字段 */
  function onRecommendCardClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[data-rec-action]') : null;
    if (!btn || !currentRec) {
      return;
    }
    if (btn.getAttribute('data-rec-action') === 'adopt') {
      if (stats.CATEGORIES.indexOf(currentRec.category) !== -1) {
        $('bill-category').value = currentRec.category;
      }
      var radio = document.querySelector('input[name="bill-tag"][value="' + currentRec.tag + '"]');
      if (radio) {
        radio.checked = true;
      }
    }
    showRecommendCard(null); // 采纳后收起 / 忽略后收起；推荐永不直接落库
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
      setTip('form-error', '请输入大于 0 的合法金额，例如 12.50', true);
      return;
    }
    var cents = Math.round(yuan * 100);
    if (cents < 1) {
      setTip('form-error', '金额太小，最小支持 0.01 元', true);
      return;
    }

    // 日期：合法 YYYY-MM-DD
    var date = $('bill-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date.replace(/-/g, '/')).getTime())) {
      setTip('form-error', '请选择合法的日期', true);
      return;
    }

    // 分类：必须从 6 个枚举中选
    var category = $('bill-category').value;
    if (stats.CATEGORIES.indexOf(category) === -1) {
      setTip('form-error', '请选择消费分类', true);
      return;
    }

    // 标签：刚性/冲动必选，系统不自动判定
    var tagInput = document.querySelector('input[name="bill-tag"]:checked');
    if (!tagInput) {
      setTip('form-error', '请选择消费标签（刚性 / 冲动）', true);
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
    var nextBills = [bill].concat(state.bills);
    if (!store.saveUserBills(state.user.username, nextBills)) {
      // 配额写满：提示且不更新内存态，不静默丢数据
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    state.bills = nextBills;
    resetBillForm();
    renderStudentData();
  }

  /** 保存成功后清空表单，日期恢复为今天，推荐卡收起 */
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
    showRecommendCard(null);
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
    for (var i = 0; i < state.bills.length; i++) {
      if (state.bills[i].id !== id) {
        nextBills.push(state.bills[i]);
      }
    }
    if (!store.saveUserBills(state.user.username, nextBills)) {
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    state.bills = nextBills;
    renderStudentData();
  }

  // ---------- 渲染 ----------

  function renderStudentData() {
    renderList();
    renderMonthlyStats();
    renderAccounts();
  }

  /** 账单列表：全部历史账单（统计只算本月，见 A1） */
  function renderList() {
    var ul = $('bill-list');
    if (state.bills.length === 0) {
      ul.innerHTML = '<li class="empty">暂无账单，先在上方记一笔吧。</li>';
    } else {
      var html = '';
      for (var i = 0; i < state.bills.length; i++) {
        var b = state.bills[i];
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
    // 列表区的"本月合计"与饼图/洞察同口径（本月），避免"列表和统计对不上"的困惑
    var monthBills = stats.filterByCurrentMonth(state.bills, new Date());
    $('list-total').textContent =
      '本月合计：' + fmt(stats.sumAmounts(monthBills)) + ' 元（统计范围为本月，下方列表展示全部 ' + state.bills.length + ' 条历史账单）';
  }

  /** 本月统计：饼图 + AI 消费洞察（每次视图重算即时生成，纯函数，无持久化） */
  function renderMonthlyStats() {
    var monthBills = stats.filterByCurrentMonth(state.bills, new Date());
    var ratios = stats.computeRatios(monthBills);
    var totalEl = $('month-total');
    if (totalEl) {
      totalEl.textContent = fmt(ratios.total_cents) + ' 元';
    }
    renderPieChart(monthBills, ratios);
    renderInsightsList();
  }

  /** AI 消费洞察区（v2：替代 v1 固定 3 条建议） */
  function renderInsightsList() {
    var ul = $('insight-list');
    if (!ul) {
      return;
    }
    var list = insights.generateInsights(state.bills, state.accounts, new Date());
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<li>' + escapeHtml(list[i]) + '</li>';
    }
    ul.innerHTML = html;
  }

  /** 饼图：本月无账单显示空态文案，不画空图、不报错；有数据则销毁重建 */
  function renderPieChart(monthBills, ratios) {
    var canvas = $('pie-chart');
    var emptyEl = $('pie-empty');
    if (!canvas || !emptyEl) {
      return;
    }

    destroyPieChart();

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
      setTip('account-error', '账户名称不能为空且不超过 10 个字', true);
      return;
    }
    var yuan = parseFloat($('acc-balance').value);
    if (!isFinite(yuan) || yuan < 0) {
      setTip('account-error', '余额需为不小于 0 的数字，例如 320 或 100.50', true);
      return;
    }
    var account = {
      id: store.generateId(),
      name: name,
      balance_cents: Math.round(yuan * 100)
    };
    var nextAccounts = state.accounts.concat([account]);
    if (!store.saveUserAccounts(state.user.username, nextAccounts)) {
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    state.accounts = nextAccounts;
    $('acc-name').value = '';
    $('acc-balance').value = '';
    renderStudentData();
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
      setTip('account-error', '余额需为不小于 0 的数字', true);
      return;
    }
    var nextAccounts = [];
    for (var i = 0; i < state.accounts.length; i++) {
      var acc = state.accounts[i];
      if (acc.id === id) {
        // 创建新对象而非原地改，保证只有保存成功后才更新内存态
        acc = { id: acc.id, name: acc.name, balance_cents: Math.round(yuan * 100) };
      }
      nextAccounts.push(acc);
    }
    if (!store.saveUserAccounts(state.user.username, nextAccounts)) {
      window.alert('本地存储已满，请删除部分旧账单');
      return;
    }
    state.accounts = nextAccounts;
    setTip('account-error', '');
    renderStudentData();
  }

  function renderAccounts() {
    var ul = $('account-list');
    if (state.accounts.length === 0) {
      ul.innerHTML = '<li class="empty">暂无账户，添加微信 / 支付宝 / 现金试试。</li>';
    } else {
      var html = '';
      for (var i = 0; i < state.accounts.length; i++) {
        var a = state.accounts[i];
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
    $('total-assets').textContent = fmt(stats.sumAccounts(state.accounts)) + ' 元';
  }

  // ---------- 语音口述（T6/T7/T8，v2 追加推荐联动）----------

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

  /**
   * 识别成功：只预填表单（草稿），绝不直接落库；
   * 预填成功后对识别文本触发一次 recommend 匹配并展示推荐卡（v2 5.4①）
   */
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
    // 推荐联动：对识别文本（备注/商户语义）匹配一次词典
    if (parsed.note) {
      showRecommendCard(recommend.recommend(parsed.note));
    }
  }

  function onSpeechError(message) {
    setTip('speech-tip', message);
  }

  // ==================================================================
  // 家长视图：未绑定 → 绑定引导页；已绑定 → 只读视图（DOM 无任何写入口）
  // ==================================================================

  function renderParentView() {
    if (!state.user.bound_student) {
      renderParentGuide();
      return;
    }
    var users = store.loadUsers();
    var student = auth.findUser(users, state.user.bound_student);
    if (!student || student.role !== auth.ROLE_STUDENT) {
      // 绑定的学生账号被手工从存储删除：按未绑定处理（v2 3.3⑥ 同源思路）
      var nextUsers = auth.replaceUser(users, auth.withoutBoundStudent(state.user));
      store.saveUsers(nextUsers);
      state.user = auth.findUser(nextUsers, state.user.username);
      renderParentGuide();
      return;
    }
    // 实时读绑定学生当前 per-user 数据重算（F7：不复制快照，每次进入重算）
    state.bills = store.loadUserBills(student.username);
    state.accounts = store.loadUserAccounts(student.username);
    renderMain(parentReadonlyHtml(student.username));
    bindParentReadonlyEvents();
    renderParentData();
    showPendingTip();
  }

  /** 家长绑定引导页（未绑定时）：只有邀请码输入与退出登录，无任何学生数据区 */
  function parentGuideHtml() {
    return '<section class="card auth-card">' +
      '<div class="view-head">' +
        '<h2>家长视图 · 绑定学生</h2>' +
        '<button type="button" id="logout-btn">退出登录</button>' +
      '</div>' +
      '<p class="scope-note">请向孩子索取 6 位数字邀请码，输入并绑定后即可查看其本月消费总览（只读，实时数据）。</p>' +
      '<p class="tip" id="view-tip" style="display:none;"></p>' +
      '<form id="bind-form" novalidate>' +
        '<div class="form-row"><label for="parent-code">邀请码</label>' +
        '<input type="text" id="parent-code" maxlength="6" inputmode="numeric" placeholder="6 位数字" /></div>' +
        '<div class="form-actions"><button type="submit" class="btn-primary">绑定</button></div>' +
        '<p class="tip error" id="bind-error" style="display:none;"></p>' +
      '</form>' +
    '</section>';
  }

  function renderParentGuide() {
    renderMain(parentGuideHtml());
    $('logout-btn').addEventListener('click', onLogoutClick);
    $('bind-form').addEventListener('submit', onBindSubmit);
    showPendingTip();
  }

  /** 家长输入邀请码绑定（T16/T17）：码一次性使用，绑定成功即清空学生码 */
  function onBindSubmit(e) {
    e.preventDefault();
    setTip('bind-error', '');
    var code = $('parent-code').value.trim();
    var users = store.loadUsers();
    // 重新取当前家长记录，避免内存态过期
    var parent = auth.findUser(users, state.user.username);
    var result = auth.validateBinding(users, code, parent);
    if (!result.ok) {
      setTip('bind-error', result.message, true);
      return;
    }
    var student = result.student;
    var nextUsers = users.slice();
    for (var i = 0; i < nextUsers.length; i++) {
      if (nextUsers[i].username === parent.username) {
        nextUsers[i] = auth.withBoundStudent(nextUsers[i], student.username);
      } else if (nextUsers[i].username === student.username) {
        nextUsers[i] = auth.withInviteCode(nextUsers[i], null); // 一次性：绑定成功即失效
      }
    }
    if (!store.saveUsers(nextUsers)) {
      setTip('bind-error', '绑定失败：本地存储写入失败，请重试', true);
      return;
    }
    state.user = auth.findUser(nextUsers, parent.username);
    route(); // 绑定成功 → 家长只读视图（T17）
  }

  /** 家长只读视图：饼图 + 洞察 + 总资产；DOM 中不存在任何录入/删除/修改入口 */
  function parentReadonlyHtml(studentName) {
    return '' +
      '<section class="card" id="section-welcome">' +
        '<div class="view-head">' +
          '<h2>「' + escapeHtml(studentName) + '」的本月消费总览（家长只读）</h2>' +
          '<button type="button" id="logout-btn">退出登录</button>' +
        '</div>' +
        '<p class="scope-note">只读视图：页面中没有任何录入、删除或修改入口；数据为绑定学生的实时当月数据。</p>' +
        '<p class="tip" id="view-tip" style="display:none;"></p>' +
        '<button type="button" id="parent-unbind-btn">解除绑定</button>' +
      '</section>' +
      '<section class="card" id="section-stats">' +
        '<h2>本月支出分类饼图</h2>' +
        '<p class="month-total">本月支出合计：<strong id="month-total"></strong></p>' +
        '<div class="pie-wrap">' +
          '<canvas id="pie-chart" width="320" height="320"></canvas>' +
          '<p class="empty" id="pie-empty" style="display:none;">本月暂无账单，饼图将在孩子记账后自动生成。</p>' +
        '</div>' +
      '</section>' +
      '<section class="card" id="section-insights">' +
        '<h2>AI 消费洞察</h2>' +
        '<ul id="insight-list" class="advice-list"></ul>' +
      '</section>' +
      '<section class="card" id="section-assets">' +
        '<h2>总资产</h2>' +
        '<p class="total-assets">总资产：<strong id="total-assets">0.00 元</strong></p>' +
      '</section>';
  }

  function bindParentReadonlyEvents() {
    $('logout-btn').addEventListener('click', onLogoutClick);
    // 家长解绑（T18）：confirm 确认；学生的邀请码不会自动恢复
    $('parent-unbind-btn').addEventListener('click', onParentUnbind);
  }

  function renderParentData() {
    renderMonthlyStats();
    $('total-assets').textContent = fmt(stats.sumAccounts(state.accounts)) + ' 元';
  }

  function onParentUnbind() {
    if (!window.confirm('确认解除与孩子「' + state.user.bound_student + '」的绑定吗？')) {
      return;
    }
    var users = store.loadUsers();
    var nextUsers = auth.replaceUser(users, auth.withoutBoundStudent(state.user));
    if (!store.saveUsers(nextUsers)) {
      window.alert('本地存储写入失败，请重试');
      return;
    }
    route(); // 解绑后回绑定引导页（T18）
  }

  // ---------- 启动 ----------

  function init() {
    store.ensureSchemaVersion();
    route();
  }

  // DOMContentLoaded 后启动（脚本在 body 底部以经典 script 引入，此守卫双保险）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
