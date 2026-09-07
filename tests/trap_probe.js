/* B3 慢打陷阱线 探针：tricky 型跟注慢打、次街收网大注、防呆（短码/湿面/每手一次） */
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
function card(r, s) { return C.makeCard(r, s); }
function sumChips(g) { var t = 0; for (var i = 0; i < g.seats.length; i++) t += g.seats[i].chips; return t; }
function buildSeats(ids, chips) {
  return ids.map(function (id) { var p = P.get(id); return { id: id, name: p.name, isHuman: false, personality: p, chips: chips }; });
}

// 两对：hole J♦8♠ + board J♠8♥3♦（干面） / hole J♦T♠ + board J♥T♥9♥（湿面，连通同花威胁）
var BOARD_DRY = [card(11, 0), card(8, 1), card(3, 2)];
var BOARD_WET = [card(11, 1), card(10, 1), card(9, 1)];
var HOLE_2PAIR = [card(11, 2), card(8, 0)];
var HOLE_WET_2PAIR = [card(11, 2), card(10, 0)];

function seatOf(id, over) {
  var base = P.get(id);
  var p2 = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p2[k] = base[k];
  var s = { id: id, name: base.name, personality: p2, hole: HOLE_2PAIR, chips: 3000, bet: 0, mood: 0, consecutiveLosses: 0, relations: {}, stats: { hands: 50 }, _trap: false, _trapDone: false };
  if (over) for (var k2 in over) if (Object.prototype.hasOwnProperty.call(over, k2)) s[k2] = over[k2];
  return s;
}
function trapCtx(id, board, pot, currentBet, chips, hole) {
  return {
    seat: seatOf(id, { chips: chips != null ? chips : 3000, hole: hole || HOLE_2PAIR }),
    playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 },
    table: {
      board: board, pot: pot, currentBet: currentBet, minRaise: 20, bigBlind: 20, street: 'flop',
      numOpponents: 2, aggressorId: 'x', raiseCount: 1, positionFactor: 0.6,
      stealOpportunity: false, stealAttempt: false, opponents: []
    }
  };
}
function trapRate(id, board, n, seed, chips, hole) {
  var savedRandom = Math.random;
  var c = 0;
  try {
    for (var i = 0; i < n; i++) {
      Math.random = mulberry(seed + i);
      var d = Brain.decide(trapCtx(id, board, 600, 200, chips, hole));
      if (d.action === 'call' && d.reason.indexOf('慢打') >= 0) c++;
    }
  } finally { Math.random = savedRandom; }
  return c / n;
}

// ===================== A. tricky 型会慢打，rock/fish 不会 =====================
log('== A 慢打触发频率（干面两对面对下注，N=900）==');
var N = 900;
var bossTrap = trapRate('boss', BOARD_DRY, N, 5101);
var tagTrap = trapRate('tag', BOARD_DRY, N, 5102);
var rockTrap = trapRate('rock', BOARD_DRY, N, 5103);
var fishTrap = trapRate('fish', BOARD_DRY, N, 5104);
log('  boss=' + (bossTrap * 100).toFixed(1) + '% tag=' + (tagTrap * 100).toFixed(1) + '% rock=' + (rockTrap * 100).toFixed(1) + '% fish=' + (fishTrap * 100).toFixed(1) + '%');
ok(bossTrap > 0.08, 'boss（tricky 0.38）有明显慢打率（' + (bossTrap * 100).toFixed(1) + '%）');
ok(tagTrap > 0.02, 'tag（tricky 0.18）有慢打率（' + (tagTrap * 100).toFixed(1) + '%）');
ok(bossTrap > tagTrap, 'boss 慢打率高于 tag（' + (bossTrap * 100).toFixed(1) + '% > ' + (tagTrap * 100).toFixed(1) + '%）');
ok(rockTrap === 0 && fishTrap === 0, 'rock（tricky 0.10）/fish（0.03）低于 0.15 阈值 → 永不慢打');

