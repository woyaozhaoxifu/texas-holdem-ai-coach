/* QA 批量B 独立探针：B1 跨手学习不变量 / B2 ICM 独立枚举对照 + 公式语义 / B3 慢打守卫 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
var fs = require('fs');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var ICM = require(path.join(D, 'js/icm.js'));
var C = global.Poker.Cards;
var EQ = global.Poker.Equity;
var P = global.Poker.Personalities;
var Brain = global.Poker.Brain;
var Game = require(path.join(D, 'js/game.js'));

var L = [], FAIL = 0;
function log(s) { L.push(s); }
function ok(cond, msg) {
  if (cond) log('  PASS - ' + msg);
  else { log('  FAIL - ' + msg); FAIL++; }
}
function mulberry(seed) { var a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function near(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }
function card(r, s) { return C.makeCard(r, s); }
function sumChips(g) { var t = 0; for (var i = 0; i < g.seats.length; i++) t += g.seats[i].chips; return t; }
function sumA(a) { var t = 0; a.forEach(function (v) { t += v; }); return t; }
function buildSeats(ids, chips) {
  return ids.map(function (id) { var p = P.get(id); return { id: id, name: p.name, avatar: p.avatar, isHuman: false, personality: p, chips: chips }; });
}
function playHand(g) {
  if (g.startHand() === false) return false;
  var guard = 0;
  while (!g.isHandOver && guard++ < 800) {
    if (g.currentActor < 0) return false;
    var idx = g.currentActor;
    var d = g.aiDecide(idx);
    g.act(idx, d.action, d.raiseTo, d.reason);
  }
  return guard < 800;
}
function buildDeck() { var d = []; for (var r = 2; r <= 14; r++) for (var s = 0; s < 4; s++) d.push(card(r, s)); return d; }
function holePool(n, seed) { var rng = mulberry(seed), deck = buildDeck(), out = []; for (var i = 0; i < n; i++) { var a = Math.floor(rng() * 52), b = Math.floor(rng() * 52); while (b === a) b = Math.floor(rng() * 52); out.push([deck[a], deck[b]]); } return out; }

// ==================== 0. 自研 ICM：全排列 Harville 独立实现 ====================
function myICM(stacks, payouts) {
  var n = stacks.length;
  var ev = new Array(n), i;
  for (i = 0; i < n; i++) ev[i] = 0;
  if (n === 0) return ev;
  function rec(alive, place, mult) {
    var L2 = alive.length;
    if (L2 === 0) return;
    var pos = [], t = 0, j;
    for (j = 0; j < L2; j++) { var c = Math.max(0, stacks[alive[j]]); if (c > 0) { pos.push(alive[j]); t += c; } }
    if (pos.length === 0) {
      var share = 0; for (j = 0; j < L2; j++) share += (payouts[place + j] || 0); share /= L2;
      for (j = 0; j < L2; j++) ev[alive[j]] += mult * share;
      return;
    }
    for (j = 0; j < pos.length; j++) {
      var wi = pos[j];
      var p2 = stacks[wi] / t;
      var prize = payouts[place] || 0;
      if (prize > 0) ev[wi] += mult * p2 * prize;
      var rem = [];
      for (var k = 0; k < L2; k++) if (alive[k] !== wi) rem.push(alive[k]);
      rec(rem, place + 1, mult * p2);
    }
  }
  var all = [];
  for (i = 0; i < n; i++) all.push(i);
  rec(all, 0, 1);
  return ev;
}
log('== 0. icm.js vs 自研全排列枚举 ==');
(function () {
  var cases = [
    [[100, 100, 100], [50, 30, 20]],
    [[100, 100, 100, 100], [50, 30, 20]],
    [[1000, 1000, 1000, 1000, 1000, 1000], [50, 30, 20]],
    [[0, 100, 100], [50, 30, 20]],
    [[0, 100, 100, 100], [50, 30, 20]],
    [[1000, 1000, 1000, 0, 0, 0], [50, 30, 20]],
    [[100, 200], [50, 30]],
    [[100, 200], [50, 30, 20]],
    [[100], [50, 30, 20]],
    [[100, 0], [50, 30]],
    [[2700, 1300, 1000], [60, 30, 10]],
    [[500, 500, 500, 500], [50, 30, 20]]
  ];
  cases.forEach(function (cs) {
    var st = cs[0], po = cs[1];
    var a = ICM.icmEquity(st, po), b = myICM(st, po);
    var same = a.length === b.length;
    for (var i = 0; i < a.length && same; i++) same = near(a[i], b[i], 1e-9);
    var expTot = 0, j;
    for (j = 0; j < st.length; j++) expTot += (po[j] || 0);
    var conserved = near(sumA(a), expTot, 1e-6);
    ok(same && conserved, 'stacks=[' + st.join(',') + '] pay=[' + po.join(',') + '] → ev=[' + a.map(function (x) { return Math.round(x * 1000) / 1000; }).join(',') + '] 一致且守恒(' + Math.round(sumA(a) * 1000) / 1000 + '=' + expTot + ')');
  });
  var z4 = ICM.icmEquity([0, 100, 100, 100], [50, 30, 20]);
  ok(near(z4[0], 0, 1e-9) && near(sumA(z4), 100, 1e-9), '4人桌 0 筹码座=0，其余 3 人分 100（' + z4.map(function (x) { return x.toFixed(2); }).join(',') + '）');
  var z3 = ICM.icmEquity([0, 100, 100], [50, 30, 20]);
  ok(near(z3[0], 20, 1e-9), '3人桌 0 筹码座=20（存活数≤payouts 拿末位奖金）');
  var mono = ICM.icmEquity([100, 200, 300, 400], [50, 30, 20]);
  ok(mono[0] < mono[1] && mono[1] < mono[2] && mono[2] < mono[3], '筹码单调递增 → EV 递增（' + mono.map(function (x) { return x.toFixed(2); }).join('<') + '）');
  var rng = mulberry(4242), rngOk = true, rngN = 0;
  for (var rI = 0; rI < 300; rI++) {
    var n = 2 + Math.floor(rng() * 4), stk = [], pl = [], k;
    for (k = 0; k < n; k++) stk.push(Math.floor(rng() * 2000));
    var plen = 2 + Math.floor(rng() * 3);
    for (k = 0; k < plen; k++) pl.push(10 + Math.floor(rng() * 90));
    var ra = ICM.icmEquity(stk, pl), rb = myICM(stk, pl);
    rngN++;
    for (k = 0; k < n; k++) if (!near(ra[k], rb[k], 1e-6)) { rngOk = false; break; }
    if (!rngOk) break;
  }
  ok(rngOk, '随机 ' + rngN + ' 组（n=2..5）自研与 icm.js 完全一致（tol 1e-6）');
})();

// ==================== riskPremium 语义 ====================
log('== riskPremium：独立实现一致 + 泡沫压力方向 ==');
(function () {
  function myRP(stacks, payouts, i, toCall, totalPot) {
    function myEv(ch) { var c = stacks.slice(); c[i] = Math.max(0, ch); return myICM(c, payouts)[i]; }
    var base = Math.max(0, stacks[i] || 0);
    var call = Math.max(0, toCall || 0), pot = Math.max(0, totalPot || 0);
    var evF = myEv(base), evW = myEv(base + pot - call), evL = myEv(0);
    var denom = evW - evL;
    var th = denom > 1e-9 ? Math.max(0, (evF - evL) / denom) : 1;
    var chipOdds = pot > 1e-9 ? call / pot : 1;
    return chipOdds > 1e-9 ? th / chipOdds : 1;
  }
  var scenarios = [
    [[1000, 1000, 1000], [50, 30, 20], 0, 1000, 2000],
    [[1000, 1000, 1000, 1000], [50, 30, 20], 0, 1000, 2000],
    [[1000, 1000, 1000, 1000, 1000, 1000], [50, 30, 20], 0, 1000, 2000],
    [[100, 10000, 10000], [50, 30, 20], 0, 100, 1200],
    [[1500, 2500, 3000, 4000], [50, 30, 20], 0, 1500, 3500],
    [[1500, 2500, 3000, 4000], [50, 30, 20, 10], 0, 1500, 3500]
  ];
  var eqOk = true;
  scenarios.forEach(function (sc) {
    var a = ICM.riskPremium(sc[0], sc[1], sc[2], sc[3], sc[4]);
    var b = myRP(sc[0], sc[1], sc[2], sc[3], sc[4]);
    if (!near(a, b, 1e-6)) eqOk = false;
    log('  stacks=[' + sc[0].join(',') + '] pay=[' + sc[1].join(',') + '] call=' + sc[3] + '/pot=' + sc[4] + ' → premium=' + a.toFixed(3) + '（自研=' + b.toFixed(3) + '）');
  });
  ok(eqOk, 'riskPremium 与自研一致');
  var p3 = ICM.riskPremium([1000, 1000, 1000], [50, 30, 20], 0, 1000, 2000);
  var p6 = ICM.riskPremium([1000, 1000, 1000, 1000, 1000, 1000], [50, 30, 20], 0, 1000, 2000);
  var pShort = ICM.riskPremium([100, 10000, 10000], [50, 30, 20], 0, 100, 1200);
  ok(p3 > 1 && p6 > 1 && pShort > 1, '均码全下/短码跟注 premium>1');
  var pBub = ICM.riskPremium([1500, 2500, 3000, 4000], [50, 30, 20], 0, 1500, 3500);
  var pPaid4 = ICM.riskPremium([1500, 2500, 3000, 4000], [50, 30, 20, 10], 0, 1500, 3500);
  log('  泡沫桌(4名0元)=' + pBub.toFixed(3) + ' vs 4名安慰奖10元=' + pPaid4.toFixed(3));
  ok(pBub > pPaid4, '近泡沫(4名无奖)压力大于远离泡沫(4名有安慰奖)');
})();

// ==================== 引擎接线（B2） ====================
log('== 引擎接线：match+payouts → ctx.icm ==');
(function () {
  var RAW = [{ sb: 10, bb: 20 }];
  function seatsArr() { return buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 20000); }
  var gPay = new Game({ seats: seatsArr(), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, rng: mulberry(77), match: { enabled: true, roundHands: 100, blindLevels: RAW, payouts: [50, 30, 20] } });
  gPay.startHand();
  var ctxP = gPay.buildCtx(gPay.currentActor);
  ok(!!ctxP.table.icm && ctxP.table.icm.stacks.length === 6 && ctxP.table.icm.payouts.join(',') === '50,30,20', '比赛+payouts → icm.stacks/payouts 就绪');
  var gNo = new Game({ seats: seatsArr(), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, rng: mulberry(78), match: { enabled: true, roundHands: 100, blindLevels: RAW } });
  gNo.startHand();
  ok(gNo.buildCtx(gNo.currentActor).table.icm == null, '比赛无 payouts → 无 icm');
  var gPr = new Game({ seats: seatsArr(), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, rng: mulberry(79) });
  gPr.startHand();
  ok(gPr.buildCtx(gPr.currentActor).table.icm == null, '练习模式 → 无 icm');
  var seatM = ctxP.seat, ic = ctxP.table.icm;
  ok(near(ic.stacks[ic.meIndex], seatM.chips, 1e-9), 'icm.stacks[meIndex]=' + ic.stacks[ic.meIndex] + ' == seat.chips=' + seatM.chips + '（弃牌EV只算剩余筹码，未把已下注算两遍）');
})();

// ==================== 泡沫 call→fold 翻转（确定性） ====================
log('== 泡沫确定性 call→fold（A8o on J♠8♥3♦）==');
(function () {
  function seatB(id, hole) {
    var base = P.get(id); var p2 = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p2[k] = base[k];
    return { id: id, name: base.name, personality: p2, hole: hole, chips: 1000, bet: 0, mood: 0, consecutiveLosses: 0, relations: {}, stats: { hands: 50 } };
  }
  function ctxB(hole, withIcm) {
    var t = { board: [card(11, 0), card(8, 1), card(3, 2)], pot: 1000, currentBet: 1000, minRaise: 20, bigBlind: 20, street: 'flop', numOpponents: 2, aggressorId: 'x', raiseCount: 1, positionFactor: 0.6, stealOpportunity: false, stealAttempt: false, opponents: [] };
    if (withIcm) t.icm = { payouts: [50, 30, 20], stacks: [1000, 1000, 1000], meIndex: 0 };
    return { seat: seatB('boss', hole), playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 }, table: t };
  }
  var A8o = [card(14, 0), card(8, 2)];
  Math.random = mulberry(20240907);
  var d0 = Brain.decide(ctxB(A8o, false));
  Math.random = mulberry(20240907);
  var d1 = Brain.decide(ctxB(A8o, true));
  log('  noICM=' + d0.action + ' withICM=' + d1.action + ' reason=' + d1.reason);
  ok(d0.action === 'call' && d1.action === 'fold' && d1.reason.indexOf('ICM') >= 0, '同局面 ICM 把跟注翻成弃');
})();

// ==================== B1 手末统计不变量（真实引擎 90 手） ====================
log('== B1 手末统计不变量（真实 90 手 6 人桌无补筹）==');
(function () {
  var g = new Game({ seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 50000), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 50000, autoRebuy: false, rng: mulberry(555) });
  var TOTAL = sumChips(g);
  for (var h = 0; h < 90; h++) { if (playHand(g) === false) break; if (sumChips(g) !== TOTAL) throw new Error('conservation B1'); }
  var allOk = true, anyV = false, pfrLtV = true, tbLtPfr = true, fcrLtCbf = true;
  g.seats.forEach(function (s) {
    var st = s.stats;
    if (st.hands < 0 || st.vpip < 0 || st.vpip > st.hands) allOk = false;
    if (st.pfr < 0 || st.pfr > st.hands) allOk = false;
    if (st.vpip > 0) anyV = true;
    if (st.pfr > st.vpip) pfrLtV = false;
    if (st.threeBet > st.pfr) tbLtPfr = false;
    if (st.foldToCBet > st.cBetFaced) fcrLtCbf = false;
    ['folds', 'calls', 'raises', 'showdowns', 'wins', 'threeBet', 'steal', 'cBetFaced', 'foldToCBet', 'facedBet', 'foldsToBet'].forEach(function (f) { if (st[f] < 0) allOk = false; });
  });
  ok(allOk, 'vpip/pfr∈[0,hands]、全部计数非负');
  ok(pfrLtV && tbLtPfr && fcrLtCbf, 'pfr≤vpip、threeBet≤pfr、foldToCBet≤cBetFaced');
  ok(anyV, '确有统计被累计');
  var snap = g.seats.map(function (s) { var o = {}; for (var k in s.stats) o[k] = s.stats[k]; return o; });
  playHand(g);
  // 口径说明（见 game.js act() 内注释）：
  //  - 「每手一次」口径（手末 updateSeatStats 统一结算）：
  //    hands / vpip / pfr / threeBet / steal / cBetFaced / foldToCBet / showdowns / wins
  //    → 单手增量必须 ∈[0,1]
  //  - 「逐次动作」口径（Boss 读人用，act() 内每次动作累加）：
  //    calls / raises / folds / facedBet / foldsToBet
  //    → 一手含 4 个下注轮，同一座位可合法多次跟注/加注，增量 >1 是正常的
  var PER_HAND = ['hands', 'vpip', 'pfr', 'threeBet', 'steal', 'cBetFaced', 'foldToCBet', 'showdowns', 'wins'];
  var dOk = true, actOk = true;
  g.seats.forEach(function (s, i) {
    for (var k in s.stats) {
      var inc = s.stats[k] - (snap[i][k] || 0);
      if (PER_HAND.indexOf(k) >= 0) {
        if (inc < 0 || inc > 1) { dOk = false; log('    seat ' + s.id + ' ' + k + ' 每手增量=' + inc + '（应 ∈[0,1]）'); }
      } else if (inc < 0 || inc > 12) {
        actOk = false; log('    seat ' + s.id + ' ' + k + ' 动作增量=' + inc + '（超合理上界）');
      }
    }
  });
  ok(dOk, '额外一手：每手一次口径统计（vpip/pfr/threeBet/steal/showdowns/wins…）单手增量 ∈[0,1]');
  ok(actOk, '额外一手：逐次动作口径统计（calls/raises/folds/facedBet/foldsToBet）非负且有界');
  var g2 = new Game({ seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 50000), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 50000 });
  var zero = true;
  g2.seats.forEach(function (s) { for (var k in s.stats) if (s.stats[k] !== 0) zero = false; });
  ok(zero, '新 Game 所有 seat.stats 归零（无跨桌泄漏）');
})();

// ==================== B1 Boss 消费历史（独立语境） ====================
log('== B1 Boss 读对手历史（自构语境，独立样本 N=5000）==');
(function () {
  function seatL(id, hole) {
    var base = P.get(id); var p2 = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p2[k] = base[k];
    p2.equitySamples = 120;
    return { id: id, name: base.name, personality: p2, hole: hole, chips: 5000, bet: 0, mood: 0, consecutiveLosses: 0, relations: {}, stats: { hands: 50 } };
  }
  function opp(vpip, fcrC, fcrF) { return { id: 'o', name: 'o', hands: 40, vpip: vpip, pfr: 0.1, threeBet: 3, steal: 4, cBetFaced: fcrC, foldToCBet: fcrF, showdowns: 8 }; }
  function stealCtx(id, hole, opponents) {
    return { seat: seatL(id, hole), playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 }, table: { board: [], pot: 45, currentBet: 0, minRaise: 20, bigBlind: 20, street: 'preflop', numOpponents: opponents.length, aggressorId: null, raiseCount: 0, positionFactor: 0.85, stealOpportunity: true, stealAttempt: false, opponents: opponents } };
  }
  var N = 5000, holes = holePool(N, 13579);
  function rate(id, opps, seed) {
    var saved = Math.random; Math.random = mulberry(seed);
    var n = 0;
    try { for (var i = 0; i < N; i++) { var d = Brain.decide(stealCtx(id, holes[i], opps)); if (d.action === 'raise' || d.action === 'allin') n++; } }
    finally { Math.random = saved; }
    return n / N;
  }
  var tight = [opp(0.10, 10, 8), opp(0.14, 10, 7), opp(0.16, 10, 6)];
  var loose = [opp(0.62, 10, 2), opp(0.55, 10, 3), opp(0.58, 10, 2)];
  var bt = rate('boss', tight, 2468), bl = rate('boss', loose, 2468), bn = rate('boss', [], 2468);
  log('  boss 偷盲率 紧=' + (bt * 100).toFixed(1) + '% 松=' + (bl * 100).toFixed(1) + '% 无历史=' + (bn * 100).toFixed(1) + '%');
  ok(bt > bl + 0.08 && bt > bn + 0.05, 'boss 读历史：紧桌比松桌/无历史显著多偷（Δ' + ((bt - bl) * 100).toFixed(1) + 'pp）');
  var st = rate('solver', tight, 7777), sl = rate('solver', loose, 7777);
  log('  solver 偷盲率 紧=' + (st * 100).toFixed(1) + '% 松=' + (sl * 100).toFixed(1) + '%');
  ok(Math.abs(st - sl) < 0.03, 'solver（adaptivity 0.45）不消费历史（Δ' + (Math.abs(st - sl) * 100).toFixed(1) + 'pp）');
  var tt = rate('tag', tight, 8888), tl = rate('tag', loose, 8888);
  log('  tag 偷盲率 紧=' + (tt * 100).toFixed(1) + '% 松=' + (tl * 100).toFixed(1) + '%');
  ok(Math.abs(tt - tl) < 0.03, 'tag（adaptivity 0.15）不消费历史（Δ' + (Math.abs(tt - tl) * 100).toFixed(1) + 'pp）');
})();

// ==================== B3 慢打（独立测量） ====================
log('== B3 慢打守卫与收网 ==');
(function () {
  var B_DRY = [card(11, 0), card(8, 1), card(3, 2)];
  var B_WET = [card(11, 1), card(10, 1), card(9, 1)];
  var H2P = [card(11, 2), card(8, 0)];
  var H2PW = [card(11, 2), card(10, 0)];
  function seatT(id, over) {
    var base = P.get(id); var p2 = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p2[k] = base[k];
    var s = { id: id, name: base.name, personality: p2, hole: H2P, chips: 3000, bet: 0, mood: 0, consecutiveLosses: 0, relations: {}, stats: { hands: 50 }, _trap: false, _trapDone: false };
    if (over) for (var k2 in over) if (Object.prototype.hasOwnProperty.call(over, k2)) s[k2] = over[k2];
    return s;
  }
  function ctxT(seat, board, pot, cb, street) {
    return { seat: seat, playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 }, table: { board: board, pot: pot, currentBet: cb, minRaise: 20, bigBlind: 20, street: street || 'flop', numOpponents: 2, aggressorId: 'x', raiseCount: 1, positionFactor: 0.6, stealOpportunity: false, stealAttempt: false, opponents: [] } };
  }
  function trapRate(id, board, n, seed, chips, hole) {
    var saved = Math.random, c = 0;
    try {
      for (var i = 0; i < n; i++) {
        Math.random = mulberry(seed + i);
        var seat = seatT(id, { chips: chips, hole: hole || H2P });
        var d = Brain.decide(ctxT(seat, board, 600, 200, 'flop'));
        if (d.action === 'call' && d.reason.indexOf('慢打') >= 0) c++;
      }
    } finally { Math.random = saved; }
    return c / n;
  }
  var N = 900;
  var bD = trapRate('boss', B_DRY, N, 6001, 3000, H2P);
  var bW = trapRate('boss', B_WET, N, 6002, 3000, H2PW);
  var rD = trapRate('rock', B_DRY, N, 6003, 3000, H2P);
  var fD = trapRate('fish', B_DRY, N, 6004, 3000, H2P);
  var sD = trapRate('boss', B_DRY, N, 6005, 200, H2P);
  log('  boss 干=' + (bD * 100).toFixed(1) + '% 湿=' + (bW * 100).toFixed(1) + '% rock=' + (rD * 100).toFixed(1) + '% fish=' + (fD * 100).toFixed(1) + '% 短码=' + (sD * 100).toFixed(1) + '%');
  ok(bD > 0.08, 'boss 干面两对明显慢打（' + (bD * 100).toFixed(1) + '%）');
  ok(bW < bD * 0.85 && bW > 0.01, '湿面概率减半（' + (bW * 100).toFixed(1) + '% < ' + (bD * 100).toFixed(1) + '%×0.85）');
  ok(rD === 0 && fD === 0, 'rock/fish（tricky<0.15）永不慢打');
  ok(sD === 0, '短码（后手<0.6×pot）永不慢打');
  // 每手至多一次守卫：_trapDone 后不再设陷阱
  var saved = Math.random, hits = 0;
  try {
    for (var i = 0; i < 1200; i++) {
      Math.random = mulberry(7000 + i);
      var seat2 = seatT('boss', { _trap: false, _trapDone: true, chips: 3000, hole: H2P });
      var d2 = Brain.decide(ctxT(seat2, B_DRY, 600, 200, 'flop'));
      if (d2.action === 'call' && d2.reason.indexOf('慢打') >= 0) hits++;
    }
  } finally { Math.random = saved; }
  ok(hits === 0, '_trapDone 后 1200 次 0 复触发');
  // 收网 ≥0.7×pot
  var seatNet = seatT('boss', { _trap: true, _trapDone: true, chips: 3000, hole: H2P });
  var dNet = Brain.decide({ seat: seatNet, playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 }, table: { board: B_DRY, pot: 1000, currentBet: 0, minRaise: 20, bigBlind: 20, street: 'turn', numOpponents: 2, aggressorId: seatNet.id, raiseCount: 0, positionFactor: 0.6, stealOpportunity: false, stealAttempt: false, opponents: [] } });
  log('  收网 action=' + dNet.action + ' raiseTo=' + dNet.raiseTo + ' ' + dNet.reason);
  ok((dNet.action === 'raise' || dNet.action === 'allin') && dNet.raiseTo >= Math.round(1000 * 0.7), '收网 ≥0.7×pot（' + dNet.raiseTo + '）');
  ok(dNet.reason.indexOf('陷阱收网') >= 0, '收网理由标注');
})();

// ==================== B3 引擎真实对局：每座每手至多一次 + 守恒 ====================
log('== B3 真实对局（250 手）每手至多一次 + 守恒 ==');
(function () {
  var g = new Game({ seats: buildSeats(['tag', 'lag', 'solver', 'boss', 'rock', 'fish'], 30000), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 30000, autoRebuy: false, rng: mulberry(314159) });
  var TOTAL = sumChips(g);
  var slowCount = 0, netCount = 0, repeatSeatHand = 0;
  for (var h = 0; h < 250; h++) {
    if (playHand(g) === false) break;
    if (sumChips(g) !== TOTAL) throw new Error('B3 conservation');
    var perSeat = {};
    var logList = g.lastResult ? g.lastResult.handLog : [];
    logList.forEach(function (e) {
      if (!e || typeof e.seatIndex !== 'number' || !e.reason) return;
      if (e.reason.indexOf('慢打') >= 0) { slowCount++; perSeat[e.seatIndex] = (perSeat[e.seatIndex] || 0) + 1; }
      if (e.reason.indexOf('陷阱收网') >= 0) netCount++;
    });
    for (var k in perSeat) if (perSeat[k] > 1) repeatSeatHand++;
  }
  ok(sumChips(g) === TOTAL, '250 手筹码守恒');
  log('  250 手累计：慢打 ' + slowCount + ' 次 / 收网 ' + netCount + ' 次 / 重复(座,手) ' + repeatSeatHand + ' 次');
  ok(repeatSeatHand === 0, '任何座位任何一手慢打至多一次');
})();

fs.writeFileSync(path.join(__dirname, '_qa_bb_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL === 0 ? 0 : 1);
