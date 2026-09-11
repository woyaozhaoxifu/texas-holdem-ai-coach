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
 *  drift               「不严格执行本策略」的程度 0..0.4，每手由 Personalities.derive()
 *                      围绕基准做有界摆动：0 = 一板一眼，越大越容易偏离本色。
 *                      硬保底：无论怎么漂，vpip / pfr 相对基准的偏离不得超过 ±35%——
 *                      匿名桌要靠入池率 / 加注率反推对手身份，这是可推断性的生命线。
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
      moodLines: {
        tilt: ['又输了……再来再来！', '我就不信了，跟！', '怎么又是你赢啊，呜……', '手气也太背了吧，我不服！',
          '不管了，这把一定要赢回来！', '呜呜，我的筹码……再让我玩一把嘛。'],
        happy: ['哈哈我赢了！', '这把运气好！', '嘿嘿，我也会打牌的！', '赢啦赢啦，再来一把！',
          '原来这样就能赢，我学会了！'],
        calm: ['嗯……跟吧。', '我看看牌……好像还行？', '大家都在打，那我也打。']
      },
      callStation: 0.92,
      pushBB: 6,
      drift: 0.18,
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
      moodLines: {
        tilt: ['（皱眉）这牌也能反超？', '不打了不打了……', '（沉默）……又是一次。', '等了这么久，就等来这个。',
          '这桌子是不是针对我。', '好，好……那我也不装了。'],
        happy: ['（满意地点头）', '这就是等待的价值。', '嗯。等得值。', '不急，牌会来的。'],
        calm: ['按牌打，不冒险。', '（看了一眼底牌）弃。', '没牌，不凑热闹。']
      },
      callStation: 0.08,
      pushBB: 16,
      drift: 0.06,
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
      moodLines: {
        tilt: ['刚才那手我打得不对……稳住。', '运气有点差。', '位置没利用好，是我的问题。', '这把该收手的，太贪了。',
          '连着几把了，我需要冷静一下。', '再这么打下去，今天的纪律全废了。'],
        happy: ['节奏不错，继续保持。', '就该怎么打。', '稳扎稳打，这才是我的牌。', '读得准，打得也对。'],
        calm: ['按位置来。', '先看一眼赔率。', '不着急，机会还会有的。']
      },
      callStation: 0.22,
      pushBB: 12,
      drift: 0.14,
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
      moodLines: {
        tilt: ['再来！我就不信压不死你！', '气死我了，加注！', '你运气好而已，别得意。', '这都能跟？你是来送钱的吧。',
          '我今天非要把你打光不可！', '谁怂谁孙子，全都给我加！'],
        happy: ['哈哈，你们都太怂了！', '继续开火！', '看见没，这桌子归我管。', '你们弃牌的样子真好看。'],
        calm: ['机会来了，打。', '谁先怂谁输。', '压一把再说。']
      },
      callStation: 0.18,
      pushBB: 18,
      drift: 0.16,
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
      moodLines: {
        tilt: ['数据上这是正常波动。', '不影响期望值。', '样本量不足，结论不成立。', '这手 EV 为负，需要重新校准范围。',
          '连续负偏差……仍在三个标准差内。', '若继续偏离，我将提高下注频率以修正你的跟注范围。'],
        happy: ['执行正确。', '正 EV 决策。', '这手的期望收益为正，符合模型。', '你的弃牌率正在朝我倾斜。'],
        calm: ['按范围处理。', '计算底池赔率。', '频率平衡优先。']
      },
      callStation: 0.05,
      pushBB: 10,
      drift: 0.08,
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
      moodLines: {
        tilt: ['有意思，你在针对我？', '记下了。', '你的手势变了，我很清楚。', '别急，我会等到你犯错。',
          '我已经记住你每一次呼吸了。', '你以为我看不穿？我连你想弃牌的时机都算好了。'],
        happy: ['你的一举一动我都记着。', '如我所料。', '你下注的时候，手抖了一下。', '你已经开始怀疑自己了。'],
        calm: ['让我看看你会怎么做。', '我不着急，牌桌会告诉我答案。', '先记一笔。']
      },
      callStation: 0.05,
      pushBB: 12,
      drift: 0.12,
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

  // ==================================================================
  // 策略漂移（strategy drift）
  //
  // 设计约束：AI 要有人味儿（不完全照本宣科），但主基调必须可辨识——
  // 匿名桌功能依赖玩家用 HUD 的 VPIP / PFR 反推「这是谁」。
  // 因此漂移是「围绕基准的小幅有界摆动」，不是人格随机切换。
  // ==================================================================

  /** 只允许倍率型保底偏离（相对）的最大值：VPIP / PFR ±35% */
  var DRIFT_HARD_LIMIT = 0.35;
  /** 「串味」概率：小概率向相邻人格靠拢 */
  var CROSS_RATE = 0.12;

  /**
   * 参与漂移的字段及其绝对 clamp 区间 [lo, hi]。
   * 概率类字段封到 [0,1]，系数类封到语义合理的倍数区间；
   * 区间同时充当「极端输入」保护（base 字段缺失或被人为改到离谱值时不会崩）。
   */
  var DRIFT_FIELDS = [
    ['vpip', 0.02, 0.95],
    ['pfr', 0.01, 0.90],
    ['aggression', 0.20, 2.40],
    ['bluffFreq', 0, 0.85],
    ['callThreshold', 0.55, 2.20],
    ['foldToAggression', 0, 0.95],
    ['tricky', 0, 0.75],
    ['cbetFreq', 0, 0.98],
    ['threeBetFreq', 0, 0.60],
    ['stealFreq', 0, 0.98],
    ['restealFreq', 0, 0.85],
    ['bluffCatchFreq', 0.02, 0.99],
    ['callStation', 0, 0.99],
    ['positionAware', 0, 1],
    ['noise', 0, 0.65]
  ];

  /** 不参与漂移的字段（原样保留）：情绪系统 / 序列化 / 短码推推乐依赖它们 */
  var FROZEN_FIELDS = ['moodVolatility', 'adaptivity', 'pushBB', 'tiltFactor', 'equitySamples'];

  /**
   * 相邻人格（「串味」时的参照对象）。
   * 刻意让 fish 孤立——它的 VPIP 必须与 rock 保持量级差距，
   * 否则匿名桌的可推断性断言会失效。
   */
  var NEIGHBORS = {
    fish: [],
    rock: ['tag', 'lag'],
    tag: ['rock', 'lag', 'solver'],
    lag: ['tag', 'rock', 'solver'],
    solver: ['tag', 'lag', 'boss'],
    boss: ['solver', 'tag', 'lag']
  };

  /**
   * 允许被「串味」拉扯的维度。
   * 刻意排除 vpip / pfr：这是身份指纹，永不允许向他人格靠拢，
   * 只接受围绕自身基准的小幅摆动。
   */
  var CROSS_FIELDS = ['aggression', 'bluffFreq', 'tricky', 'cbetFreq', 'stealFreq',
    'threeBetFreq', 'callThreshold', 'bluffCatchFreq', 'callStation', 'positionAware', 'noise'];

  /** 缺省漂移幅度（base 未提供 drift 时使用） */
  var DEFAULT_DRIFT = 0.14;

  function clamp(v, lo, hi) {
    if (!(v > lo)) v = lo;      // 同时兜住 NaN
    if (v > hi) v = hi;
    return v;
  }

  function numOrDefault(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }

  /** 把 base 解析成人格对象：支持 id 字符串 / 人格对象 / 脏数据兜底 */
  function resolveBase(base) {
    if (base && typeof base === 'object') return base;
    if (typeof base === 'string' && base) return get(base);
    return get('tag');
  }

  /** 对称扰动算子：返回 [-k, +k] 区间内的相对偏移量 */
  function wobble(rnd, k) {
    return (rnd() * 2 - 1) * k;
  }

  /**
   * 生成「本手临时人格」。
   *
   * 保留不变：id / name / avatar / difficulty / style / desc / color（身份与 UI），
   *          以及 moodVolatility / adaptivity / pushBB / tiltFactor / equitySamples
   *          （情绪系统、序列化和短码推推乐口径）。
   * 按 drift 做有界相对扰动：其余全部数值字段 + betSizing + preflopTop。
   * 硬保底：vpip / pfr 相对基准偏离 ≤ ±35%，且 pfr ≤ vpip。
   *
   * @param {Object|string} base 基准人格（对象或 id 字符串）
   * @param {Function} [rnd] 可注入随机源，默认 Math.random
   * @return {Object} 派生人格对象
   */
  function derive(base, rnd) {
    var p = resolveBase(base);
    var r = (typeof rnd === 'function') ? rnd : Math.random;
    var drift = clamp(numOrDefault(p.drift, DEFAULT_DRIFT), 0, 0.4);

    // 1) 浅拷贝全部自有字段 —— 任何新增/自定义字段都不会丢
    var out = {};
    for (var key in p) {
      if (Object.prototype.hasOwnProperty.call(p, key)) out[key] = p[key];
    }
    // betSizing 是嵌套对象，必须复制后再改，否则会污染基准人格
    var baseSizing = (p.betSizing && typeof p.betSizing === 'object') ? p.betSizing : {};
    out.betSizing = {
      value: numOrDefault(baseSizing.value, 0.66),
      bluff: numOrDefault(baseSizing.bluff, 0.55),
      polarize: numOrDefault(baseSizing.polarize, 0.3)
    };

    // 2) 逐字段有界相对扰动
    var i, f, name, lo, hi, raw, val;
    for (i = 0; i < DRIFT_FIELDS.length; i++) {
      f = DRIFT_FIELDS[i];
      name = f[0]; lo = f[1]; hi = f[2];
      raw = numOrDefault(p[name], numOrDefault(get(p.id)[name], 0));
      val = clamp(raw * (1 + wobble(r, drift)), lo, hi);
      out[name] = val;
    }

    // 3) preflopTop：起手牌范围，相对扰动上限 ±15%（比 ±35% 的 VPIP 更保守，
    //    因为「玩多少比例的牌」是最直观的身份特征）
    if (p.preflopTop != null && isFinite(p.preflopTop)) {
      var topStep = Math.min(drift, 0.15);
      out.preflopTop = clamp(p.preflopTop * (1 + wobble(r, topStep)), 0.08, 0.95);
    } else {
      out.preflopTop = null;
    }

    // 4) betSizing：下注尺度 ±10%，polarize 是布尔位不动
    var sizeStep = Math.min(drift, 0.10);
    out.betSizing.value = clamp(out.betSizing.value * (1 + wobble(r, sizeStep)), 0.25, 1.05);
    out.betSizing.bluff = clamp(out.betSizing.bluff * (1 + wobble(r, sizeStep)), 0.20, 1.00);
    out.betSizing.polarize = numOrDefault(baseSizing.polarize, 0.3);

    // 5) 小概率「串味」：向相邻人格靠拢 1~2 个非指纹维度 30%~50%
    if (drift > 0 && r() < CROSS_RATE) {
      var nb = NEIGHBORS[p.id] || [];
      if (nb.length) {
        var targetId = nb[Math.floor(r() * nb.length) % nb.length];
        var target = get(targetId);
        if (target) {
          var howMany = 1 + Math.floor(r() * 2);   // 1 或 2
          for (i = 0; i < howMany; i++) {
            var dim = CROSS_FIELDS[Math.floor(r() * CROSS_FIELDS.length) % CROSS_FIELDS.length];
            var tv = numOrDefault(target[dim], numOrDefault(out[dim], 0));
            var cur = numOrDefault(out[dim], 0);
            var moved = cur + (tv - cur) * (0.3 + r() * 0.2);
            // 串味后再套一次该字段的绝对区间
            for (var q = 0; q < DRIFT_FIELDS.length; q++) {
              if (DRIFT_FIELDS[q][0] === dim) {
                moved = clamp(moved, DRIFT_FIELDS[q][1], DRIFT_FIELDS[q][2]);
                break;
              }
            }
            out[dim] = moved;
          }
        }
      }
    }

    // 6) ---- 硬保底：VPIP / PFR 相对基准 ±35%（随机多久都不许越过）----
    var baseVpip = clamp(numOrDefault(p.vpip, 0.28), 0.02, 0.95);
    var basePfr = clamp(numOrDefault(p.pfr, 0.22), 0.01, 0.90);
    var vLo = baseVpip * (1 - DRIFT_HARD_LIMIT);
    var vHi = baseVpip * (1 + DRIFT_HARD_LIMIT);
    var pLo = basePfr * (1 - DRIFT_HARD_LIMIT);
    var pHi = basePfr * (1 + DRIFT_HARD_LIMIT);
    out.vpip = clamp(out.vpip, Math.max(0.02, vLo), Math.min(0.95, vHi));
    out.pfr = clamp(out.pfr, Math.max(0.01, pLo), Math.min(0.90, pHi));
    // 附加常识约束：加注率不可能超过入池率
    if (out.pfr > out.vpip) out.pfr = out.vpip;

    // 5b) ---- 「反常手」：低概率整手性格违和（约 7%）。
    //      只动 诈唬/持续下注/偷盲/3bet/跟注阈值 等决策杠杆，绝不碰 vpip/pfr/preflopTop/
    //      betSizing（那几项是 HUD 推断身份的统计口径，动了会毁掉匿名桌可辨识性）。
    //      效果：岩石老张偶尔突然凶一把、鱼突然紧得反常 —— 有戏剧性又不崩人设。
    var QUIRK_RATE = 0.07;
    if (drift > 0 && r() < QUIRK_RATE) {
      if (p.id === 'fish' || p.id === 'lag') {
        // 松派反常 = 突然收紧
        var fK = 0.15 + r() * 0.30;   // ×0.15~0.45
        out.bluffFreq = clamp(out.bluffFreq * fK, 0, 0.9);
        out.cbetFreq = clamp(out.cbetFreq * fK, 0, 0.95);
        out.stealFreq = clamp(out.stealFreq * fK, 0, 0.9);
        out.threeBetFreq = clamp(out.threeBetFreq * fK, 0, 0.6);
        out.callThreshold = clamp(out.callThreshold + 0.10 + r() * 0.12, 0, 1);
        out.quirkNote = p.id === 'fish' ? '今天怎么这么老实' : '这手突然不想玩了';
      } else {
        // 紧派/技术派反常 = 突然凶起来
        var fM = 1.7 + r() * 0.9;     // ×1.7~2.6
        out.bluffFreq = clamp(out.bluffFreq * fM, 0, 0.9);
        out.cbetFreq = clamp(out.cbetFreq * fM, 0, 0.95);
        out.stealFreq = clamp(out.stealFreq * (1.2 + r() * 0.8), 0, 0.9);
        out.threeBetFreq = clamp(out.threeBetFreq * (1 + r() * 1.2), 0, 0.7);
        out.quirkNote = p.id === 'rock' ? '难得躁动一次' : '手感来了，凶一把';
      }
    } else {
      out.quirkNote = '';
    }

    // 7) 冻结字段：以基准值写回，确保完全不被扰动
    for (i = 0; i < FROZEN_FIELDS.length; i++) {
      out[FROZEN_FIELDS[i]] = p[FROZEN_FIELDS[i]];
    }
    // 身份字段：即使 base 缺失也不允许被改写成别的人格
    out.id = p.id || 'tag';
    out.drift = p.drift;
    return out;
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
    derive: derive,
    DRIFT_HARD_LIMIT: DRIFT_HARD_LIMIT,
    DRIFT_FIELDS: DRIFT_FIELDS,
    FROZEN_FIELDS: FROZEN_FIELDS,
    NEIGHBORS: NEIGHBORS,
    stars: stars,
    moodLabel: moodLabel,
    moodEmoji: moodEmoji
  };

  Poker.Personalities = Personalities;
  if (typeof module !== 'undefined' && module.exports) module.exports = Personalities;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
