/* global window, global */
/**
 * equity.js —— 胜率估算：翻牌前启发式（Chen 起手牌评分）+ 翻牌后蒙特卡洛。
 *
 * 设计目标：单次决策 < 50ms，故翻牌前不跑蒙特卡洛，翻牌后按难度采样 200~800 次。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});
  var HE = Poker.HandEval || (typeof require !== 'undefined' ? require('./handEval.js') : null);
  // Node 下单独 require 时兜底
  if (!HE && typeof require !== 'undefined') {
    try { HE = require('./handEval.js'); } catch (e) { HE = null; }
  }

  // Chen 基础分值
  var CHEN_BASE = {
    14: 10, 13: 8, 12: 7, 11: 6, 10: 5, 9: 4.5, 8: 4, 7: 3.5, 6: 3, 5: 2.5, 4: 2, 3: 1.5, 2: 1
  };

  // 非对子 Chen 分值 -> 单挑随机牌胜率（经验标定表）
  var CHEN_TABLE = [
    /* <=-2 */ 0.345, 0.355, 0.375, 0.400, 0.425, 0.450, 0.475, 0.500,
    /* 5 */ 0.510, /* 6 */ 0.535, /* 7 */ 0.560, /* 8 */ 0.585,
    /* 9 */ 0.610, /* 10 */ 0.635, /* 11 */ 0.655, /* 12 */ 0.675, /* 13+ */ 0.700
  ];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * Chen 起手牌评分。
   * @param {Array<{r:number,s:number}>} hole 两张底牌
   * @return {number} 约 -2 .. 20
   */
  function chenScore(hole) {
    if (!hole || hole.length < 2) return 0;
    var a = hole[0], b = hole[1];
    var high = Math.max(a.r, b.r);
    var low = Math.min(a.r, b.r);
    var suited = a.s === b.s;
    var base = CHEN_BASE[high] || 0;

    if (high === low) {
      // 对子：翻倍，最低 5 分
      return Math.max(base * 2, 5);
    }
    var score = base;
    if (suited) score += 2;
    var gap = high - low - 1;
    if (gap === 1) score -= 0.5;
    else if (gap === 2) score -= 1.5;
    else if (gap === 3) score -= 3;
    else if (gap >= 4) score -= 4.5;
    if (high === 14) score += 2; // A 高张加成
    return score;
  }

  /**
   * 翻牌前对单个随机对手的胜率（启发式）。
   * @param {Array<{r:number,s:number}>} hole
   * @return {number} 0..1
   */
  function preflopEquity1(hole) {
    if (!hole || hole.length < 2) return 0.5;
    var a = hole[0], b = hole[1];
    if (a.r === b.r) {
      // 对子：实测 AA .852 -> 22 .503 近似线性
      return clamp(0.508 + 0.0285 * (a.r - 2), 0.30, 0.90);
    }
    var c = chenScore(hole);
    var i = Math.round(c) + 2; // CHEN_TABLE 下标 0 对应 chen = -2
    if (i < 0) i = 0;
    if (i > 12) i = 12;
    // 相邻档线性插值
    var c0 = i - 2;
    var frac = clamp(c - c0, 0, 1);
    var v0 = CHEN_TABLE[i];
    var v1 = CHEN_TABLE[Math.min(i + 1, CHEN_TABLE.length - 1)];
    return clamp(v0 + (v1 - v0) * frac, 0.28, 0.88);
  }

  /**
   * 翻牌前对 n 个随机对手的胜率。
   * 经验公式：e_n = e1 ^ (1 + 0.86 * (n - 1))，按 AA vs 1..5 实测值标定。
   * @param {Array} hole
   * @param {number} numOpponents
   * @return {number} 0..1
   */
  function preflopEquity(hole, numOpponents) {
    var n = Math.max(1, numOpponents || 1);
    var e1 = preflopEquity1(hole);
    var exp = 1 + 0.86 * (n - 1);
    return clamp(Math.pow(e1, exp), 0.01, 0.95);
  }

  /**
   * 蒙特卡洛胜率。
   * @param {Array<number>} holeIdx 自己的两张（整数编码）
   * @param {Array<number>} boardIdx 公共牌（0/3/4/5 张，整数编码）
   * @param {number} numOpponents 对手数量
   * @param {number} iterations 模拟次数
   * @param {Function=} rng 随机源
   * @return {Object} {win, tie, equity, iterations}
   */
  function winRateIdx(holeIdx, boardIdx, numOpponents, iterations, rng) {
    var rand = rng || Math.random;
    var iters = Math.max(1, iterations || 300);
    var nOpp = Math.max(1, numOpponents || 1);
    var HEv = Poker.HandEval || HE;
    var valueIdx = HEv.valueIdx;

    var used = new Uint8Array(52);
    var i;
    for (i = 0; i < holeIdx.length; i++) used[holeIdx[i]] = 1;
    for (i = 0; i < boardIdx.length; i++) used[boardIdx[i]] = 1;

    var deck = [];
    for (i = 0; i < 52; i++) if (!used[i]) deck.push(i);

    var needBoard = 5 - boardIdx.length;
    var need = needBoard + 2 * nOpp;
    var full = new Array(5);
    var seven = new Array(7);
    var oppVals = new Array(nOpp);

    var wins = 0, ties = 0, shareSum = 0;

    for (var it = 0; it < iters; it++) {
      // 部分 Fisher-Yates：只打乱前 need 张
      for (i = 0; i < need; i++) {
        var j = i + Math.floor(rand() * (deck.length - i));
        var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
      }
      for (i = 0; i < boardIdx.length; i++) full[i] = boardIdx[i];
      for (i = 0; i < needBoard; i++) full[boardIdx.length + i] = deck[i];

      var myVal;
      for (i = 0; i < 5; i++) seven[i] = full[i];
      seven[5] = holeIdx[0];
      seven[6] = holeIdx[1];
      myVal = valueIdx(seven, 7);

      var best = -1, eqCount = 0;
      for (var p = 0; p < nOpp; p++) {
        for (i = 0; i < 5; i++) seven[i] = full[i];
        seven[5] = deck[needBoard + 2 * p];
        seven[6] = deck[needBoard + 2 * p + 1];
        var v = valueIdx(seven, 7);
        oppVals[p] = v;
        if (v > best) best = v;
      }

      if (myVal > best) {
        wins++;
        shareSum += 1;
      } else if (myVal === best) {
        for (p = 0; p < nOpp; p++) if (oppVals[p] === best) eqCount++;
        ties++;
        shareSum += 1 / (1 + eqCount);
      }
    }

    return {
      win: wins / iters,
      tie: ties / iters,
      equity: shareSum / iters,
      iterations: iters
    };
  }

  /**
   * 蒙特卡洛胜率（{r,s} 牌对象版）。
   * @param {Array<{r:number,s:number}>} hole
   * @param {Array<{r:number,s:number}>} board
   * @param {number} numOpponents
   * @param {number} iterations
   * @param {Function=} rng
   * @return {Object}
   */
  function winRate(hole, board, numOpponents, iterations, rng) {
    var HEv = Poker.HandEval || HE;
    var holeIdx = [], boardIdx = [], i;
    for (i = 0; i < hole.length; i++) holeIdx.push(HEv.idxOf(hole[i]));
    for (i = 0; i < (board ? board.length : 0); i++) boardIdx.push(HEv.idxOf(board[i]));
    return winRateIdx(holeIdx, boardIdx, numOpponents, iterations, rng);
  }

  /**
   * 手牌强度（0..1）。翻牌前走启发式，翻牌后走蒙特卡洛。
   * @param {Array} hole
   * @param {Array} board
   * @param {number} numOpponents
   * @param {number=} iterations 默认 300
   * @param {Function=} rng
   * @return {number}
   */
  function handStrength(hole, board, numOpponents, iterations, rng) {
    if (!board || board.length === 0) return preflopEquity(hole, numOpponents);
    var r = winRate(hole, board, numOpponents, iterations || 300, rng);
    return r.equity;
  }

  /**
   * 听牌检测（用于 AI 决策理由与半诈唬判断）。
   * @param {Array<{r:number,s:number}>} hole
   * @param {Array<{r:number,s:number}>} board
   * @return {Object} {madeRank, madeName, flushDraw, straightDraw, outs}
   */
  function detectDraw(hole, board) {
    var res = { madeRank: 0, madeName: '高牌', flushDraw: false, straightDraw: false, outs: 0 };
    if (!hole || hole.length < 2) return res;
    var all = hole.concat(board || []);
    if (all.length < 5) return res;

    var HEv = Poker.HandEval || HE;
    var idx = [];
    var i;
    for (i = 0; i < all.length; i++) idx.push(HEv.idxOf(all[i]));
    var ev = HEv.evaluateIdx(idx, all.length);
    res.madeRank = ev.rank;
    res.madeName = ev.name;

    // 同花听牌：某花色正好 4 张
    var sc = [0, 0, 0, 0];
    for (i = 0; i < all.length; i++) sc[all[i].s]++;
    for (i = 0; i < 4; i++) if (sc[i] === 4) res.flushDraw = true;

    // 顺子听牌：某个窗口已有 4 张
    var present = new Uint8Array(15);
    for (i = 0; i < all.length; i++) present[all[i].r] = 1;
    var windows = [[14, 13, 12, 11, 10], [13, 12, 11, 10, 9], [12, 11, 10, 9, 8], [11, 10, 9, 8, 7],
      [10, 9, 8, 7, 6], [9, 8, 7, 6, 5], [8, 7, 6, 5, 4], [7, 6, 5, 4, 3],
      [6, 5, 4, 3, 2], [5, 4, 3, 2, 14]];
    for (i = 0; i < windows.length; i++) {
      var c = 0;
      for (var k = 0; k < 5; k++) if (present[windows[i][k]]) c++;
      if (c === 4) { res.straightDraw = true; break; }
    }

    var outs = 0;
    if (res.flushDraw) outs += 9;
    if (res.straightDraw) outs += 4;
    res.outs = outs;
    return res;
  }

  /**
   *  outs -> 河牌成手概率（两次机会/一次机会粗略换算）。
   * @param {number} outs
   * @param {number} remaining 还剩几张牌要看（2=转+河，1=河）
   * @return {number} 0..1
   */
  function outsToEquity(outs, remaining) {
    var r = remaining || 2;
    return clamp(outs * r * 0.0217, 0, 0.95); // 近似 2% 规则
  }

  var Equity = {
    CHEN_BASE: CHEN_BASE,
    chenScore: chenScore,
    preflopEquity1: preflopEquity1,
    preflopEquity: preflopEquity,
    winRate: winRate,
    winRateIdx: winRateIdx,
    handStrength: handStrength,
    detectDraw: detectDraw,
    outsToEquity: outsToEquity
  };

  Poker.Equity = Equity;
  if (typeof module !== 'undefined' && module.exports) module.exports = Equity;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
