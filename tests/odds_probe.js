/* global __dirname */
/**
 * odds_probe.js —— 胜率助手确定性穷举的独立探针。
 *
 * 校验 Equity.oddsPanel / describeHole：
 *   ① 河牌皇家同花顺 → beats 为空、equity1 = 1、total = C(45,2) = 990
 *   ② 翻牌顶对 → 输给「两对 21 / 三条 7」、平局 6、总 1081、wins+ties+loses=total
 *   ③ 翻牌/转牌/河牌通用不变式：wins+ties+loses=total 且 equity1=(win+ties/2)/total
 *   ④ 翻前：蒙特卡洛 equity1 落在常识区间、equityN 与独立 winRate 在容差内
 * 退出码非 0 即失败。
 */
(function () {
  'use strict';
  var path = require('path');
  var base = path.join(__dirname, '..', 'js');
  var HandEval = require(path.join(base, 'handEval.js'));
  var Equity = require(path.join(base, 'equity.js'));

  var pass = 0, fail = 0;
  function ok(cond, msg) {
    if (cond) { pass++; console.log('  ok  - ' + msg); }
    else { fail++; console.log('  FAIL- ' + msg); }
  }
  function close(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-9); }

  // 种子随机（mulberry32），保证测试可复现
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function C2(n) { return n * (n - 1) / 2; }

  // 独立的翻牌穷举（另起炉灶计数，用于交叉验证聚合逻辑）
  function brute(holeIdx, boardIdx) {
    var used = new Uint8Array(52), i, j;
    for (i = 0; i < holeIdx.length; i++) used[holeIdx[i]] = 1;
    for (i = 0; i < boardIdx.length; i++) used[boardIdx[i]] = 1;
    var unseen = [];
    for (i = 0; i < 52; i++) if (!used[i]) unseen.push(i);
    var nAll = holeIdx.length + boardIdx.length;
    var myAll = holeIdx.concat(boardIdx);
    var myVal = HandEval.valueIdx(myAll, nAll);
    var wins = 0, ties = 0, loses = 0, byRank = {};
    var m = unseen.length;
    for (i = 0; i < m; i++) {
      for (j = i + 1; j < m; j++) {
        var opp = boardIdx.concat([unseen[i], unseen[j]]);
        var ov = HandEval.valueIdx(opp, nAll);
        if (ov > myVal) {
          loses++;
          var rk = Math.floor(ov / 1048576);
          byRank[rk] = (byRank[rk] || 0) + 1;
        } else if (ov === myVal) ties++;
        else wins++;
      }
    }
    return { wins: wins, ties: ties, loses: loses, byRank: byRank, total: C2(m) };
  }

  console.log('== ① 河牌皇家同花顺（必赢） ==');
  (function () {
    var hole = [{ r: 14, s: 0 }, { r: 13, s: 0 }]; // A♠ K♠
    var board = [{ r: 12, s: 0 }, { r: 11, s: 0 }, { r: 10, s: 0 }, { r: 2, s: 3 }, { r: 3, s: 2 }]; // Q♠J♠T♠2♣3♦
    var d = Equity.oddsPanel(hole, board, 1);
    ok(d.street === 'river' && !d.preflop, 'street=river');
    ok(d.total === C2(45) && d.total === 990, 'total = C(45,2) = 990（实际 ' + d.total + '）');
    ok(d.wins === 990 && d.ties === 0 && d.loses === 0, '皇家同花顺赢下全部 990 组合');
    ok(d.beats.length === 0, 'beats 为空（无人能赢）');
    ok(close(d.equity1, 1), 'equity1 = 1（实际 ' + d.equity1 + '）');
    ok(d.myMadeRank === 9 && d.myMadeName === '皇家同花顺', '我当前成牌=皇家同花顺');
  })();

  console.log('== ② 翻牌顶对 A（A♠K♠ / A♥7♣2♦） ==');
  (function () {
    var hole = [{ r: 14, s: 0 }, { r: 13, s: 0 }];
    var board = [{ r: 14, s: 1 }, { r: 7, s: 3 }, { r: 2, s: 2 }];
    var holeIdx = [48, 44], boardIdx = [49, 23, 2];
    var d = Equity.oddsPanel(hole, board, 1);
    ok(d.street === 'flop', 'street=flop');
    ok(d.total === C2(47) && d.total === 1081, 'total = C(47,2) = 1081（实际 ' + d.total + '）');

    var b = brute(holeIdx, boardIdx);
    ok(d.wins === b.wins && d.ties === b.ties && d.loses === b.loses,
      'wins/ties/loses 与独立穷举一致 (' + d.wins + '/' + d.ties + '/' + d.loses + ')');
    ok(d.wins + d.ties + d.loses === d.total, 'wins+ties+loses === total');
    ok(close(d.equity1, (d.wins + d.ties / 2) / d.total), 'equity1 = (wins+ties/2)/total');

    var twoPair = null, trips = null;
    d.beats.forEach(function (x) {
      if (x.name === '两对') twoPair = x;
      if (x.name === '三条') trips = x;
    });
    ok(!!twoPair && twoPair.count === 21, '输给「两对」= 21（实际 ' + (twoPair && twoPair.count) + '）');
    ok(!!trips && trips.count === 7, '输给「三条」= 7（实际 ' + (trips && trips.count) + '）');
    ok(d.ties === 6, '平局 = 6（对手 A+K）实际 ' + d.ties);
    ok(d.wins === 1047, '我赢 = 1047（实际 ' + d.wins + '）');
    ok(d.beats.length === 2, 'beats 只有两对/三条两类（实际 ' + d.beats.length + '）');
    var beatSum = 0;
    d.beats.forEach(function (x) { beatSum += x.count; });
    ok(beatSum === d.loses, 'beats 计数和 === loses');
  })();

  console.log('== ③ 转牌不变式（含 beat 类别与独立穷举一致） ==');
  (function () {
    var hole = [{ r: 14, s: 0 }, { r: 13, s: 0 }];
    var board = [{ r: 14, s: 1 }, { r: 7, s: 3 }, { r: 2, s: 2 }, { r: 9, s: 0 }];
    var holeIdx = [48, 44], boardIdx = [49, 23, 2, (9 - 2) * 4 + 0];
    var d = Equity.oddsPanel(hole, board, 3);
    ok(d.street === 'turn', 'street=turn');
    ok(d.total === C2(46) && d.total === 1035, 'total = C(46,2) = 1035（实际 ' + d.total + '）');
    var b = brute(holeIdx, boardIdx);
    ok(d.wins === b.wins && d.ties === b.ties && d.loses === b.loses,
      'wins/ties/loses 与独立穷举一致 (' + d.wins + '/' + d.ties + '/' + d.loses + ')');
    ok(d.wins + d.ties + d.loses === d.total, 'wins+ties+loses === total');
    ok(close(d.tiePct, d.ties / d.total), 'tiePct === ties/total');
    ok(d.numOpponents === 3 && d.equityN > 0 && d.equityN <= d.equity1, 'equityN 按近似公式单调不高于 equity1');
    var beatSum = 0;
    d.beats.forEach(function (x) { beatSum += x.count; });
    ok(beatSum === d.loses, 'beats 计数和 === loses');
  })();

  console.log('== ④ 翻牌前（AA vs 3，蒙特卡洛 + 近似公式） ==');
  (function () {
    var hole = [{ r: 14, s: 0 }, { r: 14, s: 1 }]; // A♠A♥
    var d = Equity.oddsPanel(hole, [], 3, 800, mulberry32(20260907));
    ok(d.preflop === true && d.street === 'preflop', 'preflop=true');
    ok(d.beats.length === 0 && d.total === 0, '翻前无 beats/组合');
    ok(!!d.holeDesc && d.holeDesc.indexOf('对子') >= 0, 'holeDesc 描述对子（' + d.holeDesc + '）');
    ok(d.equity1 > 0.75 && d.equity1 < 0.92, 'AA vs1 equity1 落在常识区间（' + d.equity1.toFixed(3) + '）');

    var mc3 = Equity.winRate(hole, [], 3, 1500, mulberry32(777));
    ok(Math.abs(d.equityN - mc3.equity) < 0.1,
      'equityN 与独立 winRate 差 < 0.1（' + d.equityN.toFixed(3) + ' vs ' + mc3.equity.toFixed(3) + '）');
  })();

  console.log('== describeHole 快查 ==');
  (function () {
    ok(Equity.describeHole([{ r: 9, s: 0 }, { r: 9, s: 2 }]) === '对子 9', '对子');
    ok(Equity.describeHole([{ r: 14, s: 0 }, { r: 13, s: 0 }]).indexOf('同花连张') >= 0, '同花连张');
    ok(Equity.describeHole([{ r: 12, s: 1 }, { r: 11, s: 1 }]).indexOf('连张') >= 0, '连张');
    // P2-2：Broadway 非对子应归为「两高张」，不再是间隔连牌
    ok(Equity.describeHole([{ r: 14, s: 0 }, { r: 11, s: 2 }]) === '两高张 AJ', 'AJ → 两高张');
    ok(Equity.describeHole([{ r: 14, s: 0 }, { r: 12, s: 2 }]) === '两高张 AQ', 'AQ → 两高张');
    ok(Equity.describeHole([{ r: 13, s: 0 }, { r: 11, s: 2 }]) === '两高张 KJ', 'KJ → 两高张');
    ok(Equity.describeHole([{ r: 9, s: 0 }, { r: 8, s: 0 }]) === '同花连张 98', '98s → 同花连张');
    ok(Equity.describeHole([{ r: 7, s: 0 }, { r: 7, s: 2 }]) === '对子 7', '77 → 对子');
    ok(Equity.describeHole([{ r: 14, s: 0 }, { r: 12, s: 0 }]) === '同花高张 AQ', 'AQs → 同花高张');
  })();

  console.log('');
  console.log('odds_probe 结果：PASS ' + pass + ' / FAIL ' + fail);
  if (fail > 0) process.exit(1);
})();
