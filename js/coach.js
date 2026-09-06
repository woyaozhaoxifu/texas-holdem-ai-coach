/* global window, global */
/**
 * coach.js —— 教学引擎。
 *
 * 1) 知识点库 COACH_TIPS（课堂面板 + 复盘卡片）
 * 2) judge()：对单个决策点给出「推荐打法 + 判定 + 量化代价 + 中文点评」
 * 3) suggest()：玩家行动前的实时提示条（胜率 / 底池赔率 / 建议）
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  function treq(p) {
    try { return typeof require !== 'undefined' ? require(p) : null; } catch (e) { return null; }
  }
  var Equity = Poker.Equity || treq('./equity.js');
  var Brain = Poker.Brain || treq('./ai/brain.js');

  function pct(x) { return Math.round(x * 100); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ============ 知识点库 ============
  var COACH_TIPS = [
    {
      id: 'pot_odds', title: '底池赔率',
      body: '你需要跟注的金额 ÷（当前底池 + 跟注额）= 底池赔率。只要你的胜率高于这个数字，长期跟注就是赚钱的。例：底池 100，要跟 50，赔率就是 33%，你的胜率超过 33% 就该跟。'
    },
    {
      id: 'equity', title: '胜率与 Outs',
      body: '胜率是你最终赢下这手牌的概率。听牌时常用「outs × 2 + 1」估算河牌成牌率（翻牌圈乘 4）。听花 9 张outs，转牌成牌率约 19%。'
    },
    {
      id: 'position', title: '位置优势',
      body: '越晚行动越有信息优势。按钮位（BTN）能看到所有人的选择再决定，因此可以用更宽的牌入池；枪口位（UTG）要用最强的牌。'
    },
    {
      id: 'value_bet', title: '价值下注',
      body: '当你大概率领先时下注，目的是让比你差的牌跟注。不下注就赚不到额外的钱——很多新手输在「该下注时过牌」。'
    },
    {
      id: 'bluff', title: '诈唬与弃牌赢率',
      body: '诈唬的收益 = 底池 × 对手弃牌概率。对手越紧、牌面越吓人，诈唬成功率越高。对跟注站（几乎不弃牌的玩家）诈唬是送钱。'
    },
    {
      id: 'semi_bluff', title: '半诈唬',
      body: '拿着听牌加注：对手弃牌你立刻赢池，对手跟注你还有成牌机会。两手准备，比纯诈唬安全得多。'
    },
    {
      id: 'cbet', title: '持续下注（c-bet）',
      body: '翻牌前加注者，在翻牌后继续下注，称为持续下注。因为你在翻前有主动权，对手没中牌时往往只能弃牌。'
    },
    {
      id: 'slowplay', title: '慢打（设陷阱）',
      body: '拿到超强牌时过牌或跟注，引诱对手下注。适合对手激进、牌面干燥时；但让对手免费看牌有被反超的风险，慎用。'
    },
    {
      id: 'pot_control', title: '底池控制',
      body: '中等牌力时，避免把底池做大。过牌跟注可以把损失控制在小池——不是每手牌都要决出胜负。'
    },
    {
      id: 'allin', title: '全下时机',
      body: '全下等于把全部筹码押上。值得全下的情况：牌力远超对手范围、或短码时用弃牌赢率抢池。千万不要用中等牌力去接别人的全下。'
    },
    {
      id: 'range', title: '范围思维',
      body: '不要猜对手"是哪一手牌"，要判断他"可能有哪些牌"（范围）。对手在按钮位加注，范围可能包含 30% 的牌；他枪口位加注，范围可能只有 8%。'
    },
    {
      id: 'calling_station', title: '怎么打跟注站',
      body: '面对几乎不弃牌的玩家：停止诈唬，只做价值下注，把下注额加大。他跟到底，你就用真牌收他。'
    },
    {
      id: 'vs_lag', title: '怎么打松凶玩家',
      body: '他频繁加注不代表有牌。对付方法：用好牌埋伏他、放宽跟注范围、在他诈唬过头的河牌圈果断跟注抓他。'
    },
    {
      id: 'tilt', title: '控制情绪（Tilt）',
      body: '连续输牌后容易上头，开始乱打。设定止损：连输三手大池就站起来休息。情绪化决策是最大的长期亏损来源。'
    },
    {
      id: 'fold_equity', title: '弃牌赢率',
      body: '你的加注能让对手弃牌的概率。弃牌赢率高时，即使牌力差也可以加注；对手是跟注站时，弃牌赢率接近 0。'
    }
  ];

  var TIP_BY_ID = {};
  for (var i = 0; i < COACH_TIPS.length; i++) TIP_BY_ID[COACH_TIPS[i].id] = COACH_TIPS[i];

  // ============ 决策点评 ============
  /**
   * @param {Object} d 决策点快照（game.js handLog 中的一条）
   * @return {Object} {verdict, recommended, reason, evLoss, tipIds}
   */
  function judge(d) {
    var eq = d.equity != null ? d.equity : 0.5;
    var potOdds = d.potOdds || 0;
    var toCall = d.toCall || 0;
    var pot = Math.max(1, d.potBefore || 1);
    var nOpp = Math.max(1, d.numOpponents || 1);
    var baseline = 1 / (nOpp + 1);
    var rel = eq / baseline;
    var evEdge = eq - potOdds;
    var action = d.action;
    var hasDraw = false;
    try {
      var dr = Equity.detectDraw(d.hole || [], d.board || []);
      hasDraw = dr.flushDraw || dr.straightDraw;
    } catch (e) { hasDraw = false; }

    var recommended, reason, verdict, evLoss = 0;
    var facingBet = toCall > 0;
    var isPre = d.street === 'preflop';

    // ---- 翻牌前：按起手牌范围判断（多人桌的"对全桌胜率"会误导，这里不看它）----
    if (isPre) {
      var topPct = (Brain && d.hole && d.hole.length === 2) ? Brain.preflopTopPct(d.hole) : 0.5;
      var bb = d.bb || 20;
      var cheap = toCall <= Math.round(bb * 1.5);
      if (toCall === 0) {
        recommended = topPct <= 0.30 ? 'raise' : 'check';
        reason = topPct <= 0.30
          ? '这手起手牌排前 ' + Math.round(topPct * 100) + '%，加注建立优势、拿主动权。'
          : '起手牌一般（前 ' + Math.round(topPct * 100) + '%），免费看翻牌即可。';
      } else if (cheap) {
        recommended = topPct <= 0.55 ? 'call' : 'fold';
        reason = topPct <= 0.55
          ? '只需要补 ' + toCall + ' 就能入池（底池赔率 ' + pct(potOdds) + '%），这手牌值得看翻牌。'
          : '起手牌太弱（前 ' + Math.round(topPct * 100) + '%），为看翻牌付钱不划算，弃牌。';
      } else {
        recommended = topPct <= 0.12 ? 'raise' : (topPct <= 0.35 ? 'call' : 'fold');
        reason = topPct <= 0.12
          ? '顶级起手牌（前 ' + Math.round(topPct * 100) + '%），反加回去打大池。'
          : topPct <= 0.35
            ? '起手牌不错（前 ' + Math.round(topPct * 100) + '%），跟注 ' + toCall + ' 的赔率可以接受。'
            : '对手加注 ' + toCall + '，你的起手牌只排前 ' + Math.round(topPct * 100) + '%，弃牌等更好的机会。';
      }
    } else
    // ---- 翻牌后：胜率 vs 底池赔率 ----
    if (!facingBet) {
      if (rel >= 1.7) {
        recommended = 'raise';
        reason = '你的胜率 ' + pct(eq) + '%，明显领先——应该下注拿价值，让比你差的牌跟进来。';
      } else if (hasDraw && rel >= 0.8) {
        recommended = 'raise';
        reason = '你有听牌，加注是半诈唬：对手弃牌你直接赢池，跟注你还有成牌机会。';
      } else if (rel < 0.7) {
        recommended = 'check';
        reason = '牌力偏弱（胜率 ' + pct(eq) + '%），过牌看免费牌更稳；这局面诈唬要看对手是否爱弃牌。';
      } else {
        recommended = 'check';
        reason = '中等牌力（胜率 ' + pct(eq) + '%），控制底池、过牌跟注是稳妥打法。';
      }
    } else {
      if (evEdge > 0.12) {
        recommended = 'raise';
        reason = '胜率 ' + pct(eq) + '% 远高于底池赔率 ' + pct(potOdds) + '%，加注拿价值是最优解。';
      } else if (evEdge >= -0.02) {
        recommended = 'call';
        reason = '胜率 ' + pct(eq) + '% 略高于底池赔率 ' + pct(potOdds) + '%，跟注是正期望的选择。';
      } else if (hasDraw && potOdds < 0.25) {
        recommended = 'call';
        reason = '虽然暂时落后，但你有听牌且底池赔率只要 ' + pct(potOdds) + '%，追牌是划算的。';
      } else {
        recommended = 'fold';
        reason = '胜率只有 ' + pct(eq) + '%，却要付出 ' + pct(potOdds) + '% 的底池赔率，长期是负期望，应该弃牌。';
      }
    }

    // ---- 判定玩家实际选择 ----
    var actual = action === 'allin' ? 'raise' : action;
    if (actual === recommended) {
      verdict = 'best';
    } else if ((recommended === 'raise' && actual === 'call') || (recommended === 'call' && actual === 'raise')) {
      verdict = 'ok';
      evLoss = Math.abs(evEdge) * pot * 0.25;
    } else if (actual === 'check' && (recommended === 'call' || recommended === 'raise')) {
      verdict = 'ok';
      evLoss = Math.abs(evEdge) * pot * 0.3;
    } else if ((recommended === 'fold' && (actual === 'call' || actual === 'raise')) ||
      (recommended === 'call' && actual === 'fold') ||
      (recommended === 'raise' && actual === 'fold')) {
      verdict = Math.abs(evEdge) > 0.15 ? 'blunder' : 'mistake';
      evLoss = Math.abs(evEdge) * pot;
    } else {
      verdict = 'ok';
      evLoss = Math.abs(evEdge) * pot * 0.15;
    }

    // ---- 生成点评文案 ----
    var comment;
    if (verdict === 'best') {
      comment = '✅ ' + reason;
    } else if (verdict === 'ok') {
      comment = '⚠️ 可以接受，但更优是「' + actionCN(recommended) + '」。' + reason;
    } else if (verdict === 'mistake') {
      comment = '❌ 这里有更好选择：' + actionCN(recommended) + '。' + reason;
    } else {
      comment = '❌❌ 明显失误：应该' + actionCN(recommended) + '。' + reason +
        ' 这一手大约损失 ' + Math.round(evLoss) + ' 筹码。';
    }

    // ---- 关联知识点 ----
    var tipIds = [];
    if (facingBet) tipIds.push('pot_odds');
    if (hasDraw) tipIds.push('equity');
    if (recommended === 'raise' && rel >= 1.7) tipIds.push('value_bet');
    if (recommended === 'raise' && rel < 1.0) tipIds.push(hasDraw ? 'semi_bluff' : 'fold_equity');
    if (recommended === 'check' && rel >= 1.7) tipIds.push('slowplay');
    if (rel >= 0.7 && rel < 1.4 && facingBet) tipIds.push('pot_control');
    if (action === 'allin' || (d.allIn)) tipIds.push('allin');
    if (d.position != null && d.position > 0.75) tipIds.push('position');

    return {
      verdict: verdict,
      recommended: recommended,
      recommendedCN: actionCN(recommended),
      reason: reason,
      comment: comment,
      evLoss: Math.round(evLoss),
      tipIds: tipIds
    };
  }

  function actionCN(a) {
    return a === 'fold' ? '弃牌' : a === 'call' ? '跟注' : a === 'raise' ? '加注' : a === 'check' ? '过牌' : '全下';
  }

  // ============ 实时提示 ============
  /**
   * 玩家行动前的建议。
   * @param {Object} game Poker.Game 实例
   * @return {Object} {equity, potOdds, toCall, action, text, why}
   */
  function suggest(game) {
    var seat = game.seats[game.playerIndex];
    if (!seat || seat.folded) return null;
    var board = game.board || [];
    var nOpp = game.numOpponents(seat);

    // 翻牌前：给起手牌建议（多人桌胜率数字会误导新手，不看它）
    if (game.street === 'preflop') {
      var pa = preflopAdvice(game);
      var legalP = game.legalActions(game.playerIndex);
      var tc = legalP.toCall;
      var bb = game.bigBlind;
      var act2, why2;
      var top2 = pa.topPct;
      if (tc === 0) {
        act2 = top2 <= 0.30 ? 'raise' : 'check';
        why2 = top2 <= 0.30 ? '这手牌够强，加注建立优势。' : '起手牌一般，过牌免费看翻牌。';
      } else if (tc <= Math.round(bb * 1.5)) {
        act2 = top2 <= 0.55 ? 'call' : 'fold';
        why2 = top2 <= 0.55 ? '补 ' + tc + ' 看翻牌，底池赔率划算。' : '起手牌太弱，不值得付钱看翻牌。';
      } else {
        act2 = top2 <= 0.12 ? 'raise' : (top2 <= 0.35 ? 'call' : 'fold');
        why2 = top2 <= 0.12 ? '顶级起手牌，反加打大池。' : (top2 <= 0.35 ? '牌不错，赔率可以接受。' : '对手加注较大，这手牌弃了更稳。');
      }
      return {
        equity: 0, potOdds: legalP.potOdds, toCall: tc,
        action: act2, actionCN: actionCN(act2),
        text: '翻牌前 · ' + pa.posName + '　建议：' + actionCN(act2),
        why: why2 + ' ' + pa.text
      };
    }

    var eq = Equity.handStrength(seat.hole, board, nOpp, 400);
    var legal = game.legalActions(game.playerIndex);
    var toCall = legal.toCall;
    var potOdds = legal.potOdds;
    var baseline = 1 / (nOpp + 1);
    var rel = eq / baseline;
    var evEdge = eq - potOdds;
    var action, why;
    if (toCall === 0) {
      if (rel >= 1.7) { action = 'raise'; why = '牌力明显领先，下注价值最大。'; }
      else if (rel >= 0.75) { action = 'check'; why = '中等牌力，过牌控制底池，看下一张牌。'; }
      else { action = 'check'; why = '牌力偏弱，过牌保留筹码；诈唬要看对手是否容易弃牌。'; }
    } else {
      if (evEdge > 0.12) { action = 'raise'; why = '胜率远高于底池赔率，加注能拿到更多价值。'; }
      else if (evEdge >= -0.02) { action = 'call'; why = '胜率略高于底池赔率，跟注是正期望。'; }
      else if (potOdds < 0.2) { action = 'call'; why = '底池赔率很便宜，可以跟一手看牌。'; }
      else { action = 'fold'; why = '胜率低于底池赔率，长期跟下去会亏钱。'; }
    }
    return {
      equity: eq,
      potOdds: potOdds,
      toCall: toCall,
      action: action,
      actionCN: actionCN(action),
      text: '胜率 ' + pct(eq) + '%　底池赔率 ' + pct(potOdds) + '%　建议：' + actionCN(action),
      why: why
    };
  }

  /** 翻牌前起手牌建议 */
  function preflopAdvice(game) {
    var seat = game.seats[game.playerIndex];
    if (!seat || !seat.hole || seat.hole.length < 2) return null;
    var Brain = Poker.Brain || treq('./ai/brain.js');
    var topPct = Brain ? Brain.preflopTopPct(seat.hole) : 0.5;
    var pos = game.positionFactor(seat);
    var posName = pos > 0.8 ? '后位（按钮附近）' : pos > 0.5 ? '中间位置' : '前位（枪口附近）';
    var text;
    if (topPct <= 0.10) text = '顶级起手牌，任何位置都该加注入池。';
    else if (topPct <= 0.25) text = '强牌，' + posName + '可以加注，前位也能跟注。';
    else if (topPct <= 0.45) text = '中等牌力，' + posName + '可玩，前位建议弃牌。';
    else if (topPct <= 0.65) text = '偏弱，只在后位或无人加注时考虑入池。';
    else text = '垃圾牌，建议直接弃牌，等更好的机会。';
    return { topPct: topPct, posName: posName, text: text };
  }

  var Coach = {
    TIPS: COACH_TIPS,
    tip: function (id) { return TIP_BY_ID[id]; },
    judge: judge,
    suggest: suggest,
    preflopAdvice: preflopAdvice,
    actionCN: actionCN
  };

  Poker.Coach = Coach;
  if (typeof module !== 'undefined' && module.exports) module.exports = Coach;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
