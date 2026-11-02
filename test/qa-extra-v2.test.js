/**
 * qa-extra-v2.test.js —— QA 第二层独立验证 · v2 边界探测（不改动现有五个脚本）
 *
 * 运行：node test/qa-extra-v2.test.js
 * 覆盖主理人指定的探测面（现有五套脚本未覆盖的部分）：
 *   1. recommend：超长文本 / 中英混合 / 纯数字 / 全半角与大小写变体
 *   2. insights：输出恰 4 条截断 / 最小数据下限 / 上月恰好 1 笔（对比类触发）/
 *      未来日期账单不参与本月统计 / 金额为 0 的账单容错
 *   3. auth：用户名恰 20/21 字、密码 6/5 位、邀请码 000000 与 999999、
 *      同一学生重复生成码后旧码查重、会话指向已删除用户
 *   4. 空数组迁移语义（与工程师裁决一致性复核）
 */
'use strict';

const assert = require('assert');
const recommendMod = require('../js/recommend.js');
const recommend = recommendMod.LedgerRecommend || recommendMod;
const insightsMod = require('../js/insights.js');
const insights = insightsMod.LedgerInsights || insightsMod;
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

const NOW = new Date(2026, 9, 22, 12, 0, 0); // 2026-10-22 → 本月 2026-10、上月 2026-09

function bill(date, cents, category, tag) {
  return { id: 'b' + Math.random(), date: date, amount_cents: cents, category: category, tag: tag, merchant: '', note: '', created_at: 0 };
}

// ==================================================================
// 1. recommend 边界
// ==================================================================

// 1a. 超长文本（10000 字符，命中词在末尾）
const longTail = '水' + 'x'.repeat(9997) + '奶茶';
let r = recommend.recommend(longTail);
ok(r !== null && r.hit === '奶茶' && r.category === '餐饮',
  '超长文本（10000 字符，命中词在末尾）仍命中"奶茶"');
ok(r.reason.indexOf('奶茶') !== -1, '超长文本命中时理由文案仍含命中词');
// 超长但无命中
const longNoHit = '水'.repeat(10000);
eq(recommend.recommend(longNoHit), null, '超长无命中文本返回 null');

// 1b. 中英混合
r = recommend.recommend('MilkTea 奶茶 milk tea');
ok(r !== null && r.hit === '奶茶', '中英混合文本命中中文词条"奶茶"');
r = recommend.recommend('去KTV唱歌');
ok(r !== null && r.hit === 'ktv' && r.category === '娱乐', '中英混合文本命中小写词条 ktv');

// 1c. 纯数字
eq(recommend.recommend('12345'), null, '纯数字文本无命中返回 null');
eq(recommend.recommend('0'), null, '"0" 无命中返回 null');

// 1d. 大小写变体（词典小写词条 + 输入 toLowerCase 匹配）
for (const variant of ['KTV', 'ktv', 'Ktv', 'kTv']) {
  r = recommend.recommend(variant);
  ok(r !== null && r.hit === 'ktv', '英文词条大小写不敏感："' + variant + '" 命中 ktv');
}

// 1e. 全角变体（记录性行为：全角ＫＴＶ不在词典，返回 null——PRD 未要求全角归一化）
eq(recommend.recommend('ＫＴＶ'), null, '全角"ＫＴＶ"不命中半角词条 ktv（全角未归一化，PRD 无此要求，记录为已知行为）');

// ==================================================================
// 2. insights 边界
// ==================================================================

// 2a. 输出恰好 4 条（上限截断精确值）：构造 >4 个可触发模板的丰富数据
const rich = [
  bill('2026-10-01', 5000, '餐饮', '冲动'),    // 大额单笔 ≥50 元 + 餐饮
  bill('2026-10-02', 2600, '餐饮', '冲动'),
  bill('2026-10-03', 900, '餐饮', '冲动'),
  bill('2026-10-04', 800, '餐饮', '刚性'),
  bill('2026-10-05', 700, '餐饮', '刚性'),
  bill('2026-10-06', 12000, '娱乐', '冲动'),   // 娱乐占比 ≥25% + 冲动占比 ≥30% + 最大单笔
  bill('2026-09-05', 1000, '餐饮', '刚性'),    // 上月数据 → 环比触发
  bill('2026-09-06', 9000, '娱乐', '冲动')
];
r = insights.generateInsights(rich, [{ id: 'a1', name: '微信', balance_cents: 80000 }], NOW);
ok(Array.isArray(r) && r.length === insights.MAX_INSIGHTS,
  '多模板触发时输出被精确截断为恰好 ' + insights.MAX_INSIGHTS + ' 条（实际 ' + (r && r.length) + '）');

