/* global window, global */
/**
 * brain.js —— AI 决策引擎。
 *
 * 设计原则：人格差异体现在「决策分支」上，而不只是参数微调。
 *
 * 翻牌前：用「起手牌百分位 + 入池范围(vpip) + 加注频率(pfr)」决策
 *         —— 翻前把胜率直接对比底池赔率是错误的（6 人桌随机牌胜率仅 16%），
 *            真实玩家靠的是范围与位置，不是当前底池赔率。
 * 翻牌后：用「真实胜率(vs 底池赔率) + 相对牌力 + 人格倾向」决策。
 *
 *   Fish   : 入池范围极宽，翻后只要有牌感就跟，几乎不弃牌
 *   Rock   : 只玩前 15% 起手牌，入池即重拳，边缘牌果断弃
 *   TAG    : 标准紧凶 —— 位置意识 + c-bet + 适度诈唬
 *   LAG    : 高频开火 / 3-bet / 半诈唬，用压力逼你犯错
 *   Solver : 严格 EV 近似 + 极化下注尺度 + 平衡诈唬
 *   Boss   : Solver + 玩家建模（读牌），动态改诈唬频率与跟注阈值
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  function treq(p) {
    try { return typeof require !== 'undefined' ? require(p) : null; } catch (e) { return null; }
  }
  var HE = Poker.HandEval || treq('../handEval.js');
  var EQ = Poker.Equity || treq('../equity.js');
  var PERS = Poker.Personalities || treq('./personalities.js');
  var ICM = Poker.ICM || treq('../icm.js');

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rnd() { return Math.random(); }
  function pct(x) { return Math.round(x * 100); }

  /**
   * 起手牌百分位：0.01 = AA/KK 顶级，1.0 = 最差牌。
   * 基于单挑随机牌胜率（preflopEquity1）查表插值。
   */
  var PF_TABLE = [
    [0.85, 0.010], [0.80, 0.020], [0.76, 0.040], [0.72, 0.060], [0.69, 0.080],
    [0.665, 0.100], [0.650, 0.130], [0.635, 0.150], [0.620, 0.180], [0.605, 0.210],
    [0.590, 0.250], [0.580, 0.280], [0.570, 0.310], [0.560, 0.350], [0.550, 0.400],
    [0.535, 0.450], [0.520, 0.500], [0.505, 0.550], [0.490, 0.600], [0.475, 0.660],
    [0.460, 0.720], [0.445, 0.780], [0.430, 0.850], [0.410, 0.920], [0.350, 1.000]
  ];

  function preflopTopPct(hole) {
    var e = EQ.preflopEquity1(hole);
    if (e >= PF_TABLE[0][0]) return PF_TABLE[0][1];
    for (var i = 1; i < PF_TABLE.length; i++) {
      if (e >= PF_TABLE[i][0]) {
        var e0 = PF_TABLE[i - 1][0], e1 = PF_TABLE[i][0];
        var p0 = PF_TABLE[i - 1][1], p1 = PF_TABLE[i][1];
        var t = (e0 - e) / (e0 - e1);
        return p0 + t * (p1 - p0);
      }
    }
    return 1.0;
  }

  /** 牌力文字（用于 reason） */
  function strengthWord(topPct) {
    if (topPct <= 0.05) return '顶级起手牌';
    if (topPct <= 0.15) return '很强的牌';
    if (topPct <= 0.30) return '不错的牌';
    if (topPct <= 0.55) return '边缘牌';
    return '垃圾牌';
  }

  /** 当前胜率：翻前启发式，翻后蒙特卡洛 */
  function equityOf(hole, board, numOpponents, samples) {
    if (!board || board.length === 0) return EQ.preflopEquity(hole, Math.max(1, numOpponents));
    return EQ.handStrength(hole, board, Math.max(1, numOpponents), samples || 300);
  }

  /**
   * 主决策入口。
   * ctx = { seat, table, playerModel }
   * 返回 {action:'fold'|'check'|'call'|'raise'|'allin', raiseTo, amount, reason, equity}
   */
  function decideCore(ctx) {
    var seat = ctx.seat;
    var table = ctx.table;
    var p = seat.personality || PERS.get('tag');
    var board = table.board || [];
    var street = table.street || 'preflop';
    var nOpp = Math.max(1, table.numOpponents || 1);
    var posFactor = typeof table.positionFactor === 'number' ? table.positionFactor : 0.5;
    var toCall = Math.max(0, (table.currentBet || 0) - (seat.bet || 0));
    var pot = Math.max(1, table.pot || 0);
    var potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    var facingBet = toCall > 0;
    var chips = Math.max(0, seat.chips || 0);
    var canRaise = chips > toCall;
    var raiseCount = table.raiseCount || 0;

    // ---- 偷鸡情境 ----
    var steal = !!table.stealOpportunity && posFactor > 0.55;   // 前位无人入池、我在后位 → 可偷盲
    var resteal = !!table.stealAttempt && raiseCount === 2;     // 对手疑似偷盲 → 可反偷
    var bigBet = toCall > pot * 0.65;                           // 面对大注 → 涉及抓诈唬

    // ---- 情绪（上头 / 得意）----
    var mood = seat.mood || 0;
    var vol = p.moodVolatility || 0;
    var moodTilt = mood < 0 ? (-mood / 100) * vol : 0;   // 0..1，越大越上头
    var moodConf = mood > 0 ? (mood / 100) * vol : 0;    // 0..1，越大越自信

    // ---- 对手关系：对「仇人」更凶、更不愿弃牌；对「软柿子」偷得更狠 ----
    var rivalRel = 0;
    if (seat.relations && table.aggressorId) rivalRel = seat.relations[table.aggressorId] || 0;
    var grudge = rivalRel < -15 ? (-rivalRel / 100) : 0;   // 记恨程度 0..1
    var bully = rivalRel > 15 ? (rivalRel / 100) : 0;      // 觉得好欺负 0..1

    // 相对牌力基准：N 个对手时随机牌胜率 = 1/(N+1)
    var baseline = 1 / (nOpp + 1);

    // A2/A3 牌面纹理状态：翻牌后由 postflop 段填充；翻前保持默认（不调整尺度）
    var texWet = false, texDry = false, texDryFrac = 1.0, texWetFrac = 1.0;

    if (seat) seat._icmUsed = false;   // B2：本决策是否触发了 ICM 收紧（供 reason 标注）

    // ---- B1 Boss 读对手客观历史（仅 adaptivity ≥ 0.85 的读牌大师）----
    var bossRead = null;
    if (p.id === 'boss' && p.adaptivity >= 0.85 && ctx.table && ctx.table.opponents) {
      var bestFcr = 0, anyTight = false, anyLoose = false;
      for (var oi = 0; oi < ctx.table.opponents.length; oi++) {
        var ob = ctx.table.opponents[oi];
        if (!ob || ob.hands < 15) continue;
        var fcr = (ob.cBetFaced >= 3) ? (ob.foldToCBet || 0) / ob.cBetFaced : 0;   // 样本不足不读
        if (fcr > bestFcr) bestFcr = fcr;
        if (ob.vpip != null) {
          if (ob.vpip < 0.18) anyTight = true;
          if (ob.vpip > 0.5) anyLoose = true;
        }
      }
      bossRead = { fcrHigh: bestFcr >= 0.45, tight: anyTight, loose: anyLoose };
    }

    // ---- B2 ICM：比赛 + 奖金结构下，「跟注可能掏空大半/出局」时收紧（仅 payouts 启用）----
    if (facingBet && toCall >= chips * 0.45 && ctx.table && ctx.table.icm && ICM &&
        typeof ICM.icmEquity === 'function') {
      var ic = ctx.table.icm;
      try {
        var stkF = ic.stacks.slice();
        stkF[ic.meIndex] = chips;                    // 弃牌：后手不变（不付 toCall）
        var stkW = ic.stacks.slice();
        stkW[ic.meIndex] = chips + (table.pot || 0);   // 赢下整池净得 chips+pot
        var stkL = ic.stacks.slice();
        stkL[ic.meIndex] = 0;                          // 输光出局 → 拿剩余最低名次
        var evF = ICM.icmEquity(stkF, ic.payouts)[ic.meIndex] || 0;
        var evW = ICM.icmEquity(stkW, ic.payouts)[ic.meIndex] || 0;
        var evL = ICM.icmEquity(stkL, ic.payouts)[ic.meIndex] || 0;
        var thDen = evW - evL;
        if (thDen > 1e-9) {
          var th = Math.max(0, (evF - evL) / thDen);
          if (th > potOdds + 1e-6) {
            potOdds = th;   // 用 ICM 盈亏平衡胜率替代纯筹码赔率参与比较 → 更倾向弃
            if (seat) seat._icmUsed = true;
          }
        }
      } catch (eIc) { /* ICM 不可用则忽略 */ }
    }

    function mk(action, raiseTo, amount, equity, reason) {
      return { action: action, raiseTo: raiseTo || 0, amount: amount || 0, reason: reason || '', equity: equity };
    }

    function raiseSize(kind) {
      var base = pot + toCall;
      var frac = kind === 'value' ? p.betSizing.value : p.betSizing.bluff;
      var mR = made || 0;
      // A3 动态尺度：翻牌后按「牌力 + 牌面纹理」微调（翻前保持原尺度）
      if (street !== 'preflop') {
        if (kind === 'value') {
          if (texWet && mR >= 2) frac *= 1.22;          // 湿面强牌（≥两对）→ 大价值
          else if (texDry && mR === 1) frac *= 0.92;    // 干面只有一对 → 略收着打
        } else {                                        // 诈唬 / 半诈唬
          if (texWet) frac *= 0.82;                     // 湿面易被抓，降尺度
          else if (texDry) frac *= 1.08;                // 干面更易偷成，略加大
        }
      }
      var target = (table.currentBet || 0) + Math.round(base * frac);
      var cap1 = (table.currentBet || 0) + Math.round(base * 1.0);   // 一般不超过 1×pot
      if (p.betSizing.polarize > 0.6 && kind === 'value') {
        // 极化人格：翻前维持原极化区间；翻后仅「湿面 + ≥两对」小概率超池 1.15~1.35×pot
        if (street === 'preflop') {
          target = Math.round((table.currentBet || 0) + base * (0.70 + 0.45 * rnd()));
        } else if (texWet && mR >= 2 && rnd() < 0.25) {
          target = Math.round((table.currentBet || 0) + base * (1.15 + 0.20 * rnd()));
        } else if (target > cap1) {
          target = cap1;
        }
      } else if (target > cap1) {
        target = cap1;
      }
      var minTo = (table.currentBet || 0) + Math.max(table.minRaise || table.bigBlind || 20, table.bigBlind || 20);
      return Math.max(target, minTo);
    }

    function mkRaise(kind, reason) {
      var target = raiseSize(kind);
      var total = (seat.bet || 0) + chips;
      if (target >= total) return mk('allin', total, chips, 0, reason + '（全下）');
      if (facingBet && target < (table.currentBet || 0) + (table.minRaise || 20)) {
        target = (table.currentBet || 0) + (table.minRaise || 20);
      }
      var cost = target - (seat.bet || 0);
      if (cost >= chips) return mk('allin', (seat.bet || 0) + chips, chips, 0, reason + '（全下）');
      return mk('raise', target, cost, 0, reason);
    }

    // =========================================================
    // 一、翻牌前：范围 + 位置 + 频率
    // =========================================================
    if (street === 'preflop') {
      var topPct = preflopTopPct(seat.hole);
      var needTop = (p.preflopTop != null ? p.preflopTop : p.vpip);
      var word = strengthWord(topPct);

      // 位置放宽 / 收紧
      needTop *= (1 + 0.5 * p.positionAware * (posFactor - 0.5));
      // 已投入筹码（大盲）→ 更愿意看翻牌
      if (toCall === 0) needTop *= 1.5;
      else if ((seat.bet || 0) >= (table.bigBlind || 20) && toCall <= (table.bigBlind || 20)) needTop *= 1.25;
      // 面对加注 → 收紧范围（foldToAggression 高的收得更紧）
      if (raiseCount >= 2) needTop *= (1 - 0.30 * clamp(1 - p.foldToAggression, 0, 1));
      if (raiseCount >= 3) needTop *= 0.65;
      // 残局（≤3 人有效对手）：短桌 3-bet 泛滥、成本相对高，被 3-bet 后别那么容易被吓跑（否则每手收盲无人看翻牌）
      if (nOpp <= 2 && raiseCount >= 2) needTop *= (1 + 0.16 * Math.min(2, raiseCount - 1));
      // 连败倾斜 + 情绪上头：越上头打得越松
      if (seat.consecutiveLosses >= 2) needTop *= (1 + p.tiltFactor * 0.5);
      needTop *= (1 + moodTilt * 0.35);
      // 噪声
      if (p.noise > 0) needTop *= (1 + (rnd() * 2 - 1) * p.noise * 0.5);
      // 短桌/残局（有效对手 ≤2）：盲注贵、牌局稀 ——
      // ① 我在盲注位且只面对单个开池(补差 ≤2.2BB)：便宜 defend，不让偷盲每次白拿
      //    （真实短桌 BB 对 2.2BB 开池普遍 defend 40-60%，石头人也挡到 ~50%）
      // ② 后位单次小额行动：范围也放宽一点
      if (nOpp <= 2 && raiseCount <= 1 && toCall > 0 && toCall <= (table.bigBlind || 20) * 2.2) {
        var defendCap = p.id === 'fish' ? 0.88 : p.id === 'rock' ? 0.50 : p.id === 'lag' ? 0.66 : 0.60;
        if ((seat.bet || 0) > 0) needTop = Math.max(needTop, defendCap);
        else needTop *= 1.45;
      }
      // 残局弃牌连击：连续弃 2 手起范围逐级放宽（盲注越磨越该出手），专治「一直弃牌」的观感
      var fStrk = seat._foldStreak || 0;
      if (nOpp <= 2 && fStrk >= 2) needTop *= (1 + Math.min(0.55, (fStrk - 1) * 0.16));
      if (nOpp <= 2 && fStrk >= 4) needTop = Math.max(needTop, p.id === 'rock' ? 0.45 : 0.62); // 连弃 4+ 后“憋不住”保底

      // ---- 短码推推乐：后手 ≤ pushBB×BB → 全下/弃牌优先，不再小额墨迹 ----
      var bbN = table.bigBlind || 20;
      var stackBB = chips / bbN;
      var pushBB = (p.pushBB != null) ? p.pushBB : 12;
      if (stackBB <= pushBB) {
        // 越短推得越宽：刚到阈值≈常规范围，1BB 时几乎任何可玩牌都推
        var urgency = Math.min(1, (pushBB - stackBB) / pushBB);          // 0(临界)..1(1BB)
        var pushTop = clamp((p.preflopTop != null ? p.preflopTop : p.vpip) + 0.18 * urgency + 0.06, 0.03, 0.85);
        if (nOpp <= 2) pushTop = Math.min(0.92, pushTop * 1.20);   // 残局推挤范围加宽，别一手手交盲注
        if ((seat._foldStreak || 0) >= 3) pushTop = Math.min(0.95, pushTop * 1.25); // 连弃多手后短码也憋不住要推
        pushTop *= (1 + 0.35 * p.positionAware * Math.max(0, posFactor - 0.5)); // 后位放宽
        var fish = p.id === 'fish';
        var allinTotal = (seat.bet || 0) + chips;
        var shove = function (why) { return mk('allin', allinTotal, chips, 0, why); };

        // ① 偷盲位（前位全弃、我后位）：范围内直接全下抢盲，最省事最有压迫
        if (steal && topPct <= pushTop) return shove('后手不多，直接全下抢盲。');
        // ② 大盲免费看牌：有料就全下收池，没料免费看翻牌
        if (toCall === 0) {
          if (topPct <= pushTop && raiseCount === 0) return shove('免费看牌？不如全下收池。');
          return mk('check', 0, 0, 0, word + '，免费看翻牌，不推。');
        }
        // ③ 面对下注/加注：强牌直接反推全下；只在盲注位超便宜(≤1BB 且赔率极高)才小补；否则弃
        var needEq = toCall / (pot + toCall);
        if (seat && seat._icmUsed) needEq = Math.min(0.92, needEq * 1.25); // B2 ICM：短码跟注也需更高胜率
        var approxEq = Math.max(0.08, Math.min(0.92, 0.5 + (0.5 - topPct) * 0.45));
        var strongHand = topPct <= pushTop * 0.75;
        // 盲注位补码：已投入盲注 + 跟注额 ≤1BB + 底池赔率极好 → 允许小额跟注看翻牌（其余一律不磨蹭）
        var bbFill = (seat.bet || 0) > 0 && toCall <= bbN * 1.1 && needEq <= 0.25;
        var cheapCall = fish ? (approxEq >= needEq + 0.02) : (bbFill && approxEq >= needEq + 0.08);
        if (strongHand && canRaise && toCall < chips * 0.6) {
          return shove(word + '，短码反推，不给你看便宜翻牌。');
        }
        if (strongHand || cheapCall) {
          return mk('call', 0, Math.min(toCall, chips), 0,
            (strongHand ? word + '，短码接了。' : '盲注位赔率太好，' + word + '，补一下看翻牌。'));
        }
        return mk('fold', 0, 0, 0, word + '，后手珍贵，不在推送范围，弃。');
      }

      // ---- 反偷：对手在后位偷盲，我用 3-bet 反击 ----
      if (resteal && canRaise && topPct < 0.88 && rnd() < p.restealFreq * (1 + moodTilt * 0.5)) {
        var rw = p.id === 'lag' ? '想偷我的盲？反加！'
          : p.id === 'boss' ? '你在偷盲，我读到了——反加。'
            : p.id === 'solver' ? '你的偷盲范围太宽，3-bet 惩罚。'
              : p.id === 'rock' ? '（皱眉）这手我不能再让了。'
                : '反加注，不能让你白拿盲注。';
        return mkRaise('bluff', rw);
      }

      // ---- 偷盲：前位都弃牌，我在后位开火 ----
      if (steal) {
        var stealRange = 0.5 + p.stealFreq * 0.5;   // 越爱偷，范围越宽
        var stealNow = p.stealFreq;
        if (bossRead) {
          if (bossRead.tight) { stealRange += 0.12; stealNow = Math.min(0.95, stealNow * 1.2); } // 对手太紧→偷盲范围放宽
          else if (bossRead.loose) { stealRange -= 0.10; stealNow = Math.max(0.01, stealNow * 0.85); } // 对手很松→少偷等价值
        }
        if (topPct <= stealRange && rnd() < stealNow * (1 + moodConf * 0.4)) {
          var sw = bossRead && bossRead.tight ? '他太紧，偷他没商量。'
            : bossRead && bossRead.loose ? '他很松，少偷，等价值再上。'
              : p.id === 'lag' ? '都弃牌？那这池归我了——加注偷盲！'
                : p.id === 'solver' ? '盲注无人防守，按范围加注偷池。'
                  : p.id === 'boss' ? '你们都不敢玩，那我来收这个池。'
                    : p.id === 'tag' ? '后位偷盲，标准操作。'
                      : p.id === 'rock' ? '位置好，这手可以偷。'
                        : '加注试试……';
          return mkRaise('bluff', sw);
        }
      }

      if (topPct > needTop) {
        if (toCall === 0) return mk('check', 0, 0, 0, word + '，先免费看翻牌。');
        return mk('fold', 0, 0, 0, word + '，不在我的开局范围里，弃。');
      }

      // 在范围内：决定加注还是跟注
      var raiseProb;
      if (raiseCount >= 1) {
        raiseProb = clamp(p.threeBetFreq / Math.max(p.vpip, 0.05) * 0.8, 0, 0.9);
      } else {
        raiseProb = clamp(p.pfr / Math.max(p.vpip, 0.05), 0, 0.95);
      }
      if (topPct <= 0.08) raiseProb = Math.min(0.97, raiseProb + 0.25); // 超强牌几乎必加
      // Boss 翻前读人：对手弃牌越多，越敢主动加注施压
      if (p.id === 'boss' && p.adaptivity > 0) {
        var pmP = ctx.playerModel;
        if (pmP && pmP.hands >= 6) {
          var frP = pmP.foldToBet != null ? pmP.foldToBet : 0.35;
          raiseProb = clamp(raiseProb + (frP - 0.35) * 1.2, 0, 0.95);
        } else {
          raiseProb = clamp(raiseProb + 0.02, 0, 0.95);
        }
      }

      if (canRaise && rnd() < raiseProb) {
        var rword = raiseCount >= 1 ? '再加注' : '加注';
        var why;
        if (p.id === 'fish') why = '我牌挺好，加注！';
        else if (p.id === 'rock') why = '等的就是这手牌，' + rword + '。';
        else if (p.id === 'lag') why = '位置在手，开火——' + rword + '施压。';
        else if (p.id === 'solver') why = '这手牌在我的' + rword + '范围里。';
        else if (p.id === 'boss') why = '你在我的射程内，' + rword + '。';
        else why = word + '，' + rword + '入池。';
        return mkRaise('value', why);
      }
      if (toCall === 0) return mk('check', 0, 0, 0, word + '，过牌看翻牌。');
      return mk('call', 0, Math.min(toCall, chips), 0,
        (p.id === 'fish' ? '我想看翻牌，跟。' : word + '，跟注入池。'));
    }

    // =========================================================
    // 二、翻牌后：胜率 + 底池赔率 + 人格
    // =========================================================
    var eq = EQ.handStrength(seat.hole, board, nOpp, p.equitySamples);
    var eqRaw = eq;
    if (p.noise > 0) eq = clamp(eq + (rnd() * 2 - 1) * p.noise * 0.22, 0.01, 0.99);
    if (seat.consecutiveLosses >= 2) eq = clamp(eq + p.tiltFactor * 0.05, 0.01, 0.99);

    var draw = EQ.detectDraw(seat.hole, board);
    var made = draw.madeRank || 0;
    var hasDraw = draw.flushDraw || draw.straightDraw;
    var drawName = draw.flushDraw ? '听花' : (draw.straightDraw ? '听顺' : '');

    var rel = eq / baseline;               // 相对牌力
    var strong = rel >= 1.7;
    var medium = rel >= 1.05;
    var weak = rel < 0.75;
    var isAllInCall = toCall >= chips;

    // A2 牌面纹理：干/湿 影响 c-bet 频率与诈唬概率；下注尺度在 raiseSize 内使用
    var tx = EQ.boardTexture(board);
    texDry = tx.wet === 0;
    texWet = tx.wet === 2;
    texDryFrac = texDry ? 1.15 : 1.0;   // 干面 c-bet / 纯偷 概率加成
    texWetFrac = texWet ? 0.75 : 1.0;   // 湿面 空气诈唬 概率削减

    // Boss 读牌：按玩家历史模型动态调整
    var bluffAdj = 0, callAdj = 0;
    if (p.adaptivity > 0 && ctx.playerModel && ctx.playerModel.hands >= 6) {
      var pm = ctx.playerModel;
      var foldRate = pm.foldToBet != null ? pm.foldToBet : 0.35;
      var loose = pm.vpip != null ? pm.vpip : 0.30;
      bluffAdj = (foldRate - 0.35) * 1.1 * p.adaptivity;
      callAdj = (loose - 0.30) * 0.8 * p.adaptivity;
    } else if (p.id === 'boss') {
      bluffAdj = 0.04;   // 还没读透对手时也保持范围侵略性
    }
    var bluffFreq = clamp(p.bluffFreq + bluffAdj, 0.01, 0.75);
    var callThreshold = clamp(p.callThreshold + callAdj, 0.6, 2.0);

    // 抓诈唬：面对大注时，多疑的 AI 更愿意跟（fish 爱跟、rock 容易弃）
    var catchBonus = bigBet ? ((p.bluffCatchFreq || 0.5) - 0.5) * 0.25 : 0;
    // 记恨：对这个人特别不想弃牌（硬 call / 反加），被偷过就会盯着他打
    var grudgeBonus = grudge * 0.55;
    callThreshold = clamp(callThreshold + catchBonus + moodTilt * 0.35 + grudgeBonus, 0.6, 2.4);
    // 记恨也会让人更想反打回去
    bluffFreq = clamp(bluffFreq + moodTilt * 0.32 + moodConf * 0.12 + grudge * 0.22 + bully * 0.25, 0.01, 0.85);
    var stealBoost = (!facingBet && nOpp <= 2) ? 1.45 : 1.0;

    // B1 Boss：读「活人」客观历史后微调诈唬频率（幅度克制 ≤1.2；仅 boss 消费，rock/fish/solver 不启用）
    var bossNote = '';
    var bossValueNote = '';
    if (bossRead && bossRead.fcrHigh) { bluffFreq = clamp(bluffFreq * 1.2, 0.01, 0.85); bossNote = '他老弃牌，压他。'; }
    else if (bossRead && bossRead.loose) { bluffFreq = clamp(bluffFreq * 0.8, 0.01, 0.75); bossNote = '他很松，少诈多价值。'; bossValueNote = '他很松，价值打厚。'; }

    var isAggressor = table.aggressorId === seat.id;

    // ---- B3 慢打陷阱线：仅 tricky 型人格（tag/lag/solver/boss；rock/fish 基本不用）----
    if (p.tricky >= 0.15) {
      // 收网：上一街慢打跟注后，这街无人下注 → 主动打大注/全下收价值
      if (seat._trap && !facingBet && (made || 0) >= 2 && canRaise) {
        seat._trap = false;
        var tbTotal = (seat.bet || 0) + chips;
        var tb = (table.currentBet || 0) + Math.round((pot + toCall) * 0.8);
        if (tb >= tbTotal) return mk('allin', tbTotal, chips, eq, '陷阱收网，全下收价值。');
        return mk('raise', tb, tb - (seat.bet || 0), eq, '陷阱收网，下注收价值。');
      }
      // 设陷阱：已成强牌（≥两对）面对下注 → 小概率跟注慢打而非加注
      if (facingBet && !seat._trap && !seat._trapDone && !isAllInCall && (made || 0) >= 2) {
        var remainAfter = chips - Math.min(toCall, chips);
        if (remainAfter >= pot * 0.6) {                       // 防呆 a：后手太少不慢打
          var trapP = p.tricky * 0.4;
          if (texWet) trapP *= 0.5;                           // 防呆 b：极湿面风险减半
          if (rnd() < trapP) {
            seat._trap = true;
            seat._trapDone = true;                            // 防呆 c：每座位每手至多一次
            return mk('call', 0, Math.min(toCall, chips), eq, '慢打，等你上钩。');
          }
        }
      }
    }

    // ---- Fish：跟注站 ----
    if (p.id === 'fish') {
      var anyHope = eq > baseline * 0.9 || made >= 2 || hasDraw || rnd() < 0.30;
      if (facingBet) {
        if (isAllInCall) {
          if (eq * callThreshold > potOdds || made >= 2 || rnd() < 0.4) {
            return mk('call', 0, chips, eq, '我这里有牌，全都跟了！');
          }
          return mk('fold', 0, 0, eq, '太多了……这把算了。');
        }
        if (anyHope || rnd() < p.callStation * 0.55) {
          if (made >= 3 && rnd() < 0.35) return mkRaise('value', '我中了！加注！');
          return mk('call', 0, Math.min(toCall, chips), eq, made >= 2 ? '我有牌，跟。' : '我想看下一张牌。');
        }
        return mk('fold', 0, 0, eq, '太大了，我跟不动。');
      }
      if (made >= 3 && rnd() < 0.45) return mkRaise('value', '我牌不错，下注试试。');
      if (made >= 5 && rnd() < p.tricky + 0.25) return mk('check', 0, 0, eq, '我慢慢来……（其实牌很大）');
      return mk('check', 0, 0, eq, '过牌看看。');
    }

    // ---- Rock：入池即强牌 ----
    if (p.id === 'rock') {
      if (facingBet) {
        if (eq * callThreshold <= potOdds || eq < baseline * 1.2) {
          if (made >= 4) return mkRaise('value', '我等的就是这手牌，加注。');
          return mk('fold', 0, 0, eq, '我的牌配不上这个底池，弃。');
        }
        if (strong && canRaise) return mkRaise('value', '牌力足够，加注收池。');
        return mk('call', 0, Math.min(toCall, chips), eq, '底池赔率合适，跟。');
      }
      if (strong && canRaise) return mkRaise('value', '好牌就该下注，不留情面。');
      if (medium || hasDraw) return mk('check', 0, 0, eq, '先看一张免费牌。');
      return mk('check', 0, 0, eq, '过牌。');
    }

    // ---- TAG：教科书紧凶 ----
    if (p.id === 'tag') {
      if (!facingBet) {
        if (isAggressor && rnd() < p.cbetFreq * texDryFrac) {
          if (medium || hasDraw || rnd() < p.bluffFreq * texWetFrac * texDryFrac) {
            var txTag = texDry ? '牌面干燥，持续施压。' : (texWet ? '牌面湿润，诈唬降频。' : '');
            return mkRaise(medium ? 'value' : 'bluff',
              (medium ? '持续下注，我有牌面优势。' : '我开火，抢这个底池。') + txTag);
          }
        }
        if (strong && canRaise) return mkRaise('value', '牌力领先，做价值下注。');
        return mk('check', 0, 0, eq, texWet ? '牌面湿润，不敢乱开火，过牌。' : (medium ? '控制底池，先看牌。' : '过牌。'));
      }
      if (raiseCount >= 2 && rel < 1.5 && rnd() < p.foldToAggression + 0.25) {
        return mk('fold', 0, 0, eq, '面对再加注，我的牌不够，弃。');
      }
      if (eq * callThreshold > potOdds) {
        if (hasDraw && posFactor > 0.5 && canRaise && rnd() < 0.45) {
          return mkRaise('bluff', '我有' + drawName + '，半诈唬加注——既能偷池也能成牌。');
        }
        if (strong && canRaise && rnd() < p.aggression * 0.6) {
          return mkRaise('value', '我领先，加注拿价值。');
        }
        return mk('call', 0, Math.min(toCall, chips), eq, '底池赔率划算，跟注。');
      }
      if (hasDraw && potOdds < 0.20) return mk('call', 0, Math.min(toCall, chips), eq, '便宜，追一张' + drawName + '。');
      return mk('fold', 0, 0, eq, '胜率 ' + pct(eq) + '% 撑不起 ' + pct(potOdds) + '% 的赔率，弃牌。');
    }

    // ---- LAG：松凶压迫 ----
    if (p.id === 'lag') {
      var pressure = p.aggression * 0.45 + (posFactor - 0.5) * 0.4;
      if (!facingBet) {
        var huFire = nOpp === 1;
        var firedL = false;
        var whyL = '';
        if (street === 'flop') {
          // 翻牌：维持高频 c-bet（松凶的核心施压点，即使空气也常开火）
          // 干面整体加成；湿面「纯空气」开火打折（有牌/听牌不受影响）
          var airL = !(rel >= 1.1) && !hasDraw && (made || 0) < 2;
          var flopChance = p.cbetFreq * (0.7 + pressure) * texDryFrac * (airL ? texWetFrac : 1.0);
          if (rnd() < flopChance) {
            firedL = true;
            whyL = rel >= 1.1 ? '主动开火，我有牌。'
              : (texDry ? '牌面干燥，空气也压你一枪。' : '不管有没有牌，我先打——压力在我这边。');
          } else if (medium && canRaise) {
            return mkRaise('value', '下注拿价值。');
          }
        } else {
          // 转牌 / 河牌：收敛纯空气三连开 —— 有牌/听牌才继续压；单挑才偶尔偷一枪
          if (medium || hasDraw || rel >= 1.1) {
            if (rnd() < p.cbetFreq * (0.55 + pressure * 0.6) * texDryFrac) {
              firedL = true;
              whyL = hasDraw && !medium ? ('我有' + drawName + '，半诈唬继续压。') : '转河有牌就继续打，不给你免费看。';
            }
          } else if (huFire && rnd() < p.bluffFreq * 0.5 * texWetFrac * texDryFrac) {
            firedL = true;
            whyL = texWet ? '单挑湿面偷一枪，只此一次。' : '单挑就偷你一枪。';
          }
        }
        if (firedL) {
          return mkRaise(rel >= 1.1 ? 'value' : 'bluff', whyL);
        }
        return mk('check', 0, 0, eq, texWet ? '牌面湿润，先稳一手，过牌。' : '这回先过牌，下一枪再说。');
      }
      if (raiseCount >= 1 && rnd() < p.threeBetFreq * 1.5 && canRaise && (rel >= 1.1 || rnd() < p.bluffFreq)) {
        return mkRaise(rel >= 1.1 ? 'value' : 'bluff',
          rel >= 1.1 ? '反加！我的牌不比你差。' : '再加注——你敢跟吗？');
      }
      if (eq * callThreshold > potOdds) {
        if ((medium || hasDraw) && canRaise && rnd() < 0.5) {
          return mkRaise(hasDraw && !medium ? 'bluff' : 'value', '加注施压，不给你看便宜牌。');
        }
        return mk('call', 0, Math.min(toCall, chips), eq, '底池赔率还行，跟。');
      }
      if (rnd() < p.bluffFreq * 0.6 && canRaise && nOpp <= 2) {
        return mkRaise('bluff', '我觉得你会弃牌——加注偷池。');
      }
      return mk('fold', 0, 0, eq, '这把牌不行，放弃。');
    }

    // ---- Solver / Boss：EV 近似 + 极化尺度 ----
    var evEdge = eq - potOdds;
    if (!facingBet) {
      if (strong && canRaise) return mkRaise('value', '胜率 ' + pct(eq) + '%，做价值下注。' + (p.id === 'boss' && bossValueNote ? bossValueNote : ''));
      if (medium && hasDraw && canRaise && rnd() < 0.5) {
        return mkRaise('bluff', '有' + drawName + '，半诈唬——成牌或偷池都有收益。');
      }
      if (weak && canRaise && rnd() < bluffFreq * stealBoost * (0.6 + 0.5 * posFactor) * texWetFrac * texDryFrac) {
        var whyBluffS = p.id === 'boss' ? '我读过你的弃牌率，这一枪你接不住。' : '平衡范围，这里需要一定频率的诈唬。';
        if (texDry) whyBluffS += '（牌面干燥，容易偷成）';
        else if (texWet) whyBluffS += '（牌面湿润，偶尔才开一枪）';
        if (p.id === 'boss' && bossNote) whyBluffS += bossNote;
        return mkRaise('bluff', whyBluffS);
      }
      if (medium && canRaise && rnd() < 0.25) return mkRaise('value', '领先一点，下注保护。');
      if (strong && rnd() < p.tricky) return mk('check', 0, 0, eq, '慢打一手，让你先进来。');
      return mk('check', 0, 0, eq, texWet ? '牌面湿润，控制底池，过牌。' : '过牌，控制底池。');
    }

    if (evEdge > 0.10 && canRaise && (strong || (hasDraw && rnd() < 0.55))) {
      return mkRaise(strong ? 'value' : 'bluff',
        strong ? '我的胜率 ' + pct(eq) + '% 远超赔率 ' + pct(potOdds) + '%，加注拿价值。' + (p.id === 'boss' && bossValueNote ? bossValueNote : '')
          : '听牌加注：成牌能赢大池，不成也能逼你弃。');
    }
    if (evEdge > -0.02) {
      if (isAllInCall) {
        if (evEdge > 0.02) return mk('call', 0, chips, eq, '赔率够，全下跟了。');
        return mk('fold', 0, 0, eq, '赔率不够，全下不划算，弃。');
      }
      return mk('call', 0, Math.min(toCall, chips), eq, '胜率 ' + pct(eq) + '% ≥ 赔率 ' + pct(potOdds) + '%，跟注。');
    }
    // 轻微负 EV 时的防御性跟注：有对子/成牌/听牌且价格不离谱 → 抓诈唬、保护范围，避免被过度剥削
    var defend = (made >= 1 && potOdds < 0.34) || (made >= 2 && potOdds < 0.48 && nOpp <= 2) ||
                 (made >= 3 && potOdds < 0.58) || (hasDraw && potOdds < 0.28);
    if (defend) {
      return mk('call', 0, Math.min(toCall, chips), eq,
        '有' + (made >= 3 ? '牌力' : (made >= 1 ? '对子' : '听' + drawName)) + '，价格能接受，跟注防守。');
    }
    if (weak && canRaise && rnd() < bluffFreq * 0.5 && nOpp <= 2) {
      return mkRaise('bluff', p.id === 'boss' ? '你最近弃牌偏多，这里我加注偷。' : '范围需要诈唬，加注。');
    }
    if (hasDraw && potOdds < 0.3 && !isAllInCall) {
      return mk('call', 0, Math.min(toCall, chips), eq, '底池赔率够追' + drawName + '，跟。');
    }
    return mk('fold', 0, 0, eq, '胜率 ' + pct(eq) + '% 低于底池赔率 ' + pct(potOdds) + '%，弃牌。');
  }

  /**
   * 情绪台词：让 AI 在心态波动时说「人话」，而不仅是策略理由。
   * 情绪越极端，越可能冒出情绪化发言。
   */
  function flavor(seat, p, reason) {
    var mood = seat.mood || 0;
    var am = Math.abs(mood);
    if (am < 30 || !p.moodLines) return reason;
    var lines = mood > 0 ? p.moodLines.happy : p.moodLines.tilt;
    if (!lines || !lines.length) return reason;
    var chance = (am - 30) / 100;   // 30分→0%，100分→70%
    if (rnd() < chance) return lines[Math.floor(rnd() * lines.length)];
    return reason;
  }

  /**
   * 针对「特定对手」的台词：被偷过就会盯着他打，觉得好欺负就反复偷。
   */
  function rivalFlavor(ctx, r) {
    var seat = ctx.seat;
    var ag = ctx.table && ctx.table.aggressorId;
    if (!ag || !seat.relations) return r.reason;
    var rel = seat.relations[ag] || 0;
    var p = seat.personality;
    if (rel <= -25 && (r.action === 'call' || r.action === 'raise' || r.action === 'allin') && rnd() < 0.45) {
      var lines = [
        '又是你——这把我不跑了。',
        '上次那手我记着，跟到底。',
        '你偷我的，我得拿回来。'
      ];
      if (p && p.id === 'solver') return '对你，我的跟注范围要放宽。';
      if (p && p.id === 'rock') return '（盯着你）这手我不让了。';
      return lines[Math.floor(rnd() * lines.length)];
    }
    if (rel >= 25 && (r.action === 'raise' || r.action === 'allin') && rnd() < 0.35) {
      return '你前几次都弃了，这次也一样吧？';
    }
    return r.reason;
  }

  /** 对外主入口：决策 + 情绪台词包装 */
  function decide(ctx) {
    var r = decideCore(ctx);
    if (ctx.seat && ctx.seat.personality) {
      r.reason = flavor(ctx.seat, ctx.seat.personality, r.reason);
      r.reason = rivalFlavor(ctx, r);
      if (ctx.seat._icmUsed && (r.action === 'fold' || r.action === 'check')) {
        r.reason = (r.reason || '') + '（ICM 保护名次，不拿锦标赛生命冒险）';
      }
    }
    return r;
  }

  var Brain = {
    decide: decide,
    decideCore: decideCore,
    equityOf: equityOf,
    preflopTopPct: preflopTopPct
  };

  Poker.Brain = Brain;
  if (typeof module !== 'undefined' && module.exports) module.exports = Brain;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
