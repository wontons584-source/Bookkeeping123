/**
 * speech.js —— 语音识别（Web Speech API 封装）
 *
 * 设计约束（需求书 3.3①、4.3）：
 * - 含可用性检测与降级提示：不支持时给明确文案，绝不报错、绝不挡住手动记账主流程
 * - 识别结果只交给回调（由 app.js 预填表单），本文件不碰 DOM、不碰存储，
 *   永远不会直接产生一条账单（T6：只预填草稿，T7 由用户点保存才落库）
 * - 金额解析用正则提取数字；分类用关键词匹配枚举名（枚举常量取自 stats.js）
 */
(function (root) {
  'use strict';

  var stats = root.LedgerStats;

  /** 分类关键词表：按顺序匹配，命中即返回对应枚举分类名 */
  var CATEGORY_KEYWORDS = [
    { category: '餐饮', keywords: ['奶茶', '咖啡', '饭', '吃', '餐', '外卖', '食堂', '面', '粉', '小吃', '零食', '饮料', '奶茶店', '水果', '烧烤', '火锅', '早餐', '午餐', '晚餐'] },
    { category: '娱乐', keywords: ['游戏', '电影', 'KTV', 'ktv', '唱', '演出', '旅游', '剧本杀', '桌游', '直播', '盲盒', '会员', '点卡'] },
    { category: '交通', keywords: ['地铁', '公交', '打车', '出租', '滴滴', '车费', '高铁', '火车', '机票', '共享单车', '骑行', '加油'] },
    { category: '学习', keywords: ['书', '笔', '本子', '课', '学费', '打印', '资料', '文具', '考试', '培训', '网课'] },
    { category: '日用', keywords: ['纸', '洗发', '洗衣', '牙膏', '沐浴', '超市', '日用', '生活用品', '快递'] }
  ];

  /**
   * 能力检测：当前环境是否支持 Web Speech API
   * @returns {boolean}
   */
  function isSupported() {
    return !!(root.SpeechRecognition || root.webkitSpeechRecognition);
  }

  var recognition = null;

  /**
   * 发起一次语音识别（zh-CN）
   * @param {function(string)} onResult 识别成功回调，参数为识别文本
   * @param {function(string)} onError 失败回调，参数为面向用户的中文提示
   * @returns {boolean} 是否成功启动识别
   */
  function start(onResult, onError) {
    var Rec = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (!Rec) {
      if (onError) {
        onError('当前环境不支持语音记账，请手动填写');
      }
      return false;
    }
    try {
      // 若上一次识别尚未结束，先中断，避免并发会话报错
      if (recognition) {
        try { recognition.abort(); } catch (e) { /* 忽略 */ }
        recognition = null;
      }
      recognition = new Rec();
      recognition.lang = 'zh-CN';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = function (event) {
        var text = '';
        if (event.results && event.results[0] && event.results[0][0]) {
          text = event.results[0][0].transcript || '';
        }
        if (onResult) {
          onResult(text);
        }
      };
      recognition.onerror = function (event) {
        var MESSAGES = {
          'not-allowed': '麦克风权限被拒绝，请允许后重试，或直接手动填写',
          'no-speech': '没有听清，请再点一次语音按钮慢慢说',
          'audio-capture': '未检测到麦克风设备，请手动填写',
          'network': '语音识别服务不可用，请手动填写'
        };
        if (onError) {
          onError(MESSAGES[event.error] || '语音识别失败，请手动填写');
        }
      };
      recognition.onend = function () {
        recognition = null;
      };
      recognition.start();
      return true;
    } catch (e) {
      recognition = null;
      if (onError) {
        onError('无法启动语音识别，请手动填写');
      }
      return false;
    }
  }

  /**
   * 从识别文本中提取金额（元）。正则提取第一段数字（支持两位小数），
   * 兼容"九块九"之外的表达——纯中文数字不属于本期范围，解析不出返回 null。
   * @param {string} text
   * @returns {number|null}
   */
  function extractAmountYuan(text) {
    if (typeof text !== 'string') {
      return null;
    }
    var match = text.match(/(\d+(?:\.\d{1,2})?)/);
    if (!match) {
      return null;
    }
    var value = parseFloat(match[1]);
    if (!isFinite(value) || value <= 0) {
      return null;
    }
    return value;
  }

  /**
   * 关键词匹配分类：按固定顺序逐组检查，命中返回枚举分类名，全不命中返回 null
   * @param {string} text
   * @returns {string|null}
   */
  function matchCategory(text) {
    if (typeof text !== 'string' || !text) {
      return null;
    }
    for (var i = 0; i < CATEGORY_KEYWORDS.length; i++) {
      var entry = CATEGORY_KEYWORDS[i];
      for (var j = 0; j < entry.keywords.length; j++) {
        if (text.indexOf(entry.keywords[j]) !== -1) {
          return entry.category;
        }
      }
    }
    return null;
  }

  /**
   * 解析识别结果 → 表单预填草稿（T6）。只返回解析结构，绝不落库。
   * 备注直接放原始识别文本，方便用户核对并修改。
   * @param {string} text 识别文本
   * @returns {{amount_yuan:number|null, category:string|null, note:string}}
   */
  function parseTranscript(text) {
    var trimmed = typeof text === 'string' ? text.trim() : '';
    // 分类枚举校验：matchCategory 只会返回 CATEGORIES 内的值，这里再兜底一次
    var category = matchCategory(trimmed);
    if (category && stats && stats.CATEGORIES.indexOf(category) === -1) {
      category = null;
    }
    return {
      amount_yuan: extractAmountYuan(trimmed),
      category: category,
      note: trimmed
    };
  }

  root.LedgerSpeech = {
    isSupported: isSupported,
    start: start,
    parseTranscript: parseTranscript,
    extractAmountYuan: extractAmountYuan,
    matchCategory: matchCategory
  };
})(typeof self !== 'undefined' ? self : this);
