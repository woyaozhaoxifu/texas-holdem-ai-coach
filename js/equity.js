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

  // =========================================================
  // 性能优化开关（默认全开；可关回原始算法做对照 / 等价验证）
  //   PERF_BUFFER：复用模块级缓冲，避免每次蒙特卡洛重新分配
  //   PERF_CACHE ：handStrength 结果 LRU 缓存（仅默认随机源路径）
  // 缓冲复用不改变任何计算顺序，故与分配版「位级等价」。
  // =========================================================
  var PERF_BUFFER = true;
  var PERF_CACHE = true;
  var CACHE_CAP = 512;
  function setPerf(opts) {
    if (!opts) return;
    if (typeof opts.buffer === 'boolean') PERF_BUFFER = opts.buffer;
    if (typeof opts.cache === 'boolean') PERF_CACHE = opts.cache;
    if (opts.cacheCap) CACHE_CAP = opts.cacheCap;
  }
  function clearCache() { _cache = {}; _cacheKeys = []; }

  // 模块级可复用缓冲（buffer 模式）
  var _bufUsed = new Uint8Array(52);
  var _bufDeck = new Array(52);
  var _bufFull = new Array(5);
  var _bufSeven = new Array(7);
  var _bufOpp = new Array(8);

  // LRU 缓存：plain object + recency 顺序数组（cap 小，indexOf 足够）
  var _cache = {};
  var _cacheKeys = [];
  function _cacheGet(key) {
    if (!_cache.hasOwnProperty(key)) return null;
    var idx = _cacheKeys.indexOf(key);
    if (idx > 0) { _cacheKeys.splice(idx, 1); _cacheKeys.unshift(key); }
    return _cache[key];
  }
  function _cachePut(key, val) {
    if (_cache.hasOwnProperty(key)) return;
    _cache[key] = val;
    _cacheKeys.unshift(key);
    if (_cacheKeys.length > CACHE_CAP) {
      var old = _cacheKeys.pop();
      if (old != null) delete _cache[old];
    }
  }
  function _hsKey(hole, board, nOpp, iters) {
    var HEv = Poker.HandEval || HE;
    // 缓存键按档位归一：不同 AI 人格传入的 equitySamples(200/300/400…) 若落入同一档，
    // 则共享缓存条目，避免相同 (hole,board,nOpp) 因采样数不同被碎片化。
    // 注意：实际计算仍使用真实 iters，仅缓存键被粗化（胜率为估计值，可接受）。
    var bIt = _bucketIters(iters);
    var parts = [];
    var i;
    for (i = 0; i < (hole ? hole.length : 0); i++) parts.push(hole[i].r + ':' + hole[i].s);
    for (i = 0; i < (board ? board.length : 0); i++) parts.push(board[i].r + ':' + board[i].s);
    parts.push('#' + nOpp + ':' + bIt);
    return parts.join(',');
  }

  /** 把采样数归一到最近的档位，减少 LRU 缓存碎片化 */
  function _bucketIters(iters) {
    var buckets = [150, 200, 250, 300, 400, 600];
    var v = iters || 0;
    var best = buckets[0];
    var bd = Math.abs(v - buckets[0]);
    for (var i = 1; i < buckets.length; i++) {
      var d = Math.abs(v - buckets[i]);
      if (d < bd) { bd = d; best = buckets[i]; }
    }
    return best;
  }

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

    var used, deck, full, seven, oppVals, deckLen;
    if (PERF_BUFFER) {
      used = _bufUsed; used.fill(0);
      deck = _bufDeck;
      full = _bufFull;
      seven = _bufSeven;
      oppVals = _bufOpp;
    } else {
      used = new Uint8Array(52);
      deck = [];
      full = new Array(5);
      seven = new Array(7);
      oppVals = new Array(nOpp);
    }
    var i;
    for (i = 0; i < holeIdx.length; i++) used[holeIdx[i]] = 1;
    for (i = 0; i < boardIdx.length; i++) used[boardIdx[i]] = 1;
    deckLen = 0;
    for (i = 0; i < 52; i++) if (!used[i]) deck[deckLen++] = i;

    var needBoard = 5 - boardIdx.length;
    var need = needBoard + 2 * nOpp;

    var wins = 0, ties = 0, shareSum = 0;

    for (var it = 0; it < iters; it++) {
      // 部分 Fisher-Yates：只打乱前 need 张
      for (i = 0; i < need; i++) {
        var j = i + Math.floor(rand() * (deckLen - i));
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
   * 全下段权益（已知各家底牌的公共牌发完模拟）。
   * AIV / 复盘运气归因用：摊牌时各家底牌已知 → 不需要再把对手当作随机牌采样，
   * 只需把剩余公共牌发完，各家按最终成牌比大小、平分计权益。
   * 河牌（board 5 张）时公共牌已齐 → 精确返回 0/1/平局分拆（无随机）。
   * @param {Array<Array<{r:number,s:number}>>} holes 每家两张底牌（顺序即返回值顺序）
   * @param {Array<{r:number,s:number}>} board 全下时点的公共牌（0/3/4/5 张）
   * @param {number=} iterations 蒙特卡洛次数（河牌忽略），默认 400
   * @param {Function=} rng 随机源（可注入种子）
   * @return {Array<number>} 各家权益（和 ≈1）
   */
  function allinEquity(holes, board, iterations, rng) {
    var HEv = Poker.HandEval || HE;
    var n = holes ? holes.length : 0;
    if (n === 0) return [];
    if (n === 1) return [1];
    var used = new Uint8Array(52);
    var hIdx = [];
    var p, i, k;
    for (p = 0; p < n; p++) {
      var hp = [HEv.idxOf(holes[p][0]), HEv.idxOf(holes[p][1])];
      hIdx.push(hp);
      used[hp[0]] = 1;
      used[hp[1]] = 1;
    }
    var bIdx = [];
    for (i = 0; i < (board ? board.length : 0); i++) {
      var bi = HEv.idxOf(board[i]);
      bIdx.push(bi);
      used[bi] = 1;
    }
    var eq = [];
    for (p = 0; p < n; p++) eq.push(0);
    var full = new Array(5);
    var seven = new Array(7);
    var vals = new Array(n);
    function runEval() {
      var best = -1;
      for (p = 0; p < n; p++) {
        for (k = 0; k < 5; k++) seven[k] = full[k];
        seven[5] = hIdx[p][0];
        seven[6] = hIdx[p][1];
        var v = HEv.valueIdx(seven, 7);
        vals[p] = v;
        if (v > best) best = v;
      }
      var nw = 0;
      for (p = 0; p < n; p++) if (vals[p] === best) nw++;
      var share = 1 / nw;
      for (p = 0; p < n; p++) if (vals[p] === best) eq[p] += share;
    }
    if (bIdx.length === 5) {
      for (i = 0; i < 5; i++) full[i] = bIdx[i];
      runEval();
      // 河牌精确：只可能是 1 / 0 / 1/nw（平局分拆），消除浮点尾巴便于断言
      for (p = 0; p < n; p++) eq[p] = Math.round(eq[p] * 1e9) / 1e9;
      return eq;
    }
    var need = 5 - bIdx.length;
    var deck = [];
    for (i = 0; i < 52; i++) if (!used[i]) deck.push(i);
    var rand = rng || Math.random;
    var iters = Math.max(1, iterations || 400);
    for (i = 0; i < bIdx.length; i++) full[i] = bIdx[i];
    var it, j;
    for (it = 0; it < iters; it++) {
      // 部分 Fisher-Yates：只洗需要补的公共牌张数
      for (i = 0; i < need; i++) {
        j = i + Math.floor(rand() * (deck.length - i));
        var t = deck[i];
        deck[i] = deck[j];
        deck[j] = t;
      }
      for (i = 0; i < need; i++) full[bIdx.length + i] = deck[i];
      runEval();
    }
    for (p = 0; p < n; p++) eq[p] = eq[p] / iters;
    return eq;
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
    var iters = iterations || 300;
    // 缓存：仅默认随机源（无 rng 注入）走 LRU；注入了 rng 的调用保持原行为（确定性 / 可复现）
    if (PERF_CACHE && !rng) {
      var key = _hsKey(hole, board, numOpponents, iters);
      var cached = _cacheGet(key);
      if (cached != null) return cached;
      var r0 = winRate(hole, board, numOpponents, iters, rng);
      _cachePut(key, r0.equity);
      return r0.equity;
    }
    var r = winRate(hole, board, numOpponents, iters, rng);
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

  // ============ 胜率助手（教学面板专用）============

  var RANK_L = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  /**
   * 起手牌一句话描述（教学面板翻前用）。
   * @param {Array<{r:number,s:number}>} hole
   * @return {string} 如 "对子 A"、"同花连张 AK"、"两高张 QJ"
   */
  function describeHole(hole) {
    if (!hole || hole.length < 2) return '';
    var a = hole[0], b = hole[1];
    var hi = Math.max(a.r, b.r), lo = Math.min(a.r, b.r);
    var suited = a.s === b.s;
    var gap = hi - lo;
    var tag;
    if (hi === lo) tag = '对子 ' + RANK_L[hi];
    else if (gap <= 1) tag = suited ? '同花连张' : '连张';
    else if (suited) tag = (lo >= 11) ? '同花高张' : '同花';
    else if (lo >= 11) tag = '两高张';
    else if (hi === 14 && lo >= 8) tag = 'A 带大牌';
    else if (hi >= 12 && lo >= 9) tag = '高张';
    else if (gap <= 3) tag = '间隔牌';
    else tag = '散牌';
    if (hi === lo) return tag;
    return tag + ' ' + RANK_L[hi] + RANK_L[lo];
  }

  /**
   * 胜率助手核心：对「当前已知牌面」做确定性穷举（无随机、可复现）。
   *
   * 翻牌后：把每个“还没看到的牌”两两当作一个随机对手的底牌，
   * 与已发公共牌组成一手（翻牌 5 张 / 转牌 6 张 / 河牌 7 张），与我的牌逐一比大小：
   *   wins / ties / loses → equity1 = (wins + ties/2) / total
   *   beats[] = 赢过我的对手牌型按类别聚合（一对/两对/三条/顺子/同花/葫芦/四条/同花顺…）
   * 说明：翻牌/转牌只统计“当前已明牌面”下对手能成的牌，不含后续街再追上；
   *       发到河牌后即等于真实单挑胜率。
   *
   * 翻牌前：公共牌未发，无法穷举对手成牌 → equity1 用蒙特卡洛（一路发到河牌），
   * beats 为空，另给起手牌描述 holeDesc。
   *
   * @param {Array<{r:number,s:number}>} hole 自己的两张底牌
   * @param {Array<{r:number,s:number}>} board 公共牌（0/3/4/5 张）
   * @param {number=} numOpponents 仍在池中的对手数（用于 N 人近似），默认 1
   * @param {number=} iterations 翻牌前蒙特卡洛次数，默认 600
   * @param {Function=} rng 随机源（测试可传入种子 rng）
   * @return {Object} 见实现内字段说明
   */
  function oddsPanel(hole, board, numOpponents, iterations, rng) {
    var HEv = Poker.HandEval || HE;
    var nOpp = Math.max(1, numOpponents || 1);
    var out = {
      street: 'preflop',            // preflop | flop | turn | river
      preflop: true,
      numOpponents: nOpp,
      equity1: 0,                   // 单挑：翻前=蒙特卡洛到河牌；翻后=当前明牌穷举（含平局折半）
      equityN: 0,                   // 对 N 个对手的近似（e_n = e1 ^ (1 + 0.86*(n-1))）
      tiePct: 0,                    // 平局占比（0..1）
      total: 0,                     // 穷举组合总数（翻前为 0）
      wins: 0, ties: 0, loses: 0,   // 穷举计数（翻前为 0）
      beats: [],                    // [{rank,name,count,pct}] 赢过我的牌型（按出现次数降序）
      myMadeRank: 0,
      myMadeName: '',
      holeDesc: ''
    };

    var holeIdx = [], boardIdx = [], i, j;
    for (i = 0; i < hole.length; i++) holeIdx.push(HEv.idxOf(hole[i]));
    for (i = 0; i < (board ? board.length : 0); i++) boardIdx.push(HEv.idxOf(board[i]));
    var k = boardIdx.length;
    if (k === 0) {
      out.street = 'preflop';
      out.preflop = true;
      out.holeDesc = describeHole(hole);
      // 翻牌前：蒙特卡洛一路发到河牌（确定性测试可传种子 rng）
      var mc = winRateIdx(holeIdx, boardIdx, 1, iterations || 600, rng);
      out.equity1 = clamp(mc.equity, 0, 1);
      var expPre = 1 + 0.86 * (nOpp - 1);
      out.equityN = clamp(Math.pow(out.equity1, expPre), 0.01, 0.99);
      return out;
    }

    var streetName = k === 3 ? 'flop' : (k === 4 ? 'turn' : 'river');
    out.street = streetName;
    out.preflop = false;

    // 已用牌 → 未用牌
    var used = new Uint8Array(52);
    for (i = 0; i < holeIdx.length; i++) used[holeIdx[i]] = 1;
    for (i = 0; i < boardIdx.length; i++) used[boardIdx[i]] = 1;
    var unseen = [];
    for (i = 0; i < 52; i++) if (!used[i]) unseen.push(i);
    var total = unseen.length * (unseen.length - 1) / 2;

    // 我的当前最佳 5 张（5/6/7 张均可用 valueIdx）
    var nAll = k + 2;
    var myAll = new Array(nAll);
    for (i = 0; i < 2; i++) myAll[i] = holeIdx[i];
    for (i = 0; i < k; i++) myAll[2 + i] = boardIdx[i];
    var myVal = HEv.valueIdx(myAll, nAll);
    var myRank = Math.floor(myVal / 1048576);

    // 逐个枚举对手两张
    var oppAll = new Array(nAll);
    for (i = 0; i < k; i++) oppAll[i] = boardIdx[i];
    var wins = 0, ties = 0, loses = 0;
    var loseByRank = {};
    var m = unseen.length;
    for (i = 0; i < m; i++) {
      for (j = i + 1; j < m; j++) {
        oppAll[k] = unseen[i];
        oppAll[k + 1] = unseen[j];
        var ov = HEv.valueIdx(oppAll, nAll);
        if (ov > myVal) {
          loses++;
          var rk = Math.floor(ov / 1048576);
          loseByRank[rk] = (loseByRank[rk] || 0) + 1;
        } else if (ov === myVal) {
          ties++;
        } else {
          wins++;
        }
      }
    }

    // 聚合“赢过我的牌型”
    var rankKeys = [];
    for (var r in loseByRank) {
      if (Object.prototype.hasOwnProperty.call(loseByRank, r)) rankKeys.push(parseInt(r, 10));
    }
    rankKeys.sort(function (a, b) {
      if (loseByRank[b] !== loseByRank[a]) return loseByRank[b] - loseByRank[a];
      return b - a;
    });
    var beats = [];
    for (i = 0; i < rankKeys.length; i++) {
      var rki = rankKeys[i];
      beats.push({
        rank: rki,
        name: HEv.HAND_NAMES[rki] || HEv.handName(rki),
        count: loseByRank[rki],
        pct: loseByRank[rki] / total
      });
    }

    var eq1 = total ? (wins + ties / 2) / total : 1;
    var exp = 1 + 0.86 * (nOpp - 1);
    out.equity1 = clamp(eq1, 0, 1);
    out.equityN = clamp(Math.pow(out.equity1, exp), 0.01, 0.99);
    out.tiePct = total ? ties / total : 0;
    out.total = total;
    out.wins = wins;
    out.ties = ties;
    out.loses = loses;
    out.beats = beats;
    out.myMadeRank = myRank;
    out.myMadeName = HEv.HAND_NAMES[myRank] || HEv.handName(myRank);
    return out;
  }

  /**
   * 牌面纹理（干面/湿面认知，教学 + AI 下注调整用）。
   * @param {Array<{r:number,s:number}>} board 公共牌（可为空）
   * @return {Object}
   *   wet: 0=干 1=中 2=湿
   *   label: '干'|'中'|'湿'
   *   flush: false（0~2 张同花）| 'threat'（恰 3 张同花）| 'flush'（≥4 张同花）
   *   straight: false | 'threat'（存在可用两张手牌拼成 5 连顺的保守启发）
   *   paired: 公共牌是否出现对子
   */
  function boardTexture(board) {
    var out = { wet: 1, label: '中', flush: false, straight: false, paired: false };
    var b = board || [];
    if (!b.length) return out;

    var rcnt = new Int32Array(15);
    var scnt = new Int32Array(4);
    var i;
    for (i = 0; i < b.length; i++) {
      rcnt[b[i].r]++;
      scnt[b[i].s]++;
    }
    var maxSuit = 0;
    for (i = 0; i < 4; i++) if (scnt[i] > maxSuit) maxSuit = scnt[i];
    out.flush = maxSuit >= 4 ? 'flush' : (maxSuit === 3 ? 'threat' : false);

    var paired = false;
    var uniq = [];
    for (var r = 14; r >= 2; r--) {
      if (rcnt[r] > 0) { uniq.push(r); if (rcnt[r] >= 2) paired = true; }
    }
    out.paired = paired;
    out.straight = hasStraightThreat(uniq) ? 'threat' : false;

    // 综合湿润度：flush 直逼/已成 +2~3，顺子威胁 +2，成对 +1
    var score = 0;
    if (out.flush === 'flush') score += 3;
    else if (out.flush === 'threat') score += 2;
    if (out.straight === 'threat') score += 2;
    if (out.paired) score += 1;

    if (score >= 3) { out.wet = 2; out.label = '湿'; }
    else if (score === 2) {
      if (out.straight === 'threat') { out.wet = 2; out.label = '湿'; }
      else { out.wet = 1; out.label = '中'; }
    } else if (score === 1) { out.wet = 1; out.label = '中'; }
    else { out.wet = 0; out.label = '干'; }
    return out;
  }

  /** 保守顺子威胁启发：3 连或某 5 连窗口已占 ≥4 张（宁可偏保守） */
  function hasStraightThreat(uniq) {
    if (!uniq || uniq.length < 3) return false;
    var i;
    var maxRun = 1, run = 1;
    for (i = 1; i < uniq.length; i++) {
      run = (uniq[i - 1] - uniq[i] === 1) ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    if (maxRun >= 3) return true;
    var set = new Uint8Array(15);
    for (i = 0; i < uniq.length; i++) set[uniq[i]] = 1;
    var win, c, k;
    for (var hi = 14; hi >= 6; hi--) {
      c = 0;
      for (k = 0; k < 5; k++) if (set[hi - k]) c++;
      if (c >= 4) return true;
    }
    // 轮子 A-5-4-3-2
    win = [14, 2, 3, 4, 5];
    c = 0;
    for (k = 0; k < 5; k++) if (set[win[k]]) c++;
    return c >= 4;
  }

  // ============ 蒙特卡洛后台线程（Web Worker 卸载，主线程同步回退）============
  // computeAsync 把重计算(handStrength / oddsPanel) 交给 js/equity.worker.js，
  // 返回 Promise；若浏览器不支持 Worker 或创建/导入失败（file:// 常被安全策略拦截），
  // 自动回退到同步函数，保证 UI 永远可用。
  var _asyncWorker = null;
  var _asyncBroken = false;
  var _asyncId = 0;

  function _syncCompute(type, payload) {
    if (type === 'handStrength') {
      return handStrength(payload.hole, payload.board, payload.numOpponents, payload.iterations, payload.rng);
    }
    if (type === 'oddsPanel') {
      return oddsPanel(payload.hole, payload.board, payload.numOpponents, payload.iterations, payload.rng);
    }
    return null;
  }

  /**
   * 异步计算（后台线程优先，失败回退同步）。
   * @param {Object} opt {type:'handStrength'|'oddsPanel', payload:{hole,board,numOpponents,iterations,rng?}, workerUrl?}
   * @return {Promise<Object>}
   */
  function computeAsync(opt) {
    opt = opt || {};
    var type = opt.type || 'handStrength';
    var payload = opt.payload || {};
    return new Promise(function (resolve) {
      // 无 Worker（如 Node 测试 / 老浏览器）→ 同步回退
      if (typeof Worker === 'undefined') {
        resolve(_syncCompute(type, payload));
        return;
      }
      try {
        if (!_asyncWorker && !_asyncBroken) {
          var url = opt.workerUrl || 'js/equity.worker.js';
          var w = new Worker(url);
          w._pending = {};
          w.onmessage = function (ev) {
            var m = ev.data || {};
            if (m.id != null && w._pending[m.id]) {
              var cb = w._pending[m.id];
              delete w._pending[m.id];
              cb(m);
            }
          };
          w.onerror = function () { _asyncBroken = true; w._pending = {}; };
          _asyncWorker = w;
        }
        if (_asyncBroken || !_asyncWorker) {
          resolve(_syncCompute(type, payload));
          return;
        }
        var id = ++_asyncId;
        _asyncWorker._pending[id] = function (m) {
          if (m.error) resolve(_syncCompute(type, payload)); // Worker 计算出错 → 同步兜底
          else resolve(m.result);
        };
        _asyncWorker.postMessage({ type: type, id: id, payload: payload });
      } catch (e) {
        resolve(_syncCompute(type, payload));
      }
    });
  }

  var Equity = {
    CHEN_BASE: CHEN_BASE,
    chenScore: chenScore,
    preflopEquity1: preflopEquity1,
    preflopEquity: preflopEquity,
    winRate: winRate,
    winRateIdx: winRateIdx,
    allinEquity: allinEquity,
    handStrength: handStrength,
    detectDraw: detectDraw,
    outsToEquity: outsToEquity,
    describeHole: describeHole,
    oddsPanel: oddsPanel,
    boardTexture: boardTexture,
    setPerf: setPerf,
    clearCache: clearCache,
    computeAsync: computeAsync
  };

  Poker.Equity = Equity;
  if (typeof module !== 'undefined' && module.exports) module.exports = Equity;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
