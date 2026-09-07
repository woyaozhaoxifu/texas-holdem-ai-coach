/* global window, global */
/**
 * personalities.js —— AI 人格参数表。
 *
 * 本文件是「不同 AI 有不同打法」的数据源头。brain.js 依据这些参数
 * 走完全不同的决策分支（不只是数值微调）：
 *   - Fish   : 只看自己有没有牌，几乎不弃牌，被动跟到底
 *   - Rock   : 翻牌前用 top % 起手牌过滤，非顶级牌直接弃
 *   - TAG    : 标准紧凶，位置意识 + 持续下注
 *   - LAG    : 高频加注 / 3-bet / 诈唬，压迫但不平衡
 *   - Solver : 纯底池赔率 + 胜率的最优近似，平衡诈唬，下注尺度分极化
 *   - Boss   : Solver 基础上叠加玩家建模（读牌），动态改诈唬频率与跟注阈值
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  /**
   * 人格字段说明：
   *  id          唯一标识
   *  name        中文名
   *  avatar      emoji 头像（UI 用）
   *  difficulty  难度星级 1..5
   *  style       风格标签（UI 展示）
   *  desc        打法文字描述
   *  color       UI 主题色
   *  vpip                入池率 0..1
   *  pfr                 翻牌前加注率 0..1
   *  aggression          激进度 0..2（下注/加注 vs 跟注）
   *  bluffFreq           诈唬频率 0..1
   *  callThreshold       跟注门槛系数（越大越爱跟）
   *  foldToAggression    面对加注的弃牌倾向 0..1
   *  tricky              慢打/设陷阱倾向 0..1
   *  tiltFactor          连败后变松倾向 0..1
   *  equitySamples       蒙特卡洛采样次数
   *  noise               决策噪声 0..1
   *  adaptivity          玩家建模强度 0..1
   *  positionAware       位置意识 0..1
   *  cbetFreq            持续下注频率 0..1
   *  threeBetFreq        3-bet 频率 0..1
   *  preflopTop          翻牌前只玩前 X% 起手牌（null 表示不过滤）
   *  betSizing           下注尺度 {value, bluff, polarize}
   *  callStation         跟注站倾向：命中中等牌力就不弃牌 0..1
   *  stealFreq           偷盲/偷池频率（前位无人入池时在后位开火）0..1
   *  restealFreq         反偷频率（面对疑似偷盲时 3-bet 反击）0..1
   *  bluffCatchFreq      抓诈唬倾向（面对大注时敢跟的程度）0..1
   *  moodVolatility      情绪波动 0..1（越大越容易被输赢影响心态）
   *  pushBB              短码推推乐阈值：后手 ≤ pushBB×BB 时进入「全下或弃牌」
   *                      （push/fold），越短推得越宽；越大越早开始推（岩石/松凶设高，
   *                      跟注站设低）。比赛模式盲注升级后自动生效
   *  moodLines           情绪化台词（不同心境下的思考气泡）
   */
  var PERSONALITIES = [
    {
      id: 'fish',
      name: '新手小鱼',
      avatar: '\uD83D\uDC1F',
      difficulty: 1,
      style: '松弱跟注站',
      color: '#5fb8c9',
      desc: '刚学会规则就上桌。什么牌都想看翻牌，中了点东西就死也不弃牌，几乎不会主动加注，更不会诈唬。想赢他很容易——只要你有耐心等牌。',
      vpip: 0.82,
      pfr: 0.06,
      aggression: 0.35,
      bluffFreq: 0.04,
      callThreshold: 1.55,
      foldToAggression: 0.06,
      tricky: 0.03,
      tiltFactor: 0.35,
      equitySamples: 160,
      noise: 0.42,
      adaptivity: 0,
      positionAware: 0.05,
      cbetFreq: 0.20,
      threeBetFreq: 0.02,
      preflopTop: null,
      stealFreq: 0.05,
      restealFreq: 0.02,
      bluffCatchFreq: 0.92,
      moodVolatility: 0.95,
      moodLines: { tilt: ['又输了……再来再来！', '我就不信了，跟！'], happy: ['哈哈我赢了！', '这把运气好！'], calm: ['嗯……跟吧。'] },
      callStation: 0.92,
      pushBB: 6,
      betSizing: { value: 0.45, bluff: 0.35, polarize: 0 }
    },
    {
      id: 'rock',
      name: '石头老张',
      avatar: '\uD83D\uDC36',
      difficulty: 2,
      style: '岩石级超紧凶',
      color: '#8d93a1',
      desc: '一小时只打三四手牌。但一旦他入池，多半是 AA/KK/AK。不诈唬、不纠缠，被加注会果断扔掉中等牌。看他会一直弃牌，别误以为他好欺负。',
      vpip: 0.15,
      pfr: 0.13,
      aggression: 1.15,
      bluffFreq: 0.02,
      callThreshold: 0.92,
      foldToAggression: 0.55,
      tricky: 0.10,
      tiltFactor: 0.10,
      equitySamples: 320,
      noise: 0.16,
      adaptivity: 0,
      positionAware: 0.35,
      cbetFreq: 0.45,
      threeBetFreq: 0.05,
      preflopTop: 0.24,
      stealFreq: 0.20,
      restealFreq: 0.16,
      bluffCatchFreq: 0.22,
      moodVolatility: 0.20,
      moodLines: { tilt: ['（皱眉）这牌也能反超？', '不打了不打了……'], happy: ['（满意地点头）', '这就是等待的价值。'], calm: ['按牌打，不冒险。'] },
      callStation: 0.08,
      pushBB: 16,
      betSizing: { value: 0.75, bluff: 0.5, polarize: 0.15 }
    },
    {
      id: 'tag',
      name: '稳健老李',
      avatar: '\uD83E\uDDD1\u200D\uD83D\uDCBC',
      difficulty: 3,
      style: '紧凶标准流',
      color: '#4c9be8',
      desc: '打得一手好教科书：只在好位置和好牌时入池，翻牌后持续下注施压，诈唬适度且有分寸。他不会给你太多便宜，但也不会无故跟你拼命。',
      vpip: 0.28,
      pfr: 0.22,
      aggression: 1.05,
      bluffFreq: 0.18,
      callThreshold: 1.05,
      foldToAggression: 0.34,
      tricky: 0.18,
      tiltFactor: 0.14,
      equitySamples: 480,
      noise: 0.09,
      adaptivity: 0.15,
      positionAware: 0.75,
      cbetFreq: 0.66,
      threeBetFreq: 0.11,
      preflopTop: 0.36,
      stealFreq: 0.48,
      restealFreq: 0.32,
      bluffCatchFreq: 0.52,
      moodVolatility: 0.40,
      moodLines: { tilt: ['刚才那手我打得不对……稳住。', '运气有点差。'], happy: ['节奏不错，继续保持。', '就该怎么打。'], calm: ['按位置来。'] },
      callStation: 0.22,
      pushBB: 12,
      betSizing: { value: 0.66, bluff: 0.55, polarize: 0.35 }
    },
    {
      id: 'lag',
      name: '狂暴鲨鱼',
      avatar: '\uD83E\uDD88',
      difficulty: 4,
      style: '松凶压迫流',
      color: '#e0653f',
      desc: '每手牌都想加注。高频 3-bet、持续开火、疯狂诈唬——他用压力逼你犯错。破绽是他诈唬过头，拿着空气也会开三枪，敢跟到底就能吃到他。',
      vpip: 0.55,
      pfr: 0.42,
      aggression: 1.65,
      bluffFreq: 0.40,
      callThreshold: 1.15,
      foldToAggression: 0.24,
      tricky: 0.22,
      tiltFactor: 0.30,
      equitySamples: 560,
      noise: 0.11,
      adaptivity: 0.3,
      positionAware: 0.80,
      cbetFreq: 0.82,
      threeBetFreq: 0.26,
      preflopTop: 0.62,
      stealFreq: 0.88,
      restealFreq: 0.58,
      bluffCatchFreq: 0.38,
      moodVolatility: 0.75,
      moodLines: { tilt: ['再来！我就不信压不死你！', '气死我了，加注！'], happy: ['哈哈，你们都太怂了！', '继续开火！'], calm: ['机会来了，打。'] },
      callStation: 0.18,
      pushBB: 18,
      betSizing: { value: 0.80, bluff: 0.72, polarize: 0.55 }
    },
    {
      id: 'solver',
      name: 'GTO 数学家',
      avatar: '\uD83E\uDDD1\u200D\uD83D\uDD2C',
      difficulty: 5,
      style: '博弈最优平衡',
      color: '#9b6cf0',
      desc: '不出情绪、不讲直觉，只算数字：底池赔率、胜率、范围优势、下注尺度。他的诈唬与价值下注比例经过平衡，你无法从他的下注大小读出牌力。',
      vpip: 0.33,
      pfr: 0.27,
      aggression: 1.30,
      bluffFreq: 0.26,
      callThreshold: 1.00,
      foldToAggression: 0.30,
      tricky: 0.30,
      tiltFactor: 0.0,
      equitySamples: 800,
      noise: 0.02,
      adaptivity: 0.45,
      positionAware: 0.95,
      cbetFreq: 0.72,
      threeBetFreq: 0.16,
      preflopTop: 0.40,
      stealFreq: 0.62,
      restealFreq: 0.44,
      bluffCatchFreq: 0.56,
      moodVolatility: 0.06,
      moodLines: { tilt: ['数据上这是正常波动。', '不影响期望值。'], happy: ['执行正确。', '正 EV 决策。'], calm: ['按范围处理。'] },
      callStation: 0.05,
      pushBB: 10,
      betSizing: { value: 0.72, bluff: 0.62, polarize: 0.85 }
    },
    {
      id: 'boss',
      name: '读牌大师',
      avatar: '\uD83D\uDC51',
      difficulty: 5,
      style: '自适应读牌 BOSS',
      color: '#d4a game',
      desc: '他不只看牌，他在看你。你的入池率、弃牌率、诈唬频率都被他记在小本子上：你爱弃牌，他就偷；你太松，他就减少诈唬、加厚价值下注。想赢他，先骗过他。',
      vpip: 0.36,
      pfr: 0.30,
      aggression: 1.45,
      bluffFreq: 0.28,
      callThreshold: 1.00,
      foldToAggression: 0.28,
      tricky: 0.38,
      tiltFactor: 0.0,
      equitySamples: 800,
      noise: 0.01,
      adaptivity: 1.0,
      positionAware: 0.95,
      cbetFreq: 0.75,
      threeBetFreq: 0.19,
      preflopTop: 0.42,
      stealFreq: 0.70,
      restealFreq: 0.52,
      bluffCatchFreq: 0.62,
      moodVolatility: 0.12,
      moodLines: { tilt: ['有意思，你在针对我？', '记下了。'], happy: ['你的一举一动我都记着。', '如我所料。'], calm: ['让我看看你会怎么做。'] },
      callStation: 0.05,
      pushBB: 12,
      betSizing: { value: 0.78, bluff: 0.66, polarize: 0.9 }
    }
  ];

  // 修正 boss 配色（避免手误）
  PERSONALITIES[5].color = '#d4af37';

  var byId = {};
  for (var i = 0; i < PERSONALITIES.length; i++) byId[PERSONALITIES[i].id] = PERSONALITIES[i];

  /** 按 id 取人格，找不到返回稳健老李 */
  function get(id) {
    return byId[id] || byId['tag'];
  }

  /** 全部人格列表 */
  function all() {
    return PERSONALITIES.slice();
  }

  /** 难度星级 -> 星字符串 */
  function stars(difficulty) {
    var s = '';
    for (var i = 0; i < 5; i++) s += (i < difficulty ? '\u2605' : '\u2606');
    return s;
  }

  /** 情绪值(-100..100) -> 中文标签 */
  function moodLabel(mood) {
    if (mood >= 60) return '得意';
    if (mood >= 25) return '愉悦';
    if (mood <= -60) return '上头';
    if (mood <= -25) return '烦躁';
    return '平静';
  }

  /** 情绪值 -> 表情 */
  function moodEmoji(mood) {
    if (mood >= 60) return '\uD83D\uDE0E';
    if (mood >= 25) return '\uD83D\uDE42';
    if (mood <= -60) return '\uD83D\uDE21';
    if (mood <= -25) return '\uD83D\uDE1F';
    return '\uD83D\uDE10';
  }

  var Personalities = {
    LIST: PERSONALITIES,
    get: get,
    all: all,
    stars: stars,
    moodLabel: moodLabel,
    moodEmoji: moodEmoji
  };

  Poker.Personalities = Personalities;
  if (typeof module !== 'undefined' && module.exports) module.exports = Personalities;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
