/**
 * recommend.js —— 智能分类推荐词典与匹配（v2 新增，端侧 AI 三件套之二）
 *
 * 设计约束（v2 增量需求书 5.4②、线八 T22–T24）：
 * - 纯函数模块：不碰 DOM、不碰存储、不依赖 app/store/stats，UMD 双环境（Node require 供测试）
 * - recommend(text) → { category, tag, reason, hit } | null
 * - 内置中文关键词词典 ≥40 词条，覆盖 6 大分类，每词条携带 { 分类, 刚性/冲动 }
 * - 一个文本命中多个词条时取词典顺序第一个（简单、可解释、可测试），不做权重排序
 * - 理由文案必须包含命中词本身（验收 A9 判定"理由含命中词"）
 * - 无命中返回 null，界面不出推荐卡
 * - 推荐只动表单，永不直接落库（落库仍走 T1 用户点保存）
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LedgerRecommend = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 中文关键词词典（当前 58 词条 ≥ 40，覆盖餐饮/交通/娱乐/学习/日用/其他六类）。
   * 数组顺序即命中优先级：多词条命中时取第一个（5.4②），新增词条请按优先级插入。
   * 每条：{ word: 关键词, category: 分类, tag: 刚性/冲动 }
   */
  var DICTIONARY = [
    // —— 餐饮（22）——
    { word: '奶茶', category: '餐饮', tag: '冲动' },
    { word: '蜜雪冰城', category: '餐饮', tag: '冲动' },
    { word: '瑞幸', category: '餐饮', tag: '冲动' },
    { word: '星巴克', category: '餐饮', tag: '冲动' },
    { word: '咖啡', category: '餐饮', tag: '冲动' },
    { word: '外卖', category: '餐饮', tag: '冲动' },
    { word: '美团', category: '餐饮', tag: '冲动' },
    { word: '饿了么', category: '餐饮', tag: '冲动' },
    { word: '食堂', category: '餐饮', tag: '刚性' },
    { word: '早饭', category: '餐饮', tag: '刚性' },
    { word: '早餐', category: '餐饮', tag: '刚性' },
    { word: '午饭', category: '餐饮', tag: '刚性' },
    { word: '午餐', category: '餐饮', tag: '刚性' },
    { word: '晚饭', category: '餐饮', tag: '刚性' },
    { word: '晚餐', category: '餐饮', tag: '刚性' },
    { word: '宵夜', category: '餐饮', tag: '冲动' },
    { word: '火锅', category: '餐饮', tag: '冲动' },
    { word: '烧烤', category: '餐饮', tag: '冲动' },
    { word: '小吃', category: '餐饮', tag: '冲动' },
    { word: '零食', category: '餐饮', tag: '冲动' },
    { word: '水果', category: '餐饮', tag: '刚性' },
    { word: '饮料', category: '餐饮', tag: '冲动' },
    // —— 交通（10）——
    { word: '打车', category: '交通', tag: '刚性' },
    { word: '滴滴', category: '交通', tag: '刚性' },
    { word: '地铁', category: '交通', tag: '刚性' },
    { word: '公交', category: '交通', tag: '刚性' },
    { word: '共享单车', category: '交通', tag: '刚性' },
    { word: '高铁', category: '交通', tag: '刚性' },
    { word: '火车', category: '交通', tag: '刚性' },
    { word: '机票', category: '交通', tag: '刚性' },
    { word: '加油', category: '交通', tag: '刚性' },
    { word: '出租', category: '交通', tag: '刚性' },
    // —— 娱乐（8）——
    { word: '盲盒', category: '娱乐', tag: '冲动' },
    { word: '游戏', category: '娱乐', tag: '冲动' },
    { word: '电影', category: '娱乐', tag: '冲动' },
    { word: 'ktv', category: '娱乐', tag: '冲动' },
    { word: '演唱会', category: '娱乐', tag: '冲动' },
    { word: '网吧', category: '娱乐', tag: '冲动' },
    { word: '剧本杀', category: '娱乐', tag: '冲动' },
    { word: '桌游', category: '娱乐', tag: '冲动' },
    // —— 学习（8）——
    { word: '打印', category: '学习', tag: '刚性' },
    { word: '复印', category: '学习', tag: '刚性' },
    { word: '网课', category: '学习', tag: '刚性' },
    { word: '考试报名费', category: '学习', tag: '刚性' },
    { word: '教材', category: '学习', tag: '刚性' },
    { word: '文具', category: '学习', tag: '刚性' },
    { word: '书', category: '学习', tag: '刚性' },
    { word: '笔', category: '学习', tag: '刚性' },
    // —— 日用（6）——
    { word: '洗衣液', category: '日用', tag: '刚性' },
    { word: '纸巾', category: '日用', tag: '刚性' },
    { word: '洗发水', category: '日用', tag: '刚性' },
    { word: '快递', category: '日用', tag: '刚性' },
    { word: '牙膏', category: '日用', tag: '刚性' },
    { word: '沐浴露', category: '日用', tag: '刚性' },
    // —— 其他（4）——
    { word: '充值', category: '其他', tag: '刚性' },
    { word: '押金', category: '其他', tag: '刚性' },
    { word: '红包', category: '其他', tag: '冲动' },
    { word: '捐款', category: '其他', tag: '刚性' }
  ];

  /**
   * 智能分类推荐：文本命中词典 ≥1 词条时返回推荐结构，否则 null。
   * 匹配按词典顺序第一个命中为准；英文词条大小写不敏感（ktv ↔ KTV）。
   * @param {string} text 商户名或备注文本（也可为语音识别文本）
   * @returns {{category:string, tag:string, reason:string, hit:string}|null}
   */
  function recommend(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return null;
    }
    var lower = text.toLowerCase();
    for (var i = 0; i < DICTIONARY.length; i++) {
      var entry = DICTIONARY[i];
      if (lower.indexOf(entry.word.toLowerCase()) !== -1) {
        return {
          category: entry.category,
          tag: entry.tag,
          hit: entry.word,
          // 理由文案必须包含命中词本身（验收 A9）
          reason: '命中关键词「' + entry.word + '」，推荐分类：' + entry.category +
            '，消费标签：' + entry.tag
        };
      }
    }
    return null;
  }

  /**
   * 词典规模（供测试断言 ≥40 与分类覆盖）
   * @returns {number}
   */
  function dictionarySize() {
    return DICTIONARY.length;
  }

  return {
    DICTIONARY: DICTIONARY,
    recommend: recommend,
    dictionarySize: dictionarySize
  };
});
