/**
 * auth.test.js —— 认证/邀请码/迁移决策断言脚本（v2 新增，Node 原生 assert）
 *
 * 运行：node test/auth.test.js
 * 必测内容（增量需求书第八节）：
 * - 密码哈希确定性（同密码两次哈希结果一致——退化实现最易错点）、哈希结果 ≠ 明文
 * - 注册校验（重名/含冒号/超长/空密码全部拒绝）
 * - 邀请码 6 位数字格式与同表查重
 * - 迁移决策函数三态（旧数据合法→迁、不存在→跳过、损坏→跳过不崩）
 */
'use strict';

const assert = require('assert');
const authMod = require('../js/auth.js');
const auth = authMod.LedgerAuth || authMod;

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}
function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  passed++;
}

// 测试用户表基础数据
function makeUser(username, role, extra) {
  return Object.assign({
    username: username,
    password_hash: 'fakehash-' + username,
    role: role,
    created_at: 1,
    invite_code: null,
    bound_student: null
  }, extra || {});
}

(async function run() {

  // ========== 1. 密码哈希：确定性（命门） ==========
  const h1 = await auth.hashPassword('linxiao-pass-123');
  const h2 = await auth.hashPassword('linxiao-pass-123');
  eq(h1, h2, '同一密码两次哈希结果完全一致（异步主路径确定性）');

  const s1 = auth.sha256HexSync('linxiao-pass-123');
  const s2 = auth.sha256HexSync('linxiao-pass-123');
  eq(s1, s2, '同步退化哈希两次结果完全一致（退化路径确定性）');

  eq(h1, s1, '异步主路径与同步退化路径输出一致（都是标准 SHA-256，环境切换不失效）');

  // 标准 SHA-256 测试向量（FIPS 180-4："abc"）
  eq(await auth.hashPassword('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '标准 SHA-256 测试向量 "abc" 校验通过');

  // ========== 2. 哈希结果 ≠ 明文、形状合法 ==========
  const pw = 'my-secret-888';
  const hash = await auth.hashPassword(pw);
  ok(hash !== pw, '哈希结果 ≠ 明文密码（验收 A2）');
  eq(hash.length, 64, 'SHA-256 十六进制串长度为 64');
  ok(/^[0-9a-f]{64}$/.test(hash), '哈希值为 64 位十六进制小写串');

  // 不同密码哈希不同
  ok(await auth.hashPassword('aaa111') !== await auth.hashPassword('aaa112'),
    '不同密码哈希值不同');
  // 中文密码也确定
  eq(await auth.hashPassword('中文密码一二三'), await auth.hashPassword('中文密码一二三'),
    '含中文的密码哈希同样确定');

  // 校验：verifyPassword 正/负两路
  eq(await auth.verifyPassword(pw, hash), true, 'verifyPassword 正确密码返回 true');
  eq(await auth.verifyPassword('wrong-pass', hash), false, 'verifyPassword 错误密码返回 false');

  // createUser 记录中无明文密码字段
  const rec = auth.createUser({ username: 'linxiao', role: '学生' }, hash, 1792635059000);
  ok(!('password' in rec) && !('password_plain' in rec), '用户记录无任何明文密码字段');
  eq(rec.password_hash, hash, '记录只含 password_hash');
  eq(rec.invite_code, null, '新用户 invite_code 初始为 null');
  eq(rec.bound_student, null, '新用户 bound_student 初始为 null');

  // ========== 3. 注册校验：全部拒绝项 ==========
  const users = [makeUser('linxiao', '学生')];
  const rejects = [
    [{ username: '', password: '123456', role: '学生', users: [] }, '空用户名'],
    [{ username: 'a'.repeat(21), password: '123456', role: '学生', users: [] }, '用户名 21 字超长'],
    [{ username: 'a:b', password: '123456', role: '学生', users: [] }, '用户名含冒号'],
    [{ username: ' abc ', password: '123456', role: '学生', users: [] }, '用户名前后空格'],
    [{ username: 'linxiao', password: '123456', role: '学生', users: users }, '用户名重名'],
    [{ username: 'newbie', password: '12345', role: '学生', users: [] }, '密码 5 位（<6）'],
    [{ username: 'newbie', password: '', role: '学生', users: [] }, '空密码'],
    [{ username: 'newbie', password: 'a'.repeat(21), role: '学生', users: [] }, '密码 21 位（>20）'],
    [{ username: 'newbie', password: '123456', role: '', users: [] }, '角色未选'],
    [{ username: 'newbie', password: '123456', role: '管理员', users: [] }, '角色非法值'],
    [{ username: 'linxiao', password: '123456', role: '学生', users: users }, '重名用户（第二个学生）']
  ];
  for (const [input, label] of rejects) {
    const r = auth.validateRegistration(input);
    ok(r.ok === false && r.message, '注册拒绝：' + label + ' → "' + r.message + '"');
  }
  // 合法注册通过
  const good = auth.validateRegistration({ username: 'linmama', password: '123456', role: '家长', users: users });
  eq(good.ok, true, '合法输入（1 字用户名边界 + 6 位密码 + 家长角色）通过校验');
  eq(auth.validateRegistration({ username: 'a'.repeat(20), password: 'a'.repeat(20), role: '学生', users: [] }).ok, true,
    '边界值：用户名/密码恰好 20 字通过校验');

  // ========== 4. 邀请码：6 位数字格式 + 同表查重 ==========
  const code1 = auth.generateInviteCode([]);
  ok(/^\d{6}$/.test(code1), '生成的邀请码为 6 位数字（实际 ' + code1 + '）');
  // 查重：随机源第一次产出与已有码相同，第二次产出不同 → 必须避开已有码
  let callCount = 0;
  const seqRand = function () {
    callCount++;
    // 第一次生成 1,2,3,4,5,6（与已有码撞车），之后生成 9,9,9,9,9,9
    const digits = callCount <= 6 ? [1, 2, 3, 4, 5, 6] : [9, 9, 9, 9, 9, 9];
    return digits[(callCount - 1) % 6] / 10;
  };
  const studentWithCode = makeUser('linxiao', '学生', { invite_code: '123456' });
  const dedupCode = auth.generateInviteCode([studentWithCode], seqRand);
  eq(dedupCode, '999999', '同表查重：与已有码 123456 撞车后重取，返回 999999');
  ok(dedupCode !== '123456', '生成的新码不与全表任何现有码重复');

  // ========== 5. 邀请码查找与绑定校验（线五/线六） ==========
  const student = makeUser('linxiao', '学生', { invite_code: '382916' });
  const parentFree = makeUser('linmama', '家长');
  const parentBusy = makeUser('linbaba', '家长', { bound_student: 'other-kid' });
  const boundStudent = makeUser('other-kid', '学生', { invite_code: '111111', bound_student: 'linmama' });
  const table = [student, parentFree, parentBusy, boundStudent];

  eq(auth.findStudentByInviteCode(table, '382916'), student, '按有效码找到学生');
  eq(auth.findStudentByInviteCode(table, '000000'), null, '不存在的码返回 null（→ 统一提示"邀请码无效"）');
  eq(auth.findStudentByInviteCode(table, 'abc123'), null, '非 6 位数字格式返回 null');
  eq(auth.findStudentByInviteCode(table, '1234567'), null, '7 位数字返回 null');
  eq(auth.findStudentByInviteCode([makeUser('cleared', '学生', { invite_code: null })], '382916'), null,
    '学生的码为 null（已被使用/失效）时不匹配任何输入码');

  let res = auth.validateBinding(table, '382916', parentFree);
  eq(res.ok, true, '正常绑定资格校验通过');
  res = auth.validateBinding(table, '999999', parentFree);
  ok(!res.ok && res.message === '邀请码无效', '码不存在 → 统一提示"邀请码无效"');
  res = auth.validateBinding(table, '111111', parentFree);
  ok(!res.ok && res.message === '该学生已绑定家长', '学生已绑定其他家长 → 提示"该学生已绑定家长"');
  res = auth.validateBinding(table, '382916', parentBusy);
  ok(!res.ok && res.message.indexOf('已绑定') !== -1, '家长已绑定学生时不允许再绑（一对一）');
  res = auth.validateBinding(table, '382916', student);
  ok(!res.ok, '学生不能发起绑定（码只属于学生角色）');

  // 绑定/解绑纯函数：绑定关系唯一存放在家长记录 bound_student（不双写）
  const boundParent = auth.withBoundStudent(parentFree, 'linxiao');
  eq(boundParent.bound_student, 'linxiao', '绑定写入家长记录 bound_student');
  eq(boundParent.invite_code, null, '家长记录 invite_code 恒为 null');
  const unboundParent = auth.withoutBoundStudent(boundParent);
  eq(unboundParent.bound_student, null, '解绑清空家长 bound_student');
  // 解绑不恢复学生的码：学生记录在绑定/解绑过程中 invite_code 只会被清空，不会被恢复
  const studentAfterBind = auth.withInviteCode(student, null); // 绑定成功即清空（一次性）
  eq(studentAfterBind.invite_code, null, '绑定成功后学生码清空（一次性使用）');
  const studentAfterUnbind = auth.withoutBoundStudent(studentAfterBind); // 解绑只动家长记录
  eq(studentAfterUnbind.invite_code, null, '解绑后学生码仍为 null（解绑不恢复码，需重新生成）');

  eq(auth.findParentOfStudent(table, 'linxiao'), null, '未绑定学生反查家长为 null');
  eq(auth.findParentOfStudent(table, 'other-kid'), parentBusy, '已绑定学生反查到家长记录（学生端状态靠反查，无双写）');

  // ========== 6. 会话管理（纯逻辑） ==========
  const session = auth.buildSession(student);
  eq(session.username, 'linxiao', '会话含 username');
  eq(session.role, '学生', '会话含 role');
  eq(auth.isSessionValid(session, table), true, '有效会话校验通过');
  eq(auth.isSessionValid(session, [makeUser('linmama', '家长')]), false, '用户已从表中删除 → 会话无效');
  eq(auth.isSessionValid({ username: 'linxiao', role: '家长' }, table), false, '角色与记录不一致 → 会话无效');
  eq(auth.isSessionValid(null, table), false, 'null 会话无效');
  eq(auth.isSessionValid({ username: 'linxiao' }, table), false, '缺 role 字段的会话无效');

  // ========== 7. 迁移决策三态（T20/T21/损坏） ==========
  const legalBills = JSON.stringify([
    { id: 'b1', date: '2026-10-01', amount_cents: 900, category: '餐饮', tag: '冲动', created_at: 1 }
  ]);
  const legalAccounts = JSON.stringify([
    { id: 'a1', name: '微信', balance_cents: 32000 }
  ]);
  let d = auth.decideV1Migration(legalBills, legalAccounts);
  eq(d.action, 'migrate', '三态之一：旧数据合法 → 迁移');
  eq(d.bills.length, 1, '决策结果携带解析出的账单数组');
  eq(d.accounts.length, 1, '决策结果携带解析出的账户数组');

  d = auth.decideV1Migration(null, null);
  eq(d.action, 'skip', '三态之二：两键不存在 → 跳过');
  eq(d.reason, 'none', '跳过原因为"无旧数据"');

  d = auth.decideV1Migration('{oops not json', legalAccounts);
  eq(d.action, 'skip', '三态之三：旧键 JSON 损坏 → 跳过不崩');
  eq(d.reason, 'corrupt', '损坏跳过原因为 corrupt（视为无旧数据，PRD 6.3-4）');

  d = auth.decideV1Migration(legalBills, '{"broken":');
  eq(d.action, 'skip', '任一键损坏 → 整体跳过（保守处理）');
  d = auth.decideV1Migration('{"not":"an array"}', legalAccounts);
  eq(d.action, 'skip', '合法 JSON 但非数组 → 按损坏跳过');
  d = auth.decideV1Migration('[]', '[]');
  eq(d.action, 'migrate', '空数组（v1 全新安装的合法形状）→ 也迁移并清理旧键');

  console.log(passed + ' assertions passed');

})().catch(function (err) {
  console.error('auth.test.js FAILED: ' + err.message);
  process.exit(1);
});
