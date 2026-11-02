/**
 * auth.js —— 注册/登录校验、密码哈希、会话管理、邀请码生成（v2 新增）
 *
 * 设计约束（v2 增量需求书 5.1/5.2/5.3/6.2/6.3）：
 * - 纯逻辑模块：不碰 DOM、不碰 localStorage / sessionStorage（存储统一经 store.js，
 *   由 app.js 编排调用）；不依赖 app 和 store，UMD 双环境（Node require 供测试）
 * - 密码哈希：首选 crypto.subtle SHA-256（异步）；环境不可用时退化为内置纯 JS SHA-256。
 *   两条路径都是标准 SHA-256，输出完全一致 → 同一密码每次结果确定（退化确定性是命门）
 *   注意：本实现课程演示用途，非生产级安全；无盐、无慢哈希，生产环境禁止照搬
 * - 注册校验规则钉死（6.2）：用户名非空、≤20 字、禁含冒号、无前后空格、不重名；
 *   密码 6–20 位；角色必选（学生/家长）
 * - 迁移决策三态（纯函数）：旧数据合法→迁、不存在→跳过、损坏→跳过不崩
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LedgerAuth = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ROLES = ['学生', '家长'];
  var ROLE_STUDENT = '学生';
  var ROLE_PARENT = '家长';

  var USERNAME_MAX = 20;
  var PASSWORD_MIN = 6;
  var PASSWORD_MAX = 20;
  var INVITE_CODE_LENGTH = 6;

  // ==================================================================
  // 密码哈希：标准 SHA-256。
  // 课程演示用途，非生产级安全；无盐、无慢哈希，生产环境禁止照搬。
  // 首选 crypto.subtle（浏览器 / Node webcrypto）；不可用时退化为下方纯 JS
  // 实现——两种路径输出同一 SHA-256 十六进制串，保证确定性。
  // ==================================================================

  /** SHA-256 轮函数常量 K（FIPS 180-4） */
  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  /**
   * UTF-8 编码字符串 → 字节数组（与 TextEncoder 结果一致，含增补平面字符处理）
   * @param {string} str
   * @returns {number[]}
   */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff) {
        // 代理对：与下一个 16 位单元组合成增补平面码点
        var lo = (i + 1 < str.length) ? str.charCodeAt(i + 1) : 0;
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          var cp = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else {
          // 孤立高代理 → UTF-8 替换字符 U+FFFD，保证确定性
          out.push(0xef, 0xbf, 0xbd);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        out.push(0xef, 0xbf, 0xbd); // 孤立低代理 → 替换字符
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return out;
  }

  /**
   * 纯 JS SHA-256（确定性退化实现）：输入字节数组，输出 64 位十六进制小写串
   * @param {number[]} bytes
   * @returns {string}
   */
  function sha256HexFromBytes(bytes) {
    var H = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var len = bytes.length;

    // 消息填充：追加 0x80，补 0 到 length ≡ 56 (mod 64)，再追加 64 位大端比特长度
    var padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) {
      padded.push(0);
    }
    var lenHi = Math.floor(len / 0x20000000);              // len*8 的高 32 位
    var lenLo = (len % 0x20000000) * 8;                    // len*8 的低 32 位
    padded.push((lenHi >>> 24) & 0xff, (lenHi >>> 16) & 0xff, (lenHi >>> 8) & 0xff, lenHi & 0xff);
    padded.push((lenLo >>> 24) & 0xff, (lenLo >>> 16) & 0xff, (lenLo >>> 8) & 0xff, lenLo & 0xff);

    var w = new Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      var t;
      for (t = 0; t < 16; t++) {
        w[t] = ((padded[off + t * 4] << 24) | (padded[off + t * 4 + 1] << 16) |
                (padded[off + t * 4 + 2] << 8) | padded[off + t * 4 + 3]) | 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e;
        e = (d + temp1) | 0;
        d = c; c = b; b = a;
        a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var hex = '';
    for (var i = 0; i < 8; i++) {
      hex += ('00000000' + ((H[i] >>> 0).toString(16))).slice(-8);
    }
    return hex;
  }

  /**
   * 同步哈希入口（退化路径）：任意环境确定可用、确定性输出
   * @param {string} text
   * @returns {string} 64 位十六进制小写串
   */
  function sha256HexSync(text) {
    return sha256HexFromBytes(utf8Bytes(String(text)));
  }

  function bytesToHex(uint8) {
    var hex = '';
    for (var i = 0; i < uint8.length; i++) {
      hex += ('0' + uint8[i].toString(16)).slice(-2);
    }
    return hex;
  }

  /**
   * 获取可用的 crypto.subtle：Node 下用 webcrypto，浏览器下用 window.crypto；
   * 都不可用（或访问抛异常）返回 null → 走纯 JS 退化路径
   * @returns {SubtleCrypto|null}
   */
  function getCryptoSubtle() {
    try {
      if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
        var nc = require('crypto');
        if (nc && nc.webcrypto && nc.webcrypto.subtle) {
          return nc.webcrypto.subtle;
        }
      }
    } catch (e) {
      /* 忽略：继续探测浏览器路径 */
    }
    try {
      if (root.crypto && root.crypto.subtle) {
        return root.crypto.subtle;
      }
    } catch (e) {
      /* 忽略 */
    }
    return null;
  }

  /**
   * 密码哈希（异步接口，两条路径输出一致的标准 SHA-256 十六进制串）。
   * 课程演示用途，非生产级安全；无盐、无慢哈希，生产环境禁止照搬。
   * @param {string} password
   * @returns {Promise<string>} 64 位十六进制小写串
   */
  function hashPassword(password) {
    var subtle = getCryptoSubtle();
    if (subtle) {
      var bytes = new Uint8Array(utf8Bytes(String(password)));
      return subtle.digest('SHA-256', bytes).then(function (buf) {
        return bytesToHex(new Uint8Array(buf));
      });
    }
    return Promise.resolve(sha256HexSync(password));
  }

  /**
   * 密码校验：输入密码走同一哈希函数后与存储值比对
   * @param {string} password
   * @param {string} storedHash
   * @returns {Promise<boolean>}
   */
  function verifyPassword(password, storedHash) {
    return hashPassword(password).then(function (hash) {
      return hash === storedHash;
    });
  }

  // ==================================================================
  // 注册校验（PRD 6.2 规则钉死，逐项提示）
  // ==================================================================

  /**
   * @param {string} username
   * @param {Array} [users] 传入则以"不重名"校验
   * @returns {{ok:boolean, message:string}}
   */
  function validateUsername(username, users) {
    if (typeof username !== 'string' || username.length === 0) {
      return { ok: false, message: '用户名不能为空' };
    }
    if (username.length > USERNAME_MAX) {
      return { ok: false, message: '用户名不能超过 ' + USERNAME_MAX + ' 个字' };
    }
    if (username.indexOf(':') !== -1) {
      return { ok: false, message: '用户名不能包含冒号":"（用于键名拼装，需避免歧义）' };
    }
    if (username !== username.trim()) {
      return { ok: false, message: '用户名前后不能有空格' };
    }
    if (users && findUser(users, username)) {
      return { ok: false, message: '用户名已存在' };
    }
    return { ok: true, message: '' };
  }

  /**
   * @param {string} password
   * @returns {{ok:boolean, message:string}}
   */
  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
      return { ok: false, message: '密码不能少于 ' + PASSWORD_MIN + ' 位' };
    }
    if (password.length > PASSWORD_MAX) {
      return { ok: false, message: '密码不能超过 ' + PASSWORD_MAX + ' 位' };
    }
    return { ok: true, message: '' };
  }

  /**
   * @param {string} role
   * @returns {{ok:boolean, message:string}}
   */
  function validateRole(role) {
    if (ROLES.indexOf(role) === -1) {
      return { ok: false, message: '请选择角色（学生 / 家长）' };
    }
    return { ok: true, message: '' };
  }

  /**
   * 注册整体校验：用户名 → 密码 → 角色，返回第一个失败项
   * @param {{username:string, password:string, role:string, users:Array}} input
   * @returns {{ok:boolean, message:string}}
   */
  function validateRegistration(input) {
    input = input || {};
    var checks = [
      validateUsername(input.username, input.users),
      validatePassword(input.password),
      validateRole(input.role)
    ];
    for (var i = 0; i < checks.length; i++) {
      if (!checks[i].ok) {
        return checks[i];
      }
    }
    return { ok: true, message: '' };
  }

  /**
   * 组装完整用户记录（先组装完整对象再一次写入，见 v2 3.3⑤）。
   * 记录中只有 password_hash，任何情况下不出现明文密码（验收 A2）。
   * @param {{username:string, role:string}} input
   * @param {string} passwordHash
   * @param {number} now 毫秒时间戳
   * @returns {{username:string, password_hash:string, role:string, created_at:number, invite_code:null, bound_student:null}}
   */
  function createUser(input, passwordHash, now) {
    return {
      username: input.username,
      password_hash: passwordHash,
      role: input.role,
      created_at: now,
      invite_code: null,
      bound_student: null
    };
  }

  // ==================================================================
  // users 表查询与不可变更新
  // ==================================================================

  /**
   * @param {Array} users
   * @param {string} username
   * @returns {Object|null}
   */
  function findUser(users, username) {
    if (!Array.isArray(users)) {
      return null;
    }
    for (var i = 0; i < users.length; i++) {
      if (users[i] && users[i].username === username) {
        return users[i];
      }
    }
    return null;
  }

  /**
   * 返回替换/新增后的新数组（不可变风格，由调用方负责 saveUsers）
   * @param {Array} users
   * @param {Object} updatedUser
   * @returns {Array}
   */
  function replaceUser(users, updatedUser) {
    var next = [];
    var found = false;
    for (var i = 0; i < users.length; i++) {
      if (users[i] && users[i].username === updatedUser.username) {
        next.push(updatedUser);
        found = true;
      } else {
        next.push(users[i]);
      }
    }
    if (!found) {
      next.push(updatedUser);
    }
    return next;
  }

  /** 返回设置邀请码后的新用户对象（重新生成 = 覆盖，旧码即作废） */
  function withInviteCode(user, code) {
    var next = shallowCopyUser(user);
    next.invite_code = code;
    return next;
  }

  /** 返回建立绑定关系后的新家长对象（绑定关系唯一存放处：家长记录 bound_student） */
  function withBoundStudent(user, studentUsername) {
    var next = shallowCopyUser(user);
    next.bound_student = studentUsername;
    return next;
  }

  /** 返回解除绑定后的新家长对象（学生的邀请码不会自动恢复，需重新生成） */
  function withoutBoundStudent(user) {
    var next = shallowCopyUser(user);
    next.bound_student = null;
    return next;
  }

  function shallowCopyUser(user) {
    return {
      username: user.username,
      password_hash: user.password_hash,
      role: user.role,
      created_at: user.created_at,
      invite_code: user.invite_code,
      bound_student: user.bound_student
    };
  }

  // ==================================================================
  // 会话（纯逻辑；存取在 store.js，见 v2 5.3）
  // ==================================================================

  /**
   * 由登录用户构造会话对象 { username, role }
   * @param {Object} user
   * @returns {{username:string, role:string}}
   */
  function buildSession(user) {
    return { username: user.username, role: user.role };
  }

  /**
   * 会话有效性校验：会话存在、用户仍在 users 表、角色一致。
   * 用户被手工从存储删除时返回 false（按未登录处理，见 v2 3.3⑥）。
   * @param {{username:string, role:string}|null} session
   * @param {Array} users
   * @returns {boolean}
   */
  function isSessionValid(session, users) {
    if (!session || typeof session.username !== 'string' || typeof session.role !== 'string') {
      return false;
    }
    var user = findUser(users, session.username);
    return !!(user && user.role === session.role);
  }

  // ==================================================================
  // 邀请码（线五）与绑定（线六）
  // ==================================================================

  /**
   * 生成 6 位随机数字邀请码，并与全表现有码查重（同一码值全表唯一，6.2）。
   * @param {Array} users 全表（用于查重）
   * @param {function():number} [rand] 可注入的随机源（返回 [0,1)），测试用
   * @returns {string} 6 位数字字符串
   */
  function generateInviteCode(users, rand) {
    rand = rand || Math.random;
    var used = {};
    var i;
    for (i = 0; i < users.length; i++) {
      var code = users[i] && users[i].invite_code;
      if (typeof code === 'string') {
        used[code] = true;
      }
    }
    var code2;
    do {
      code2 = '';
      for (i = 0; i < INVITE_CODE_LENGTH; i++) {
        code2 += String(Math.floor(rand() * 10));
      }
    } while (used[code2]);
    return code2;
  }

  /**
   * 按邀请码找学生。码无效（格式不对/不存在/属于家长）返回 null，
   * 上层统一提示"邀请码无效"，不区分三种情况（v2 3.3⑦）。
   * @param {Array} users
   * @param {string} code
   * @returns {Object|null}
   */
  function findStudentByInviteCode(users, code) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return null;
    }
    for (var i = 0; i < users.length; i++) {
      var user = users[i];
      if (user && user.role === ROLE_STUDENT && user.invite_code === code) {
        return user;
      }
    }
    return null;
  }

  /**
   * 绑定资格校验（T16 条件）：家长未绑定、码有效、目标学生未被其他家长绑定。
   * @param {Array} users
   * @param {string} code
   * @param {Object} parent 发起绑定的家长记录
   * @returns {{ok:boolean, student:Object|null, message:string}}
   */
  function validateBinding(users, code, parent) {
    if (!parent || parent.role !== ROLE_PARENT) {
      return { ok: false, student: null, message: '只有家长账号可以绑定学生' };
    }
    if (parent.bound_student) {
      return { ok: false, student: null, message: '你已绑定学生，请先解绑后再绑定' };
    }
    var student = findStudentByInviteCode(users, code);
    if (!student) {
      return { ok: false, student: null, message: '邀请码无效' };
    }
    if (student.bound_student) {
      return { ok: false, student: null, message: '该学生已绑定家长' };
    }
    return { ok: true, student: student, message: '' };
  }

  /**
   * 反查绑定某学生的家长（学生端绑定状态靠反查得出，不双写 bound_parent）。
   * @param {Array} users
   * @param {string} studentUsername
   * @returns {Object|null}
   */
  function findParentOfStudent(users, studentUsername) {
    if (!Array.isArray(users) || typeof studentUsername !== 'string') {
      return null;
    }
    for (var i = 0; i < users.length; i++) {
      var user = users[i];
      if (user && user.role === ROLE_PARENT && user.bound_student === studentUsername) {
        return user;
      }
    }
    return null;
  }

  // ==================================================================
  // v1 数据迁移决策（纯函数三态，PRD 6.3；实际读写删在 store.js）
  // ==================================================================

  /**
   * 解析 v1 旧键原始 JSON → 数组；损坏/类型不对返回 null
   * @param {string|null} raw
   * @returns {Array|null}
   */
  function parseV1Array(raw) {
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
   * 迁移决策三态（auth.test.js 必测）：
   * - 旧数据合法（两键均可解析为数组，允许空数组）→ { action:'migrate', bills, accounts }
   * - 两键都不存在 → { action:'skip', reason:'none' }（无旧数据）
   * - 任一键损坏（非法 JSON / 非数组）→ { action:'skip', reason:'corrupt' }：视为无旧数据，
   *   跳过迁移不报错（PRD 6.3-4），旧键保留不动
   * @param {string|null} rawBills v1 全局键 bills 的原始字符串
   * @param {string|null} rawAccounts v1 全局键 accounts 的原始字符串
   * @returns {{action:string, reason?:string, bills?:Array, accounts?:Array}}
   */
  function decideV1Migration(rawBills, rawAccounts) {
    if (rawBills === null && rawAccounts === null) {
      return { action: 'skip', reason: 'none' };
    }
    var bills = parseV1Array(rawBills);
    var accounts = parseV1Array(rawAccounts);
    if (bills === null || accounts === null) {
      return { action: 'skip', reason: 'corrupt' };
    }
    return { action: 'migrate', bills: bills, accounts: accounts };
  }

  return {
    ROLES: ROLES,
    ROLE_STUDENT: ROLE_STUDENT,
    ROLE_PARENT: ROLE_PARENT,
    USERNAME_MAX: USERNAME_MAX,
    PASSWORD_MIN: PASSWORD_MIN,
    PASSWORD_MAX: PASSWORD_MAX,
    INVITE_CODE_LENGTH: INVITE_CODE_LENGTH,
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    sha256HexSync: sha256HexSync,
    validateUsername: validateUsername,
    validatePassword: validatePassword,
    validateRole: validateRole,
    validateRegistration: validateRegistration,
    createUser: createUser,
    findUser: findUser,
    replaceUser: replaceUser,
    withInviteCode: withInviteCode,
    withBoundStudent: withBoundStudent,
    withoutBoundStudent: withoutBoundStudent,
    buildSession: buildSession,
    isSessionValid: isSessionValid,
    generateInviteCode: generateInviteCode,
    findStudentByInviteCode: findStudentByInviteCode,
    validateBinding: validateBinding,
    findParentOfStudent: findParentOfStudent,
    decideV1Migration: decideV1Migration
  };
});
