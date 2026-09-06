/* global window, global */
/**
 * handEval.js —— 7 选 5 手牌评估与牌型比较（高性能版）。
 *
 * 牌采用 0..51 整数编码：idx = (r - 2) * 4 + s，其中 r = 2..14（14=A），s = 0..3（♠♥♦♣）。
 * 因此 r = (idx >> 2) + 2，s = idx & 3。
 *
 * 评估结果 {rank, value, name, main, cards}
 *  - rank: 0=高牌 1=一对 2=两对 3=三条 4=顺子 5=同花 6=葫芦 7=四条 8=同花顺 9=皇家同花顺
 *  - value: 打包整数，可直接数值比较大
 *    value = rank * 2^20 + v1*16^4 + v2*16^3 + v3*16^2 + v4*16 + v5
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  var HAND_NAMES = [
    '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺'
  ];

  // 复用的暂存区（单线程同步调用，安全）
  var cnt = new Int32Array(15);
  var suitCnt = new Int32Array(4);
  var uniq = new Int32Array(7);
  var flushR = new Int32Array(7);
  var rset = new Int32Array(15);

  var POW16 = [65536, 4096, 256, 16, 1];

  /**
   * 打包比较值。
   * @param {number} rank 牌型 0..9
   * @param {Array<number>} vals 5 个按重要性排序的等级
   * @return {number}
   */
  function packValue(rank, vals) {
    var v = rank * 1048576;
    for (var i = 0; i < 5; i++) v += ((vals && vals[i]) || 0) * POW16[i];
    return v;
  }

  /** 在降序去重等级数组中找顺子最大牌，找不到返回 0（A2345 轮子返回 5） */
  function findStraightHigh(ranks, n) {
    if (n < 5) return 0;
    var i;
    for (i = 0; i < 15; i++) rset[i] = 0;
    for (i = 0; i < n; i++) rset[ranks[i]] = 1;
    for (var high = 14; high >= 6; high--) {
      if (rset[high] && rset[high - 1] && rset[high - 2] && rset[high - 3] && rset[high - 4]) return high;
    }
    // 轮子 A-5-4-3-2
    if (rset[14] && rset[5] && rset[4] && rset[3] && rset[2]) return 5;
    return 0;
  }

  /** 恰好 5 张（整数编码）的评估，返回打包值 */
  function value5(a) {
    var i, r;
    for (i = 0; i < 15; i++) cnt[i] = 0;
    for (i = 0; i < 5; i++) cnt[(a[i] >> 2) + 2]++;

    var isFlush = ((a[0] & 3) === (a[1] & 3) && (a[1] & 3) === (a[2] & 3) &&
      (a[2] & 3) === (a[3] & 3) && (a[3] & 3) === (a[4] & 3));

    var m = 0;
    for (r = 14; r >= 2; r--) if (cnt[r] > 0) uniq[m++] = r;

    var sh = 0;
    if (m === 5) {
      if (uniq[0] - uniq[4] === 4) sh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5) sh = 5;
    }

    // 收集各 count 分组（降序）
    var quads = 0, trips = 0, t2 = 0, p1 = 0, p2 = 0;
    for (r = 14; r >= 2; r--) {
      var c = cnt[r];
      if (c === 4) quads = r;
      else if (c === 3) { if (!trips) trips = r; else if (!t2) t2 = r; }
      else if (c === 2) { if (!p1) p1 = r; else if (!p2) p2 = r; }
    }

    if (isFlush && sh) {
      return packValue(sh === 14 ? 9 : 8, [sh, 0, 0, 0, 0]);
    }
    if (quads) {
      var qk = 0;
      for (r = 14; r >= 2; r--) if (cnt[r] > 0 && r !== quads) { qk = r; break; }
      return packValue(7, [quads, qk, 0, 0, 0]);
    }
    if (trips && p1) return packValue(6, [trips, p1, 0, 0, 0]);
    if (isFlush) return packValue(5, [uniq[0], uniq[1], uniq[2], uniq[3], uniq[4]]);
    if (sh) return packValue(4, [sh, 0, 0, 0, 0]);
    if (trips) {
      var k1 = 0, k2 = 0;
      for (r = 14; r >= 2; r--) if (cnt[r] === 1) { if (!k1) k1 = r; else if (!k2) { k2 = r; break; } }
      return packValue(3, [trips, k1, k2, 0, 0]);
    }
    if (p1 && p2) {
      var tk = 0;
      for (r = 14; r >= 2; r--) if (cnt[r] === 1) { tk = r; break; }
      return packValue(2, [p1, p2, tk, 0, 0]);
    }
    if (p1) {
      var ks = [];
      for (r = 14; r >= 2; r--) if (cnt[r] === 1) ks.push(r);
      return packValue(1, [p1, ks[0] || 0, ks[1] || 0, ks[2] || 0, 0]);
    }
    return packValue(0, [uniq[0], uniq[1], uniq[2], uniq[3], uniq[4]]);
  }

  /** 恰好 7 张（整数编码）的评估，返回打包值 */
  function value7(a) {
    var i, r, s, c;
    for (i = 0; i < 15; i++) cnt[i] = 0;
    suitCnt[0] = suitCnt[1] = suitCnt[2] = suitCnt[3] = 0;
    for (i = 0; i < 7; i++) {
      c = a[i];
      cnt[(c >> 2) + 2]++;
      suitCnt[c & 3]++;
    }

    var flushSuit = -1;
    for (s = 0; s < 4; s++) if (suitCnt[s] >= 5) { flushSuit = s; break; }

    if (flushSuit >= 0) {
      var fn = 0;
      for (i = 0; i < 7; i++) if ((a[i] & 3) === flushSuit) flushR[fn++] = (a[i] >> 2) + 2;
      // 降序排序（7 个元素，插入排序）
      for (i = 1; i < fn; i++) {
        var key = flushR[i], j = i - 1;
        while (j >= 0 && flushR[j] < key) { flushR[j + 1] = flushR[j]; j--; }
        flushR[j + 1] = key;
      }
      var sfh = findStraightHigh(flushR, fn);
      if (sfh) return packValue(sfh === 14 ? 9 : 8, [sfh, 0, 0, 0, 0]);
      return packValue(5, [flushR[0], flushR[1], flushR[2], flushR[3], flushR[4]]);
    }

    var m = 0;
    for (r = 14; r >= 2; r--) if (cnt[r] > 0) uniq[m++] = r;

    var quads = 0, trips = 0, t2 = 0, p1 = 0, p2 = 0;
    for (r = 14; r >= 2; r--) {
      var cc = cnt[r];
      if (cc === 4) quads = r;
      else if (cc === 3) { if (!trips) trips = r; else if (!t2) t2 = r; }
      else if (cc === 2) { if (!p1) p1 = r; else if (!p2) p2 = r; }
    }

    if (quads) {
      var qk = 0;
      for (r = 14; r >= 2; r--) if (cnt[r] > 0 && r !== quads) { qk = r; break; }
      return packValue(7, [quads, qk, 0, 0, 0]);
    }
    if (trips && (t2 || p1)) {
      return packValue(6, [trips, Math.max(t2, p1), 0, 0, 0]);
    }

    var sh = findStraightHigh(uniq, m);
    if (sh) return packValue(4, [sh, 0, 0, 0, 0]);

    if (trips) {
      var k1 = 0, k2 = 0;
      for (r = 14; r >= 2; r--) if (cnt[r] === 1) { if (!k1) k1 = r; else { k2 = r; break; } }
      return packValue(3, [trips, k1, k2, 0, 0]);
    }
    if (p1 && p2) {
      var tk = 0;
      for (r = 14; r >= 2; r--) if (cnt[r] === 1) { tk = r; break; }
      return packValue(2, [p1, p2, tk, 0, 0]);
    }
    if (p1) {
      var ks = [];
      for (r = 14; r >= 2; r--) if (cnt[r] === 1) ks.push(r);
      return packValue(1, [p1, ks[0] || 0, ks[1] || 0, ks[2] || 0, 0]);
    }
    return packValue(0, [uniq[0], uniq[1], uniq[2], uniq[3], uniq[4]]);
  }

  /** 6 张（整数编码）：枚举 C(6,5) 取最大 */
  function value6(a) {
    var best = 0;
    for (var skip = 0; skip < 6; skip++) {
      var five = [];
      for (var i = 0; i < 6; i++) if (i !== skip) five.push(a[i]);
      var v = value5(five);
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * 核心：给定整数编码牌数组（5/6/7 张），返回打包比较值。
   * @param {Array<number>} a 整数编码牌
   * @param {number=} len 长度，默认 a.length
   * @return {number}
   */
  function valueIdx(a, len) {
    var n = len || a.length;
    if (n === 7) return value7(a);
    if (n === 5) return value5(a);
    if (n === 6) return value6(a);
    return 0;
  }

  /** 由打包值反解出 {rank, main} */
  function unpack(value) {
    var rank = Math.floor(value / 1048576);
    var rest = value - rank * 1048576;
    var main = [];
    for (var i = 0; i < 5; i++) {
      main.push(Math.floor(rest / POW16[i]));
      rest -= main[i] * POW16[i];
    }
    return { rank: rank, main: main };
  }

  /** {r,s} 牌对象 -> 整数编码 */
  function idxOf(card) { return (card.r - 2) * 4 + card.s; }

  /** 整数编码 -> {r,s} 牌对象 */
  function cardOf(idx) { return { r: (idx >> 2) + 2, s: idx & 3 }; }

  /**
   * 评估 5..7 张 {r,s} 牌对象。
   * @param {Array<{r:number,s:number}>} cards
   * @return {Object} {rank, value, name, main, cards}
   */
  function evaluate(cards) {
    var n = cards.length;
    var a = [];
    for (var i = 0; i < n; i++) a.push(idxOf(cards[i]));
    var v = valueIdx(a, n);
    var u = unpack(v);
    return {
      rank: u.rank,
      value: v,
      name: HAND_NAMES[u.rank],
      main: u.main,
      cards: cards.slice()
    };
  }

  /**
   * 评估整数编码牌数组，返回完整对象。
   * @param {Array<number>} a
   * @param {number=} len
   * @return {Object}
   */
  function evaluateIdx(a, len) {
    var v = valueIdx(a, len);
    var u = unpack(v);
    var cs = [];
    for (var i = 0; i < (len || a.length); i++) cs.push(cardOf(a[i]));
    return { rank: u.rank, value: v, name: HAND_NAMES[u.rank], main: u.main, cards: cs };
  }

  /**
   * 比较两个评估结果（或打包值）。
   * @return {number} -1 / 0 / 1
   */
  function compare(a, b) {
    var va = (typeof a === 'number') ? a : (a ? a.value : 0);
    var vb = (typeof b === 'number') ? b : (b ? b.value : 0);
    if (va > vb) return 1;
    if (va < vb) return -1;
    return 0;
  }

  /**
   * 找出赢家。
   * @param {Array<{seatIndex:number, value:number}>} entries
   * @return {Array<number>} 赢家 seatIndex 列表
   */
  function findWinners(entries) {
    var winners = [];
    var best = -1;
    for (var i = 0; i < entries.length; i++) {
      var v = entries[i].value != null ? entries[i].value : 0;
      if (v > best) { best = v; winners = [entries[i].seatIndex]; }
      else if (v === best) winners.push(entries[i].seatIndex);
    }
    return winners;
  }

  function handName(rank) { return HAND_NAMES[rank] || '高牌'; }

  /**
   * 用中文描述一手牌，如 "一对A"、"同花 K高"
   * @param {Object} ev evaluate 的返回值
   * @return {string}
   */
  var RANK_TXT = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  function describe(ev) {
    if (!ev) return '';
    var m = ev.main || [];
    switch (ev.rank) {
      case 9: return '皇家同花顺';
      case 8: return '同花顺（' + RANK_TXT[m[0]] + '高）';
      case 7: return '四条' + RANK_TXT[m[0]];
      case 6: return '葫芦（' + RANK_TXT[m[0]] + '带' + RANK_TXT[m[1]] + '）';
      case 5: return '同花（' + RANK_TXT[m[0]] + '高）';
      case 4: return '顺子（' + RANK_TXT[m[0]] + '高）';
      case 3: return '三条' + RANK_TXT[m[0]];
      case 2: return '两对（' + RANK_TXT[m[0]] + '和' + RANK_TXT[m[1]] + '）';
      case 1: return '一对' + RANK_TXT[m[0]];
      default: return '高牌' + RANK_TXT[m[0]];
    }
  }

  var HandEval = {
    HAND_NAMES: HAND_NAMES,
    RANK_TXT: RANK_TXT,
    evaluate: evaluate,
    evaluateIdx: evaluateIdx,
    valueIdx: valueIdx,
    unpack: unpack,
    packValue: packValue,
    idxOf: idxOf,
    cardOf: cardOf,
    compare: compare,
    findWinners: findWinners,
    handName: handName,
    describe: describe
  };

  Poker.HandEval = HandEval;
  if (typeof module !== 'undefined' && module.exports) module.exports = HandEval;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