// ===================== B. 次街收网：大注收价值 =====================
log('== B 陷阱收网（上一街慢打 → 无人下注 → 打 0.8×pot）==');
(function () {
  var seat = seatOf('boss', { _trap: true, _trapDone: true });
  var ctx = {
    seat: seat,
    playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 },
    table: {
      board: BOARD_DRY, pot: 1000, currentBet: 0, minRaise: 20, bigBlind: 20, street: 'turn',
      numOpponents: 2, aggressorId: seat.id, raiseCount: 0, positionFactor: 0.6,
      stealOpportunity: false, stealAttempt: false, opponents: []
    }
  };
  var d = Brain.decide(ctx);
  var minExpected = Math.round((1000 + 0) * 0.7);
  log('  action=' + d.action + ' raiseTo=' + d.raiseTo + '（0.8×pot=800） ' + d.reason);
  ok((d.action === 'raise' || d.action === 'allin') && d.raiseTo >= minExpected, '收网下注 ≥ 0.7×pot（' + d.raiseTo + ' ≥ ' + minExpected + '）');
  ok(d.reason.indexOf('陷阱收网') >= 0, '收网理由标注「陷阱收网」');
})();

// ===================== C. 防呆：短码不慢打 / 湿面概率减半 / 每手一次 =====================
log('== C 防呆 ==');
var shortTrap = trapRate('boss', BOARD_DRY, 900, 5201, 200);   // chips=200，后手 <0.6×pot
ok(shortTrap === 0, '短码（后手<0.6×pot）不慢打（' + (shortTrap * 100).toFixed(1) + '%）');
var wetTrap = trapRate('boss', BOARD_WET, 1200, 5301, 3000, HOLE_WET_2PAIR);
log('  boss 干面=' + (bossTrap * 100).toFixed(1) + '% vs 湿面(J♥T♥9♥)=' + (wetTrap * 100).toFixed(1) + '%');
ok(wetTrap > 0.01 && wetTrap < bossTrap * 0.85, '湿面慢打概率减半（' + (wetTrap * 100).toFixed(1) + '% < ' + (bossTrap * 100).toFixed(1) + '%×0.85）');
(function () {
  // 每手至多一次：_trapDone=true 后同街再面对下注不再触发新陷阱
  var seat = seatOf('boss', { _trap: false, _trapDone: true });
  var ctx = {
    seat: seat,
    playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 },
    table: {
      board: BOARD_DRY, pot: 600, currentBet: 200, minRaise: 20, bigBlind: 20, street: 'flop',
      numOpponents: 2, aggressorId: 'x', raiseCount: 1, positionFactor: 0.6,
      stealOpportunity: false, stealAttempt: false, opponents: []
    }
  };
  var hits = 0;
  var savedRandom = Math.random;
  try {
    for (var i = 0; i < 1200; i++) {
      Math.random = mulberry(5401 + i);
      var fresh = seatOf('boss', { _trap: false, _trapDone: true });
      ctx.seat = fresh;
      var d = Brain.decide(ctx);
      if (d.action === 'call' && d.reason.indexOf('慢打') >= 0) hits++;
    }
  } finally { Math.random = savedRandom; }
  ok(hits === 0, '_trapDone 后同街不再设陷阱（1200 次命中 ' + hits + '）');
})();

// ===================== D. 引擎真实对局：慢打确实出现且不破坏守恒 =====================
log('== D 真实对局回归 ==');
(function () {
  var g = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 20000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, autoRebuy: false, rng: mulberry(777)
  });
  var TOTAL = sumChips(g);
  var slowLogs = 0, trapsNet = 0, hands = 0;
  for (var h = 0; h < 150; h++) {
    if (g.startHand() === false) break;
    hands++;
    var guard = 0;
    while (!g.isHandOver && guard++ < 800) {
      if (g.currentActor < 0) throw new Error('stuck');
      var idx = g.currentActor;
      var d = g.aiDecide(idx);
      if (d.reason && d.reason.indexOf('慢打') >= 0) slowLogs++;
      if (d.reason && d.reason.indexOf('陷阱收网') >= 0) trapsNet++;
      g.act(idx, d.action, d.raiseTo, d.reason);
    }
    if (sumChips(g) !== TOTAL) throw new Error('conservation broken hand ' + h);
  }
  log('  150 手：慢打跟注 ' + slowLogs + ' 次 / 收网 ' + trapsNet + ' 次');
  ok(sumChips(g) === TOTAL, '150 手自动对战筹码守恒');
})();

fs.writeFileSync(path.join(__dirname, '_trap_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL === 0 ? 0 : 1);
