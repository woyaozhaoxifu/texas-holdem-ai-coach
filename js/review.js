/* global window, global */
/**
 * review.js —— 每手牌结束后的复盘引擎。
 *
 * 把 game.js 记录的 handLog 转成结构化复盘报告：
 *   概览 → 逐街回放 → 关键决策点评（含量化代价）→ 对手解读 → 知识点卡片
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  function treq(p) {
    try { return typeof require !== 'undefined' ? require(p) : null; } catch (e) { return null; }
  }
  var Coach = Poker.Coach || treq('./coach.js');
  var HandEval = Poker.HandEval || treq('./handEval.js');
  var Cards = Poker.Cards || treq('./cards.js');
  var Personalities = Poker.Personalities || treq('./ai/personalities.js');

  var STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];
  var STREET_CN = { preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' };

  function pct(x) { return Math.round(x * 100); }

  /**
   * @param {Object} result game.lastResult
   * @param {Object} game   Poker.Game 实例（用于取座位信息）
   */
  function build(result, game) {
    if (!result) return null;
    var C = Poker.Coach || Coach;
    var playerIndex = game ? game.playerIndex : 0;
    var playerSeat = game ? game.seats[playerIndex] : null;

    // ---- 概览 ----
    var playerEval = null;
    if (playerSeat && playerSeat.hole.length === 2 && !playerSeat.folded && result.board.length >= 3) {
      playerEval = HandEval.evaluate(playerSeat.hole.concat(result.board));
    }
    var winAmount = 0, i;
    for (i = 0; i < (result.winners || []).length; i++) {
      if (result.winners[i].seatIndex === playerIndex) winAmount = result.winners[i].amount;
    }
    var delta = result.playerDelta || 0;

    // ---- 决策点评（只评玩家的决策点）----
    var decisions = [];
    var tipSet = [];
    var log = result.handLog || [];
    for (i = 0; i < log.length; i++) {
      var d = log[i];
      if (d.seatIndex !== playerIndex) continue;
      var j = C.judge(d);
      var item = {
        street: d.street,
        streetCN: STREET_CN[d.street] || d.street,
        board: d.board || [],
        hole: d.hole || [],
        pot: d.potBefore,
        toCall: d.toCall,
        equity: d.equity,
        potOdds: d.potOdds,
        action: d.action,
        actionCN: actionCN(d.action),
        amount: d.amount,
        verdict: j.verdict,
        recommended: j.recommended,
        recommendedCN: j.recommendedCN,
        comment: j.comment,
        evLoss: j.evLoss
      };
      decisions.push(item);
      for (var t = 0; t < j.tipIds.length; t++) {
        if (tipSet.indexOf(j.tipIds[t]) < 0) tipSet.push(j.tipIds[t]);
      }
    }

    // ---- 逐街回放 ----
    var streets = [];
    var snaps = result.streetSnaps || [];
    for (i = 0; i < STREET_ORDER.length; i++) {
      var st = STREET_ORDER[i];
      var snap = null;
      for (var k = 0; k < snaps.length; k++) if (snaps[k].street === st) snap = snaps[k];
      var acts = [];
      for (var m = 0; m < log.length; m++) {
        if (log[m].street === st) {
          acts.push({
            name: log[m].actorName,
            seatIndex: log[m].seatIndex,
            isHuman: log[m].isHuman,
            action: actionCN(log[m].action),
            amount: log[m].amount,
            reason: log[m].reason || ''
          });
        }
      }
      if (snap || acts.length) {
        streets.push({
          street: st,
          streetCN: STREET_CN[st],
          board: snap ? snap.board : [],
          pot: snap ? snap.pot : 0,
          actions: acts
        });
      }
    }

    // ---- 对手解读：摊牌时揭示底牌与决策理由 ----
    var opponents = [];
    if (game) {
      for (i = 0; i < game.seats.length; i++) {
        var s = game.seats[i];
        if (i === playerIndex) continue;
        var last = null;
        for (var q = log.length - 1; q >= 0; q--) {
          if (log[q].seatIndex === i) { last = log[q]; break; }
        }
        var ev = null;
        for (var e = 0; e < (result.evals || []).length; e++) {
          if (result.evals[e].seatIndex === i) ev = result.evals[e];
        }
        var showed = !s.folded && result.showdown && ev;
        opponents.push({
          name: s.name,
          avatar: s.avatar,
          personalityId: s.personality ? s.personality.id : '',
          folded: s.folded,
          hole: showed ? (ev.hole || s.hole) : [],
          handName: showed ? ev.name : '',
          revealed: !!showed,
          lastAction: last ? actionCN(last.action) : '',
          reason: last ? (last.reason || '') : '',
          // 诈唬判定：摊牌时成手牌只有一对以下，且最后一击是加注/全下
          wasBluff: !!(showed && ev.rank <= 1 && last && (last.action === 'raise' || last.action === 'allin')),
          mood: s.mood || 0,
          moodLabel: s.moodLabel || '平静',
          relation: s.relations ? (s.relations[playerSeat ? playerSeat.id : ''] || 0) : 0
        });
      }
    }

    // ---- 知识点（最多 3 条）----
    var tips = [];
    var fallback = ['pot_odds', 'equity', 'position'];
    var pool = tipSet.length ? tipSet : fallback;
    for (i = 0; i < pool.length && tips.length < 3; i++) {
      var tip = C.tip(pool[i]);
      if (tip) tips.push(tip);
    }

    // ---- 一句话总结 ----
    var summary;
    if (decisions.length === 0) summary = '本手你没参与决策。';
    else {
      var bad = 0, good = 0;
      for (i = 0; i < decisions.length; i++) {
        if (decisions[i].verdict === 'mistake' || decisions[i].verdict === 'blunder') bad++;
        else if (decisions[i].verdict === 'best') good++;
      }
      var res = delta > 0 ? '赢下 ' + delta : (delta < 0 ? '损失 ' + Math.abs(delta) : '不赔不赚');
      if (bad === 0) summary = '本手决策全部正确，' + res + '。保持这个节奏。';
      else summary = '本手有 ' + bad + ' 处可以改进，' + res + '。重点看下面标红的决策点。';
    }

    return {
      handNo: result.handNo,
      board: result.board || [],
      boardText: Cards.cardsText(result.board || []),
      pot: result.pot,
      delta: delta,
      winAmount: winAmount,
      playerHole: result.playerHole || [],
      playerHoleText: Cards.cardsText(result.playerHole || []),
      playerHandName: playerEval ? HandEval.describe(playerEval) : (result.playerFolded ? '已弃牌' : ''),
      showdown: result.showdown,
      streets: streets,
      decisions: decisions,
      opponents: opponents,
      tips: tips,
      aiv: result.aiv || null,   // C1：本手全下 EV 段（game.js 在 settle 时挂到 result）
      summary: summary
    };
  }

  function actionCN(a) {
    return a === 'fold' ? '弃牌' : a === 'call' ? '跟注' : a === 'raise' ? '加注' : a === 'check' ? '过牌' : a === 'allin' ? '全下' : a || '';
  }

  /** 汇总学习档案（存 localStorage） */
  function updateStats(stats, review) {
    var s = stats || { hands: 0, wins: 0, profit: 0, best: 0, ok: 0, mistake: 0, blunder: 0, byStreet: {}, topMistakes: {} };
    s.hands++;
    if (review.delta > 0) s.wins++;
    s.profit += review.delta;
    for (var i = 0; i < review.decisions.length; i++) {
      var d = review.decisions[i];
      s[d.verdict] = (s[d.verdict] || 0) + 1;
      if (d.verdict === 'mistake' || d.verdict === 'blunder') {
        s.byStreet[d.streetCN] = (s.byStreet[d.streetCN] || 0) + 1;
        var key = d.recommendedCN + '→' + d.actionCN;
        s.topMistakes[key] = (s.topMistakes[key] || 0) + 1;
      }
    }
    return s;
  }

  var Review = { build: build, updateStats: updateStats, actionCN: actionCN, STREET_CN: STREET_CN };

  Poker.Review = Review;
  if (typeof module !== 'undefined' && module.exports) module.exports = Review;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
