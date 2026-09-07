/* B2 ICM 探针：icmEquity 正确性 + riskPremium 压力 + 引擎接线 + 泡沫弃牌收紧 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
var fs = require('fs');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var ICM = require(path.join(D, 'js/icm.js'));
var C = global.Poker.Cards;
var P = global.Poker.Personalities;
var Brain = global.Poker.Brain;
var Game = require(path.join(D, 'js/game.js'));

var L = [], FAIL = 0;
function log(s) { L.push(s); }
function ok(cond, msg) {
  if (cond) log('  PASS - ' + msg);
  else { log('  FAIL - ' + msg); FAIL++; }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }
function mulberry(seed) { var a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function card(r, s) { return C.makeCard(r, s); }
function sum(ev) { var t = 0; ev.forEach(function (v) { t += v; }); return t; }
function sumP(payouts) { var t = 0; payouts.forEach(function (v) { t += v; }); return t; }

// ===================== A. icmEquity 数值正确性 =====================
log('== A icmEquity 数值正确性 ==');
(function () {
  function check(label, stacks, payouts, expect, tol) {
    var ev = ICM.icmEquity(stacks, payouts);
    var allOk = ev.length === expect.length;
    for (var i = 0; i < ev.length && allOk; i++) allOk = near(ev[i], expect[i], tol || 0.01);
    ok(allOk, label + ' ev=[' + ev.map(function (x) { return Math.round(x * 100) / 100; }).join(',') + ']');
    // 总 EV = 已分发的前 ev.length 名奖金（多出来的名次奖金属于早已出局者，不计入本快照）
    var expectedTotal = 0;
    for (var j = 0; j < ev.length; j++) expectedTotal += (payouts[j] || 0);
    ok(near(sum(ev), expectedTotal, (tol || 0.01) + 1e-9), label + ' 总EV=前' + ev.length + '名奖金和(' + expectedTotal + ')');
  }
  check('3人等码', [100, 100, 100], [50, 30, 20], [33.333, 33.333, 33.333]);
  check('6人等码(前3名有奖)', [1000, 1000, 1000, 1000, 1000, 1000], [50, 30, 20], [16.667, 16.667, 16.667, 16.667, 16.667, 16.667]);
  check('单挑大码', [100, 200], [50, 30], [36.667, 43.333]);
  check('0筹码=末位奖金', [0, 100, 100], [50, 30, 20], [20, 40, 40]);
  check('已出局者不参与未来名次', [1000, 1000, 1000, 0, 0, 0], [50, 30, 20], [33.333, 33.333, 33.333, 0, 0, 0]);
  check('剩1正筹码', [100, 0], [50, 30], [50, 30]);
  check('仅1人', [100], [50, 30, 20], [50]);
  var mono = ICM.icmEquity([100, 200, 300], [50, 30, 20]);
  ok(mono[0] < mono[1] && mono[1] < mono[2], '筹码单调：100<200<300 对应 EV 递增（' + mono.map(function (x) { return x.toFixed(2); }).join('<') + '）');
  ok(near(sum(mono), 100, 0.01), '100/200/300 总EV=100');
})();

// ===================== B. riskPremium 压力方向 =====================
log('== B riskPremium ICM 压力 ==');
(function () {
  var equal3 = ICM.riskPremium([1000, 1000, 1000], [50, 30, 20], 0, 1000, 2000);
  var sixEqual = ICM.riskPremium([1000, 1000, 1000, 1000, 1000, 1000], [50, 30, 20], 0, 1000, 2000);
  var short = ICM.riskPremium([100, 10000, 10000], [50, 30, 20], 0, 100, 1200);
  log('  riskPremium: 3人等码全下=' + equal3.toFixed(3) + ' / 6人等码全下=' + sixEqual.toFixed(3) + ' / 短码跟注=' + short.toFixed(3));
  ok(equal3 > 1.4 && equal3 < 1.51, '3人等码全下有明显 ICM 压力（' + equal3.toFixed(3) + '）');
  ok(sixEqual > 1.2 && sixEqual < 1.4, '6人等码全下压力 >1（' + sixEqual.toFixed(3) + '）');
  ok(short >= 1.0 && short < equal3, '短码赔率极好压力最小且 < 等码泡沫（' + short.toFixed(3) + '）');
  // 泡沫更陡：3 人 3 奖 vs 6 人 3 奖，越接近奖金线越谨慎
  var heads = ICM.riskPremium([1000, 1000], [50, 30], 0, 1000, 2000);
  log('  单挑(50/30)全下=' + heads.toFixed(3));
  ok(heads > 1.2, '单挑争冠也有生存压力（' + heads.toFixed(3) + '）');
})();

// ===================== C. 引擎接线 =====================
log('== C 引擎接线：match+payouts → ctx.table.icm ==');
function buildSeats(ids, chips) {
  return ids.map(function (id) { var p = P.get(id); return { id: id, name: p.name, personality: p, chips: chips }; });
}
var RAW = [{ sb: 10, bb: 20 }];
var gPay = new Game({
  seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 20000),
  smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, rng: mulberry(31),
  match: { enabled: true, roundHands: 100, blindLevels: RAW, payouts: [50, 30, 20] }
});
ok(gPay.match.payouts !== null && gPay.match.payouts.join(',') === '50,30,20', 'match.payouts 已透传');
gPay.startHand();
var idx = gPay.currentActor;
var ctxPay = gPay.buildCtx(idx);
var ic = ctxPay.table.icm;
ok(!!ic && ic.payouts.join(',') === '50,30,20' && ic.payouts.length === 3, '存活6人 icm.payouts=前3名奖金 [50,30,20]（第4名起=0）');
ok(!!ic && ic.stacks.length === 6, '存活6人 icm.stacks 长度6');
ok(!!ic && ic.meIndex === idx, 'icm.meIndex=当前座在存活列表中的位置');
var gNoPay = new Game({
  seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 20000),
  smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, rng: mulberry(32),
  match: { enabled: true, roundHands: 100, blindLevels: RAW }   // 无 payouts
});
gNoPay.startHand();
var ctxNoPay = gNoPay.buildCtx(gNoPay.currentActor);
ok(ctxNoPay.table.icm === null || ctxNoPay.table.icm === undefined, '比赛但无 payouts → 无 icm');
var gPrac = new Game({
  seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 20000),
  smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, rng: mulberry(33)
});
gPrac.startHand();
ok(gPrac.buildCtx(gPrac.currentActor).table.icm == null, '练习模式 → 无 icm');

// ===================== D. 泡沫弃牌收紧（确定性单点翻转） =====================
log('== D 泡沫边缘：跟全下从「跟」翻成「弃」（A8o on J83，3人等码）==');
function seatOf(id, hole) {
  var base = P.get(id);
  var p2 = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p2[k] = base[k];
  return { id: id, name: base.name, personality: p2, hole: hole, chips: 1000, bet: 0, mood: 0, consecutiveLosses: 0, relations: {}, stats: { hands: 50 } };
}
function bubbleCtx(hole, withIcm) {
  var t = {
    board: [card(11, 0), card(8, 1), card(3, 2)], pot: 1000, currentBet: 1000, minRaise: 20, bigBlind: 20,
    street: 'flop', numOpponents: 2, aggressorId: 'x', raiseCount: 1, positionFactor: 0.6,
    stealOpportunity: false, stealAttempt: false, opponents: [], playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 }
  };
  if (withIcm) t.icm = { payouts: [50, 30, 20], stacks: [1000, 1000, 1000], meIndex: 0 };
  return { seat: seatOf('boss', hole), playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 }, table: t };
}
var A8o = [card(14, 0), card(8, 2)];
Math.random = mulberry(101);
var d0 = Brain.decide(bubbleCtx(A8o, false));
Math.random = mulberry(101);
var d1 = Brain.decide(bubbleCtx(A8o, true));
log('  noICM=' + d0.action + ' / withICM=' + d1.action + (d1.reason.indexOf('ICM') >= 0 ? '（' + d1.reason + '）' : ''));
ok(d0.action === 'call', '无 ICM：A8o 面对全下 50% 赔率 → 跟');
ok(d1.action === 'fold' && d1.reason.indexOf('ICM') >= 0, '有 ICM：同样局面保护名次 → 弃并标注 ICM');

fs.writeFileSync(path.join(__dirname, '_icm_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL === 0 ? 0 : 1);
