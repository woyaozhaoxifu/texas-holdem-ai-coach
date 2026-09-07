/* B1 跨手历史学习 探针：seat.stats 每手一次口径 + Boss 读对手客观历史调整偷盲/诈唬 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
var fs = require('fs');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
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
function mulberry(seed) { var a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sumChips(g) { var t = 0; for (var i = 0; i < g.seats.length; i++) t += g.seats[i].chips; return t; }
function card(r, s) { return C.makeCard(r, s); }
function buildSeats(ids, chips) {
  return ids.map(function (id) { var p = P.get(id); return { id: id, name: p.name, avatar: p.avatar, isHuman: false, personality: p, chips: chips }; });
}
function playHand(g) {
  var s = g.startHand();
  if (s === false) return false;
  var guard = 0;
  while (!g.isHandOver && guard++ < 800) {
    if (g.currentActor < 0) throw new Error('hand ' + g.handNo + ' stuck');
    var idx = g.currentActor;
    var d = g.aiDecide(idx);
    g.act(idx, d.action, d.raiseTo, d.reason);
  }
  if (guard >= 800) throw new Error('hand ' + g.handNo + ' loop');
  return true;
}

// ===================== A. 引擎手末统计口径 =====================
log('== A seat.stats 每手一次统计（60 手自动对战）==');
var PERS = ['fish', 'rock', 'tag', 'lag', 'solver', 'boss'];
var gA = new Game({
  seats: buildSeats(PERS, 20000), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000,
  autoRebuy: false, rng: mulberry(9001)
});
var TOTAL_A = sumChips(gA);
var handsPlayedA = 0;
for (var hA = 0; hA < 60; hA++) {
  if (playHand(gA) === false) break;
  handsPlayedA++;
  if (sumChips(gA) !== TOTAL_A) throw new Error('A conservation broken at hand ' + hA);
}
ok(handsPlayedA === 60 && sumChips(gA) === TOTAL_A, '60 手自动对战全部打完且筹码守恒（' + TOTAL_A + '，无补筹）');
var allStatsOk = true, anyVpip = false, anyPfr = false, anyBetFaced = false, survivors = 0, totalHandsSeen = 0;
gA.seats.forEach(function (s) {
  var st = s.stats;
  totalHandsSeen += st.hands;
  if (!s.sittingOut && st.hands === 60) survivors++;
  if (st.hands < 1 || st.hands > 60) allStatsOk = false;
  if (!(st.vpip >= 0 && st.vpip <= st.hands)) allStatsOk = false;
  if (!(st.pfr >= 0 && st.pfr <= st.hands)) allStatsOk = false;
  if (!(st.folds >= 0 && st.calls >= 0 && st.raises >= 0 && st.threeBet >= 0 && st.steal >= 0 && st.cBetFaced >= 0 && st.foldToCBet >= 0 && st.showdowns >= 0 && st.wins >= 0)) allStatsOk = false;
  if (st.vpip > 0) anyVpip = true;
  if (st.pfr > 0) anyPfr = true;
  if (st.facedBet > 0 || st.cBetFaced > 0) anyBetFaced = true;
});
ok(allStatsOk, '每个座位 vpip/pfr ∈ [0,hands]、所有计数非负（含坐出座）');
ok(survivors >= 1 && totalHandsSeen >= 200, '至少 1 人打满 60 手且全场累计统计样本≥200（' + survivors + ' 人打满，总样本 ' + totalHandsSeen + '）');
ok(anyVpip && anyPfr, '统计实际工作：有人 vpip>0 且有人 pfr>0');
ok(anyBetFaced, 'Bet-facing 口径在累计（AI:cBetFaced 或人类:facedBet）');
// 手末口径：每手最多 +1 → vpip ≤ hands 已在上断言；再查 showdowns≤hands、wins≤showdowns+非摊牌胜利
var sdOk = true;
gA.seats.forEach(function (s) {
  if (s.stats.showdowns > 60 || s.stats.wins > 60) sdOk = false;
});
ok(sdOk, 'showdowns/wins 手末口径有界');
// buildCtx 对手快照接线（用当前仍存活座位快照；可能含已坐出座）
var actorA = -1, activeA = 0;
gA.seats.forEach(function (s) { if (!s.sittingOut) { if (actorA < 0) actorA = s.index != null ? s.index : gA.seats.indexOf(s); activeA++; } });
ok(actorA >= 0 && activeA >= 2, '仍有 ≥2 名存活者可开局（存活 ' + activeA + '）');
gA.startHand();
var ctxA = gA.buildCtx(actorA);
var opps = ctxA.table.opponents || [];
ok(opps.length === activeA - 1, 'buildCtx 提供 ' + opps.length + ' 名对手快照（存活 ' + activeA + ' 人）');
var oppOk = true;
opps.forEach(function (o) {
  if (!o || typeof o.hands !== 'number' || o.hands < 59) oppOk = false;
  if (!(o.vpip >= 0 && o.vpip <= 1) || !(o.pfr >= 0 && o.pfr <= 1)) oppOk = false;
  if (!(o.cBetFaced >= 0) || !(o.foldToCBet >= 0) || !(o.threeBet >= 0) || !(o.steal >= 0) || !(o.showdowns >= 0)) oppOk = false;
});
ok(oppOk, '对手快照字段齐全且 hands≥59、vpip/pfr 归一化');
// A 局中途已开局，需手动结束避免悬挂（直接销毁实例即可，Node 进程退出无需清理）

// ===================== B. Boss 读对手历史 → 偷盲频率 =====================
log('== B Boss 读历史：紧桌多偷 / 松桌少偷（solver 不消费）==');
function seatOf(id, hole, over) {
  var base = P.get(id);
  var p2 = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p2[k] = base[k];
  var s = {
    id: id, name: base.name, personality: p2, hole: hole, chips: 5000, bet: 0, mood: 0,
    consecutiveLosses: 0, relations: {}, stats: { hands: 50 }
  };
  if (over) for (var k2 in over) if (Object.prototype.hasOwnProperty.call(over, k2)) s[k2] = over[k2];
  return s;
}
function opp(vpip, fcr) {
  return { id: 'x', name: 'x', hands: 40, vpip: vpip, pfr: 0.1, threeBet: 3, steal: 4, cBetFaced: 10, foldToCBet: Math.round(fcr * 10), showdowns: 8 };
}
function stealCtx(id, hole, opponents) {
  return {
    seat: seatOf(id, hole),
    playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 },
    table: {
      board: [], pot: 45, currentBet: 0, minRaise: 20, bigBlind: 20, street: 'preflop',
      numOpponents: opponents.length, aggressorId: null, raiseCount: 0, positionFactor: 0.85,
      stealOpportunity: true, stealAttempt: false, opponents: opponents
    }
  };
}
function buildDeck() {
  var d = [];
  for (var r = 2; r <= 14; r++) for (var s = 0; s < 4; s++) d.push(card(r, s));
  return d;
}
var DECK = buildDeck();
function holePool(n, seed) {
  var r = mulberry(seed);
  var out = [];
  for (var i = 0; i < n; i++) {
    var a = Math.floor(r() * 52), b = Math.floor(r() * 52);
    while (b === a) b = Math.floor(r() * 52);
    out.push([DECK[a], DECK[b]]);
  }
  return out;
}
function stealRate(id, holes, opponents, seed) {
  var savedRandom = Math.random;
  Math.random = mulberry(seed);
  var n = 0;
  try {
    for (var i = 0; i < holes.length; i++) {
      var d = Brain.decide(stealCtx(id, holes[i], opponents));
      if (d.action === 'raise' || d.action === 'allin') n++;
    }
  } finally { Math.random = savedRandom; }
  return n / holes.length;
}
var N = 4000;
var holes = holePool(N, 20240101);
var tightOpp = [opp(0.10, 0.80), opp(0.14, 0.70), opp(0.16, 0.60)];
var looseOpp = [opp(0.62, 0.20), opp(0.55, 0.25), opp(0.58, 0.15)];
var bossTight = stealRate('boss', holes, tightOpp, 777);
var bossLoose = stealRate('boss', holes, looseOpp, 777);
log('  boss 偷盲率：紧桌 ' + (bossTight * 100).toFixed(1) + '% vs 松桌 ' + (bossLoose * 100).toFixed(1) + '%');
ok(bossTight - bossLoose > 0.10, 'boss 对紧桌偷盲显著多于对松桌（差 ' + ((bossTight - bossLoose) * 100).toFixed(1) + 'pp）');
var solTight = stealRate('solver', holes, tightOpp, 888);
var solLoose = stealRate('solver', holes, looseOpp, 888);
log('  solver 偷盲率：紧桌 ' + (solTight * 100).toFixed(1) + '% vs 松桌 ' + (solLoose * 100).toFixed(1) + '%');
ok(Math.abs(solTight - solLoose) < 0.05, 'solver（adaptivity 0.45）不消费历史 → 紧/松桌偷盲率无差异（差 ' + ((solTight - solLoose) * 100).toFixed(1) + 'pp）');

// ===================== C. Boss 读历史 → 翻后诈唬频率（样本守卫） =====================
log('== C Boss 翻后诈唬：fcrHigh 对手多诈 / 低样本不读 ==');
function postCtx(id, hole, opponents, over) {
  var s = seatOf(id, hole);
  if (over) for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) s[k] = over[k];
  return {
    seat: s,
    playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 },
    table: {
      board: [card(11, 0), card(8, 1), card(3, 2)], pot: 300, currentBet: 0, minRaise: 20, bigBlind: 20,
      street: 'flop', numOpponents: 2, aggressorId: id, raiseCount: 0, positionFactor: 0.6,
      stealOpportunity: false, stealAttempt: false, opponents: opponents
    }
  };
}
function fireRate(id, opponents, seed) {
  var savedRandom = Math.random;
  Math.random = mulberry(seed);
  var holes = holePool(3000, seed + 5);
  var n = 0, tot = 0;
  try {
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      // 跳过任何成对/更强手牌（仅保留空气/听牌场景，隔离诈唬频率调整）
      var dr = global.Poker.Equity.detectDraw(h, [card(11, 0), card(8, 1), card(3, 2)]);
      if ((dr.madeRank || 0) >= 1) continue;
      tot++;
      var d = Brain.decide(postCtx(id, h, opponents));
      if (d.action === 'raise' || d.action === 'allin') n++;
    }
  } finally { Math.random = savedRandom; }
  return tot ? n / tot : 0;
}
var fcrHighOpp = [opp(0.10, 0.85), opp(0.30, 0.7)];
var fcrLowOpp = [opp(0.62, 0.2), opp(0.4, 0.2)];
var bossHigh = fireRate('boss', fcrHighOpp, 999);
var bossLow = fireRate('boss', fcrLowOpp, 999);
log('  boss 翻后无注开火率：fcr高 ' + (bossHigh * 100).toFixed(1) + '% vs 松/低弃 ' + (bossLow * 100).toFixed(1) + '%');
ok(bossHigh > bossLow + 0.05, 'boss 面对高弃牌率对手开火更多（差 ' + ((bossHigh - bossLow) * 100).toFixed(1) + 'pp）');
// 样本守卫：cBetFaced<3 不读 fcr → 与无历史无差异
var lowSampleOpp = [{ id: 'y', name: 'y', hands: 40, vpip: 0.12, pfr: 0.1, threeBet: 1, steal: 1, cBetFaced: 1, foldToCBet: 1, showdowns: 2 }];
var bossSample = fireRate('boss', lowSampleOpp, 1234);
var bossNone = fireRate('boss', [], 1234);
log('  boss 开火率：低样本(1次cBet) ' + (bossSample * 100).toFixed(1) + '% vs 无对手 ' + (bossNone * 100).toFixed(1) + '%');
ok(Math.abs(bossSample - bossNone) < 0.05, 'cBetFaced<3 样本不足时不读 fcr（差 ' + ((bossSample - bossNone) * 100).toFixed(1) + 'pp）');

fs.writeFileSync(path.join(__dirname, '_learn_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL === 0 ? 0 : 1);
