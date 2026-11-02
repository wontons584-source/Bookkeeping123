/**
 * store.js —— localStorage / sessionStorage 读写与校验（v2 多账号版）
 *
 * 设计约束（v1 需求书 5.2 + v2 增量需求书 5.3/5.5/6.1/6.3）：
 * - 全项目唯一允许读写 localStorage 与 sessionStorage 的文件
 * - v2 键结构：schema_version=2 / ledger_v2:users / ledger_v2:{用户名}:bills / :accounts /
 *   ledger_v2:session（sessionStorage）
 * - per-user 键名一律经统一函数 userKey(username, kind) 拼装，禁止多处手拼
 * - v1 旧全局键 bills / accounts 只允许出现在迁移逻辑（getV1Raw / migrateV1ToUser）中
 * - 数据损坏检测下沉到 per-user 级别：某学生的键损坏只重置该学生的数据，不波及他人
 * - 保存失败（含配额满）返回 false，由 app.js 弹提示，不静默丢数据
 * - 迁移顺序钉死（PRD 6.3）：先写 per-user 键 → 写入确认成功后才删旧键
 */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 2;
  var KEY_VERSION = 'schema_version';
  var KEY_USERS = 'ledger_v2:users';
  var KEY_SESSION = 'ledger_v2:session';
  var USER_KEY_PREFIX = 'ledger_v2:';

  /** per-user 键的 kind 枚举（配合 userKey 统一拼装） */
  var USER_KEY_KINDS = { BILLS: 'bills', ACCOUNTS: 'accounts' };

  // v1 旧全局键：仅在下方迁移逻辑（getV1Raw / migrateV1ToUser）中出现
  var V1_KEY_BILLS = 'bills';
  var V1_KEY_ACCOUNTS = 'accounts';

  var ROLES = ['学生', '家长'];

  var ID_RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

  // ---------- localStorage 安全读写 ----------

  /** 安全读取：localStorage 被禁用/隐私模式抛异常时按"无数据"处理 */
  function getItem(key) {
    try {
      return root.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  /** 安全写入：返回 false 表示写入失败（含配额满 QuotaExceededError） */
  function setItem(key, value) {
    try {
      root.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeItem(key) {
    try {
      root.localStorage.removeItem(key);
    } catch (e) {
      /* 忽略：删除失败不影响空状态判定 */
    }
  }

  // ---------- sessionStorage 安全读写（登录态，v2 5.3） ----------

  function getSessionItem(key) {
    try {
      return root.sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function setSessionItem(key, value) {
    try {
      root.sessionStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeSessionItem(key) {
    try {
      root.sessionStorage.removeItem(key);
    } catch (e) {
      /* 忽略 */
    }
  }

  // ---------- 通用工具 ----------

  /** JSON 解析并要求数组类型；任何失败返回 null（由调用方决定重置） */
  function parseJsonArray(raw) {
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      var value = JSON.parse(raw);
      return Array.isArray(value) ? value : null;
    } catch (e) {
      return null;
    }
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** 列表按 created_at 倒序（新的在上），全项目固定这一种排序 */
  function sortByCreatedDesc(list) {
    return list.slice().sort(function (a, b) {
      return b.created_at - a.created_at;
    });
  }

  /**
   * 统一的 per-user 键拼装函数（v2 5.5：禁止在别处手写字符串拼接）。
   * 用户名注册时已禁止冒号与前后空格，键拼装无歧义。
   * @param {string} username
   * @param {string} kind USER_KEY_KINDS 之一
   * @returns {string} 形如 "ledger_v2:linxiao:bills"
   */
  function userKey(username, kind) {
    return USER_KEY_PREFIX + username + ':' + kind;
  }

  // ---------- 账单 / 账户字段校验（与 v1 完全一致，字段结构不变） ----------

  /**
   * 账单字段校验与规范化：类型不对的条目直接剔除，保证下游拿到的一定是合法形状
   * @param {*} item
   * @returns {Object|null}
   */
  function normalizeBill(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    if (typeof item.id !== 'string' || !item.id) {
      return null;
    }
    if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      return null;
    }
    var cents = Number(item.amount_cents);
    if (!isFinite(cents) || Math.round(cents) < 1) {
      return null;
    }
    if (typeof item.category !== 'string' || !item.category) {
      return null;
    }
    if (typeof item.tag !== 'string' || !item.tag) {
      return null;
    }
    var createdAt = Number(item.created_at);
    if (!isFinite(createdAt)) {
      return null;
    }
    return {
      id: item.id,
      date: item.date,
      amount_cents: Math.round(cents),
      merchant: typeof item.merchant === 'string' ? item.merchant : '',
      category: item.category,
      tag: item.tag,
      note: typeof item.note === 'string' ? item.note : '',
      created_at: Math.round(createdAt)
    };
  }

  /**
   * 账户字段校验与规范化（余额 ≥ 0，与账单不联动）
   * @param {*} item
   * @returns {Object|null}
   */
  function normalizeAccount(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    if (typeof item.id !== 'string' || !item.id) {
      return null;
    }
    if (typeof item.name !== 'string' || !item.name) {
      return null;
    }
    var cents = Number(item.balance_cents);
    if (!isFinite(cents) || Math.round(cents) < 0) {
      return null;
    }
    return {
      id: item.id,
      name: item.name,
      balance_cents: Math.round(cents)
    };
  }

  // ---------- users 表（v2 6.2） ----------

  /**
   * 用户记录字段校验与规范化：
   * - 学生：bound_student 恒为 null（绑定关系唯一存放在家长记录，禁止双写）
   * - 家长：invite_code 恒为 null（码只属于学生角色）
   * @param {*} item
   * @returns {Object|null}
   */
  function normalizeUser(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    if (typeof item.username !== 'string' || !item.username) {
      return null;
    }
    if (item.username.length > 20 || item.username.indexOf(':') !== -1) {
      return null;
    }
    if (typeof item.password_hash !== 'string' || !item.password_hash) {
      return null;
    }
    if (ROLES.indexOf(item.role) === -1) {
      return null;
    }
    var createdAt = Number(item.created_at);
    if (!isFinite(createdAt)) {
      return null;
    }
    var inviteCode = (typeof item.invite_code === 'string' && /^\d{6}$/.test(item.invite_code))
      ? item.invite_code : null;
    var boundStudent = (typeof item.bound_student === 'string' && item.bound_student)
      ? item.bound_student : null;
    if (item.role === '学生') {
      boundStudent = null;
    }
    if (item.role === '家长') {
      inviteCode = null;
    }
    return {
      username: item.username,
      password_hash: item.password_hash,
      role: item.role,
      created_at: Math.round(createdAt),
      invite_code: inviteCode,
      bound_student: boundStudent
    };
  }

  function normalizeUsers(list) {
    var users = [];
    for (var i = 0; i < list.length; i++) {
      var user = normalizeUser(list[i]);
      if (user) {
        users.push(user);
      }
    }
    return users;
  }

  /**
   * 读取 users 表。表损坏（非法 JSON / 非数组）→ 重置为空表，
   * 会话随之失效按未登录处理（v2 3.3⑥），页面绝不崩溃。
   * @returns {Array}
   */
  function loadUsers() {
    var raw = getItem(KEY_USERS);
    var parsed = parseJsonArray(raw);
    if (parsed === null) {
      if (raw !== null) {
        setItem(KEY_USERS, '[]'); // 仅在确有损坏内容时重写，避免污染"全新无数据"状态
      }
      return [];
    }
    return normalizeUsers(parsed);
  }

  /**
   * 整包保存 users 表（先组装完整对象再一次写入，见 v2 3.3⑤）。
   * @param {Array} users
   * @returns {boolean} false 表示写入失败，调用方须提示且不得更新内存态
   */
  function saveUsers(users) {
    return setItem(KEY_USERS, JSON.stringify(users));
  }

  // ---------- per-user 账单 / 账户（v2 6.1） ----------

  /**
   * 读取某学生的账单。键损坏（非法 JSON）→ 只重置该学生的键并返回空数组，
   * 不波及其他学生（v2 3.3"损坏检测下沉到 per-user 级别"）。
   * @param {string} username
   * @returns {Array}
   */
  function loadUserBills(username) {
    var key = userKey(username, USER_KEY_KINDS.BILLS);
    var raw = getItem(key);
    var parsed = parseJsonArray(raw);
    if (parsed === null) {
      if (raw !== null) {
        setItem(key, '[]'); // 该学生键损坏 → 仅重置该学生的数据
      }
      return [];
    }
    var bills = [];
    for (var i = 0; i < parsed.length; i++) {
      var bill = normalizeBill(parsed[i]);
      if (bill) {
        bills.push(bill);
      }
    }
    return sortByCreatedDesc(bills);
  }

  /**
   * 保存某学生的账单数组（整包覆盖写）。
   * @param {string} username
   * @param {Array} bills
   * @returns {boolean} false 表示写入失败（配额满等），调用方须提示且不得更新内存态
   */
  function saveUserBills(username, bills) {
    return setItem(userKey(username, USER_KEY_KINDS.BILLS), JSON.stringify(bills));
  }

  /**
   * 读取某学生的账户（损坏处理同 loadUserBills）。
   * @param {string} username
   * @returns {Array}
   */
  function loadUserAccounts(username) {
    var key = userKey(username, USER_KEY_KINDS.ACCOUNTS);
    var raw = getItem(key);
    var parsed = parseJsonArray(raw);
    if (parsed === null) {
      if (raw !== null) {
        setItem(key, '[]');
      }
      return [];
    }
    var accounts = [];
    for (var i = 0; i < parsed.length; i++) {
      var account = normalizeAccount(parsed[i]);
      if (account) {
        accounts.push(account);
      }
    }
    return accounts;
  }

  /**
   * 保存某学生的账户数组（整包覆盖写）。
   * @param {string} username
   * @param {Array} accounts
   * @returns {boolean} false 表示写入失败，调用方须提示
   */
  function saveUserAccounts(username, accounts) {
    return setItem(userKey(username, USER_KEY_KINDS.ACCOUNTS), JSON.stringify(accounts));
  }

  // ---------- 会话（sessionStorage，v2 5.3） ----------

  /**
   * 读取登录会话。格式不合法返回 null（调用方按未登录处理）。
   * @returns {{username:string, role:string}|null}
   */
  function readSession() {
    var raw = getSessionItem(KEY_SESSION);
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      var value = JSON.parse(raw);
      if (value && typeof value === 'object' &&
          typeof value.username === 'string' && typeof value.role === 'string') {
        return { username: value.username, role: value.role };
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * 写入登录会话 { username, role }。
   * @param {{username:string, role:string}} session
   * @returns {boolean}
   */
  function writeSession(session) {
    return setSessionItem(KEY_SESSION, JSON.stringify(session));
  }

  /** 清除登录会话（登出 / 无效会话清理） */
  function clearSession() {
    removeSessionItem(KEY_SESSION);
  }

  // ---------- v1 数据迁移（PRD 6.3，顺序钉死：先写后删） ----------

  /**
   * 读取 v1 旧全局键的原始字符串（不做解析，解析决策在 auth.decideV1Migration）。
   * 这是旧键名 bills / accounts 在本文件中唯一被"读"的位置。
   * @returns {{bills:string|null, accounts:string|null}}
   */
  function getV1Raw() {
    return {
      bills: getItem(V1_KEY_BILLS),
      accounts: getItem(V1_KEY_ACCOUNTS)
    };
  }

  /**
   * 把解析好的旧数据整体写入指定学生的 per-user 键；两处写入都确认成功后
   * 才删除 v1 旧键（PRD 6.3-2 顺序不可换）。任一步失败 → 旧键原样保留可重试。
   * 这是旧键名 bills / accounts 在本文件中唯一被"删"的位置。
   * @param {string} username 目标学生用户名
   * @param {Array} bills 旧账单数组（已由决策函数解析）
   * @param {Array} accounts 旧账户数组（已由决策函数解析）
   * @returns {boolean} 是否迁移成功
   */
  function migrateV1ToUser(username, bills, accounts) {
    var okBills = setItem(userKey(username, USER_KEY_KINDS.BILLS), JSON.stringify(bills || []));
    var okAccounts = setItem(userKey(username, USER_KEY_KINDS.ACCOUNTS), JSON.stringify(accounts || []));
    if (!(okBills && okAccounts)) {
      return false; // 写入失败：旧键保留，该学生账号保持空状态（T21）
    }
    removeItem(V1_KEY_BILLS);
    removeItem(V1_KEY_ACCOUNTS);
    setItem(KEY_VERSION, String(SCHEMA_VERSION));
    return true;
  }

  /**
   * 版本号维护：无待迁移旧数据时把 schema_version 升到 2；
   * 存在 v1 旧键（待迁移）时暂不动版本号，待迁移成功后由 migrateV1ToUser 写入。
   */
  function ensureSchemaVersion() {
    var raw = getItem(KEY_VERSION);
    if (raw === String(SCHEMA_VERSION)) {
      return;
    }
    var oldRaw = getV1Raw();
    if (oldRaw.bills !== null || oldRaw.accounts !== null) {
      return; // 有待迁移旧数据：保留现场，等待首个学生注册触发迁移
    }
    setItem(KEY_VERSION, String(SCHEMA_VERSION));
  }

  // ---------- id 生成（与 v1 一致） ----------

  /**
   * 生成唯一 id：时间戳(YYYYMMDDHHmmss)-6位随机，如 "20261022143059-a1b2c3"
   * 账单与账户共用此规则（6.2）。
   * @returns {string}
   */
  function generateId() {
    var d = new Date();
    var ts = '' + d.getFullYear() +
      pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    var rand = '';
    for (var i = 0; i < 6; i++) {
      rand += ID_RANDOM_CHARS.charAt(Math.floor(Math.random() * ID_RANDOM_CHARS.length));
    }
    return ts + '-' + rand;
  }

  root.LedgerStore = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    KEY_VERSION: KEY_VERSION,
    KEY_USERS: KEY_USERS,
    KEY_SESSION: KEY_SESSION,
    USER_KEY_PREFIX: USER_KEY_PREFIX,
    USER_KEY_KINDS: USER_KEY_KINDS,
    ROLES: ROLES,
    userKey: userKey,
    loadUsers: loadUsers,
    saveUsers: saveUsers,
    normalizeUser: normalizeUser,
    loadUserBills: loadUserBills,
    saveUserBills: saveUserBills,
    loadUserAccounts: loadUserAccounts,
    saveUserAccounts: saveUserAccounts,
    readSession: readSession,
    writeSession: writeSession,
    clearSession: clearSession,
    getV1Raw: getV1Raw,
    migrateV1ToUser: migrateV1ToUser,
    ensureSchemaVersion: ensureSchemaVersion,
    generateId: generateId
  };
})(typeof self !== 'undefined' ? self : this);