// 2b. 最小数据下限：3 笔刚性小额账单、无账户、无上月 → 候选恰 3 条（2 恒触发 + 最大占比）
const minimal = [
  bill('2026-10-01', 100, '交通', '刚性'),
  bill('2026-10-02', 100, '日用', '刚性'),
  bill('2026-10-03', 100, '学习', '刚性')
];
r = insights.generateInsights(minimal, [], NOW);
ok(Array.isArray(r) && r.length === 3, '最小数据（3 笔、无对比/习惯/风险/资产触发）输出 3 条，仍 ∈ [2,4]');
ok(r.length >= insights.MIN_INSIGHTS, '下限兜底成立：输出 ≥ MIN_INSIGHTS');

// 2c. 上月恰好有 1 笔 → 对比类（总支出环比）触发
const onePrev = [
  bill('2026-10-01', 1000, '餐饮', '刚性'),
  bill('2026-10-02', 800, '交通', '刚性'),
  bill('2026-10-03', 600, '日用', '刚性'),
  bill('2026-09-15', 500, '餐饮', '刚性')   // 上月恰好 1 笔
];
r = insights.generateInsights(onePrev, [], NOW);
ok(r.some(function (t) { return t.indexOf('环比') !== -1; }),
  '上月恰好 1 笔（上月总额 > 0）→ 总支出环比对比类触发');
// 上月恰好 1 笔但占比变化 < 5pp → 分类环比不触发（500/500 vs 2400/2400，餐饮 20.8%→41.7%，差 20.8pp > 5pp，会触发）
// 两种情况都 ∈ [2,4]
ok(r.length >= insights.MIN_INSIGHTS && r.length <= insights.MAX_INSIGHTS,
  '上月 1 笔场景输出条数仍 ∈ [2,4]（实际 ' + r.length + '）');

// 2d. 未来日期账单（next month）不参与本月统计
const withFuture = [
  bill('2026-10-01', 1000, '餐饮', '刚性'),
  bill('2026-10-02', 800, '交通', '刚性'),
  bill('2026-10-03', 600, '日用', '刚性'),
  bill('2026-11-05', 99999, '娱乐', '冲动'),  // 未来日期（下月）
  bill('2026-12-31', 88888, '娱乐', '冲动')   // 更远的未来日期
];
r = insights.generateInsights(withFuture, [], NOW);
ok(r.some(function (t) { return t.indexOf('本月共记录 3 笔') !== -1; }),
  '未来日期账单不计入本月笔数（本月仍为 3 笔）');
ok(r.every(function (t) { return t.indexOf('999.99') === -1 && t.indexOf('888.88') === -1; }),
  '未来日期账单金额不进入本月统计文案（99999 分 / 88888 分未出现）');
ok(!r.some(function (t) { return t.indexOf('预警') !== -1; }),
  '未来日期的高额冲动账单不触发本月风险预警（不参与本月统计）');

// 本月内未来日期（2026-10-31 > 今天 2026-10-22，但同属当前自然月）→ 参与本月统计（口径 A1：按自然月过滤，非"已发生"过滤）
// 金额取 300 分，避免额外触发风险类模板把总览文案挤出前 4 条（截断是引擎按设计行为）
const futureInMonth = [
  bill('2026-10-01', 1000, '餐饮', '刚性'),
  bill('2026-10-02', 800, '交通', '刚性'),
  bill('2026-10-31', 300, '娱乐', '冲动')
];
r = insights.generateInsights(futureInMonth, [], NOW);
ok(r.some(function (t) { return t.indexOf('本月共记录 3 笔') !== -1; }),
  '本月内未来日期账单（10-31）仍计入本月统计（口径=自然月，非已发生过滤）');

// 2e. 金额为 0 的账单：纯函数层容错（真实链路 store.normalizeBill 已拦截 <1 分，此入参不可达）
r = insights.generateInsights([
  bill('2026-10-01', 0, '餐饮', '刚性'),
  bill('2026-10-02', 500, '交通', '刚性'),
  bill('2026-10-03', 500, '日用', '刚性')
], [], NOW);
ok(Array.isArray(r) && r.length >= insights.MIN_INSIGHTS,
  '金额为 0 的账单不崩溃（笔数计入 3 笔解锁，真实链路中已被 store 校验拦截为不可达）');

// ==================================================================
// 3. auth 边界
// ==================================================================

