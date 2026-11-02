/**
 * store.js —— localStorage 读写与校验
 *
 * 设计约束（需求书 5.2）：
 * - 全项目唯一允许读写 localStorage 的文件
 * - 三个独立键：schema_version / bills / accounts（6.1，不做单一大对象）
 * - 读取兼容（6.2）：schema_version 缺失或不认识、JSON 解析失败、类型不对 → 重置空状态，页面绝不崩溃
 * - 保存时捕获配额错误（QuotaExceededError）：返回 false，由 app.js 弹 alert，不静默丢数据
 * - id 规则：时间戳(YYYYMMDDHHmmss)-6位随机
 */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var KEY_VERSION = 'schema_version';
  var KEY_BILLS = 'bills';
  var KEY_ACCOUNTS = 'accounts';

  var ID_RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

  /** 列表按 created_at 倒序（新的在上），全项目固定这一种排序 */
  function sortByCreatedDesc(list) {
    return list.slice().sort(function (a, b) {
      return b.created_at - a.created_at;
    });
  }

  function persistBills(bills) {
    return setItem(KEY_BILLS, JSON.stringify(bills));
  }

  function persistAccounts(accounts) {
    return setItem(KEY_ACCOUNTS, JSON.stringify(accounts));
  }

  /** 重置为空状态（schema_version=1，两个空数组），见需求书 6.2 读取兼容规则 */
  function resetAll() {
    removeItem(KEY_BILLS);
    removeItem(KEY_ACCOUNTS);
    persistBills([]);
    persistAccounts([]);
    setItem(KEY_VERSION, String(SCHEMA_VERSION));
  }

  /**
   * 初始化读取三个键，返回内存态数据。任何异常路径都以空状态兜底，绝不抛错。
   * @returns {{bills:Array, accounts:Array}}
   */
  function loadAll() {
    var rawVersion = getItem(KEY_VERSION);
    var version = Number(rawVersion);
    if (rawVersion === null || !isFinite(version) || version !== SCHEMA_VERSION) {
      resetAll();
      return { bills: [], accounts: [] };
    }

    var bills = [];
    var rawBills = parseJsonArray(getItem(KEY_BILLS));
    if (rawBills === null) {
      persistBills(bills); // 损坏即重写空数组
    } else {
      for (var i = 0; i < rawBills.length; i++) {
        var bill = normalizeBill(rawBills[i]);
        if (bill) {
          bills.push(bill);
        }
      }
      bills = sortByCreatedDesc(bills);
    }

    var accounts = [];
    var rawAccounts = parseJsonArray(getItem(KEY_ACCOUNTS));
    if (rawAccounts === null) {
      persistAccounts(accounts);
    } else {
      for (var j = 0; j < rawAccounts.length; j++) {
        var account = normalizeAccount(rawAccounts[j]);
        if (account) {
          accounts.push(account);
        }
      }
    }
    return { bills: bills, accounts: accounts };
  }

  /**
   * 保存账单数组（整包覆盖写）。
   * @param {Array} bills
   * @returns {boolean} false 表示写入失败（配额满等），调用方须提示且不得更新内存态
   */
  function saveBills(bills) {
    return persistBills(bills);
  }

  /**
   * 保存账户数组（整包覆盖写）。
   * @param {Array} accounts
   * @returns {boolean} false 表示写入失败，调用方须提示
   */
  function saveAccounts(accounts) {
    return persistAccounts(accounts);
  }

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

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  root.LedgerStore = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    KEY_VERSION: KEY_VERSION,
    KEY_BILLS: KEY_BILLS,
    KEY_ACCOUNTS: KEY_ACCOUNTS,
    loadAll: loadAll,
    saveBills: saveBills,
    saveAccounts: saveAccounts,
    generateId: generateId
  };
})(typeof self !== 'undefined' ? self : this);