function makeUser(username, role, extra) {
  return Object.assign({
    username: username, password_hash: 'fakehash-' + username, role: role,
    created_at: 1, invite_code: null, bound_student: null
  }, extra || {});
}

// 3a. 用户名恰 20 字（通过）/ 恰 21 字（拒绝）
eq(auth.validateUsername('a'.repeat(20)).ok, true, '用户名恰 20 字通过');
eq(auth.validateUsername('a'.repeat(21)).ok, false, '用户名恰 21 字被拒');
eq(auth.validateRegistration({ username: 'a'.repeat(20), password: '123456', role: '学生', users: [] }).ok, true,
  '注册校验：用户名恰 20 字整体通过');

// 3b. 密码 6 位（通过）/ 5 位（拒绝）
eq(auth.validatePassword('123456').ok, true, '密码恰 6 位通过');
eq(auth.validatePassword('12345').ok, false, '密码恰 5 位被拒');

// 3c. 邀请码 000000 与 999999：可被生成、可被查找、格式合法
const zeroCode = auth.generateInviteCode([], function () { return 0; });
eq(zeroCode, '000000', '随机源恒 0 时可生成邀请码 000000（格式合法，不排除边界码值）');
const nineCode = auth.generateInviteCode([], function () { return 0.9999999999; });
eq(nineCode, '999999', '随机源恒 0.9999… 时可生成邀请码 999999');
const zeroStudent = makeUser('stu0', '学生', { invite_code: '000000' });
eq(auth.findStudentByInviteCode([zeroStudent], '000000'), zeroStudent, '邀请码 000000 可被查找命中');
eq(auth.findStudentByInviteCode([zeroStudent], '999999'), null, '邀请码 999999 在表中不存在 → null');

// 3d. 同表查重：已有 000000，随机源先撞车后给出 999999 → 返回 999999（不死循环）
let phase = 0;
const collisionRand = function () { return phase++ < 6 ? 0 : 0.9999999999; };
eq(auth.generateInviteCode([zeroStudent], collisionRand), '999999',
  '已有码 000000 时查重生效：撞车后重取返回 999999');

// 3e. 同一学生重复生成码：旧码立即失效（重新生成 = 覆盖）
let users = [makeUser('stu1', '学生', { invite_code: '111111' })];
users = auth.replaceUser(users, auth.withInviteCode(users[0], '222222'));
eq(auth.findStudentByInviteCode(users, '111111'), null, '重新生成后旧码 111111 立即查不到（失效）');
const found = auth.findStudentByInviteCode(users, '222222');
ok(found && found.username === 'stu1', '新码 222222 可查到该学生');
// 重复生成多次均保持全表码值唯一（一次一码）
users = auth.replaceUser(users, auth.withInviteCode(found, '333333'));
eq(auth.findStudentByInviteCode(users, '222222'), null, '再次生成后 222222 也失效（一人一有效码）');

// 3f. 会话指向已删除用户
const ghostSession = { username: 'ghost', role: '学生' };
eq(auth.isSessionValid(ghostSession, []), false, '会话指向的用户不在表中 → 会话无效（按未登录处理）');
const realSession = { username: 'stu1', role: '学生' };
eq(auth.isSessionValid(realSession, users), true, '会话指向在表用户 → 有效（对照）');
eq(auth.isSessionValid(realSession, []), false, '原有效会话在用户被删后失效');

// ==================================================================
// 4. 空数组迁移语义（与工程师裁决一致性复核）
// ==================================================================
// 工程师裁决（auth.test.js：'空数组（v1 全新安装的合法形状）→ 也迁移并清理旧键'）
let d = auth.decideV1Migration('[]', '[]');
eq(d.action, 'migrate', '空数组旧键 → 裁决为迁移（写入空数组并清理旧键，避免旧键永久残留）');
d = auth.decideV1Migration('[]', null);
eq(d.action, 'skip', '一键存在、另一键完全缺失（混合态）→ 保守跳过、旧键保留（与"损坏→跳过保留"同一原则）');
eq(d.reason, 'corrupt', '混合态跳过原因为 corrupt');
d = auth.decideV1Migration(null, null);
eq(d.action, 'skip', '两键完全不存在 → 跳过（真正的无旧数据）');
eq(d.reason, 'none', '完全缺失跳过原因为 none');
// 一致性说明：PRD 6.3-1 字面为"能解析出非空数据"，空数组属字面边缘；实现取"合法 JSON 数组即迁"，已测试固化，属文档化裁决而非隐藏行为。

console.log(passed + ' assertions passed');
