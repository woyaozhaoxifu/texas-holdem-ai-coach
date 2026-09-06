/* global require, console, process */
/**
 * Node 冒烟测试：全 AI 自动对战，验证引擎健壮性与 AI 人格差异。
 * 运行：node tests/sim.js
 */
'use strict';

var path = require('path');
var D = path.join(__dirname, '..');
require(path.join(D, 'js/cards.js'));
require(path.join(D, 'js/handEval.js'));
require(path.join(D, 'js/equity.js'));
require(path.join(D, 'js/ai/personalities.js'));
require(path.join(D, 'js/ai/brain.js'));
var Game = require(path.join(D, 'js/game.js'));

function buildSeats(ids) {
  var P = global.Poker.Personalities;
  var seats = [{ id: 'you', name: '你', isHuman: false, personality: P.get('tag'), chips: 2000 }];
  ids.forEach(function (id) {
    var p = P.get(id);
    seats.push({ id: id, name: p.name, isHuman: false, personality: p, chips: 2000 });
  });
  return seats;
}

function playHands(ids, n, opts) {
  opts = opts || {};
  var g = new global.Poker.Game({
    seats: buildSeats(ids),
    smallBlind: 10, bigBlind: 20, playerIndex: 0,
    autoRebuy: opts.autoRebuy !== false,
    initialChips: 2000
  });
  var totalBefore = g.seats.reduce(function (a, s) { return a + s.chips; }, 0);
  var vpip = {}, pfr = {}, raises = {}, calls = {}, folds = {}, hands = {}, wins = {};
  var steals = {}, moods = {}, moodSeen = {};
  var guardMax = 400;

  for (var h = 0; h < n; h++) {
    g.startHand();
    for (var i = 0; i < g.seats.length; i++) { if (!g.seats[i].sittingOut) g.seats[i].stats.hands++; }
    var guard = 0;
    while (!g.isHandOver && guard++ < guardMax) {
      if (g.currentActor < 0) { g.isHandOver = false; break; }
      var idx = g.currentActor;
      var before = g.seats.map(function (s) { return s.chips; });
      var d = g.aiDecide(idx);
      var legal = g.legalActions(idx);
      // 合法性校验
      if (d.action === 'raise' && d.raiseTo > legal.maxTo) {
        throw new Error('非法加注: ' + g.seats[idx].name + ' raiseTo=' + d.raiseTo + ' max=' + legal.maxTo);
      }
      if ((d.action === 'raise' || d.action === 'allin') && legal.maxTo > g.currentBet && d.raiseTo < legal.minRaiseTo && d.raiseTo < legal.maxTo) {
        throw new Error('加注额低于最小加注: ' + g.seats[idx].name + ' ' + d.raiseTo + ' < ' + legal.minRaiseTo);
      }
      var streetBefore = g.street;
      g.act(idx, d.action, d.raiseTo, d.reason);
      // 统计
      var s = g.seats[idx];
      hands[s.id] = (hands[s.id] || 0);
      if (streetBefore === 'preflop') {
        if (d.action === 'call' || d.action === 'raise' || d.action === 'allin') vpip[s.id] = (vpip[s.id] || 0) + 1;
        if (d.action === 'raise' || d.action === 'allin') pfr[s.id] = (pfr[s.id] || 0) + 1;
      }
      if (d.action === 'raise' || d.action === 'allin') raises[s.id] = (raises[s.id] || 0) + 1;
      if (/偷/.test(d.reason || '')) steals[s.id] = (steals[s.id] || 0) + 1;
      moods[s.id] = (moods[s.id] || 0) + (s.mood || 0);
      moodSeen[s.id] = (moodSeen[s.id] || 0) + 1;
      if (d.action === 'call') calls[s.id] = (calls[s.id] || 0) + 1;
      if (d.action === 'fold') folds[s.id] = (folds[s.id] || 0) + 1;
      var after = g.seats.map(function (x) { return x.chips; });
      // 筹码不能为负
      for (var k = 0; k < after.length; k++) if (after[k] < 0) throw new Error('筹码为负: ' + g.seats[k].name);
      before = after;
    }
    if (guard >= guardMax) throw new Error('第 ' + (h + 1) + ' 手疑似死循环');
    g.isHandOver = false;
    var res = g.lastResult;
    if (res && res.winners) {
      res.winners.forEach(function (w) { wins[w.name] = (wins[w.name] || 0) + 1; });
    }
  }

  var totalAfter = g.seats.reduce(function (a, s) { return a + s.chips; }, 0);
  return { g: g, totalBefore: totalBefore, totalAfter: totalAfter, vpip: vpip, pfr: pfr, raises: raises, calls: calls, folds: folds, wins: wins, steals: steals, moods: moods, moodSeen: moodSeen, relations: g.seats.map(function (s) { return s.relations; }) };
}

// ---- 1. 手牌评估正确性 ----
var HE = global.Poker.HandEval;
var C = global.Poker.Cards;
function hand(ranks, suits) {
  return ranks.map(function (r, i) { return C.makeCard(r, suits[i]); });
}
var cases = [
  { name: '皇家同花顺', cards: hand([14, 13, 12, 11, 10], [0, 0, 0, 0, 0]), rank: 9 },
  { name: '同花顺', cards: hand([9, 8, 7, 6, 5], [1, 1, 1, 1, 1]), rank: 8 },
  { name: '四条', cards: hand([9, 9, 9, 9, 2], [0, 1, 2, 3, 1]), rank: 7 },
  { name: '葫芦', cards: hand([9, 9, 9, 2, 2], [0, 1, 2, 3, 1]), rank: 6 },
  { name: '同花', cards: hand([14, 10, 7, 4, 2], [2, 2, 2, 2, 2]), rank: 5 },
  { name: '顺子', cards: hand([9, 8, 7, 6, 5], [0, 1, 2, 3, 1]), rank: 4 },
  { name: '轮子A2345', cards: hand([14, 2, 3, 4, 5], [0, 1, 2, 3, 1]), rank: 4 },
  { name: '三条', cards: hand([9, 9, 9, 4, 2], [0, 1, 2, 3, 1]), rank: 3 },
  { name: '两对', cards: hand([9, 9, 4, 4, 2], [0, 1, 2, 3, 1]), rank: 2 },
  { name: '一对', cards: hand([9, 9, 7, 4, 2], [0, 1, 2, 3, 1]), rank: 1 },
  { name: '高牌', cards: hand([14, 10, 7, 4, 2], [0, 1, 2, 3, 0]), rank: 0 }
];
var pass = 0, fail = 0;
cases.forEach(function (c) {
  var ev = HE.evaluate(c.cards);
  if (ev.rank === c.rank) { pass++; } else { fail++; console.log('  [FAIL] ' + c.name + ' 期望rank=' + c.rank + ' 实际=' + ev.rank + '(' + HE.describe(ev) + ')'); }
});
console.log('手牌评估: ' + pass + ' 通过 / ' + fail + ' 失败');

// 牌型大小序
var orderOK = HE.evaluate(cases[1].cards).value < HE.evaluate(cases[0].cards).value &&
  HE.evaluate(cases[2].cards).value > HE.evaluate(cases[3].cards).value;
console.log('牌型大小序: ' + (orderOK ? 'OK' : 'FAIL'));

// ---- 2. 筹码守恒（关闭自动补筹，纯闭环）----
var ids = ['fish', 'rock', 'tag', 'lag', 'solver'];
var rConserve = playHands(ids, 150, { autoRebuy: false });
console.log('\n筹码守恒(150手,无补筹): ' + rConserve.totalBefore + ' -> ' + rConserve.totalAfter + '  ' +
  (rConserve.totalBefore === rConserve.totalAfter ? 'OK' : 'FAIL 差 ' + (rConserve.totalAfter - rConserve.totalBefore)));

// ---- 3. 全 AI 自动对战（开启补筹，观察长期行为）----
var N = 300;
var t0 = Date.now();
var r = playHands(ids, N, { autoRebuy: true });
var ms = Date.now() - t0;
console.log('\n自动对战 ' + N + ' 手，耗时 ' + ms + 'ms（' + Math.round(ms / N) + 'ms/手）');

console.log('\n各 AI 行为统计（每 100 手）:');
console.log('  对手        VPIP   PFR   加注次数  偷鸡次数  跟注次数  弃牌次数  胜场  平均情绪');
ids.concat(['you']).forEach(function (id) {
  var name = id === 'you' ? '你(参照)' : global.Poker.Personalities.get(id).name;
  var v = ((r.vpip[id] || 0) / N * 100).toFixed(0);
  var p = ((r.pfr[id] || 0) / N * 100).toFixed(0);
  var avgMood = r.moodSeen[id] ? (r.moods[id] / r.moodSeen[id]).toFixed(1) : '0';
  console.log('  ' + pad(name, 10) + ' ' + pad(v + '%', 6) + ' ' + pad(p + '%', 6) + ' ' +
    pad(String(r.raises[id] || 0), 9) + ' ' + pad(String(r.steals[id] || 0), 9) + ' ' +
    pad(String(r.calls[id] || 0), 9) + ' ' +
    pad(String(r.folds[id] || 0), 9) + ' ' + pad(String(r.wins[name] || 0), 5) + '  ' + avgMood);
});
function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// ---- 3. 人格差异断言 ----
console.log('\n对手关系（AI 之间的记仇/拿捏）:');
var g0 = r.g;
g0.seats.forEach(function (s, si) {
  if (!s.personality) return;
  var parts = [];
  Object.keys(s.relations).forEach(function (k) {
    var v = s.relations[k];
    if (Math.abs(v) >= 20) {
      var other = g0.seats.filter(function (x) { return x.id === k; })[0];
      parts.push((other ? other.name : k) + ' ' + (v > 0 ? '+' : '') + v + '(' + global.Poker.Game.relationWord(v) + ')');
    }
  });
  console.log('  ' + s.name + ' → ' + (parts.length ? parts.join('，') : '（无明显过节）'));
});

console.log('\n人格差异断言:');
var vp = function (id) { return (r.vpip[id] || 0) / N; };
var aggr = function (id) { return (r.raises[id] || 0) / N; };
var checks = [
  ['Fish 入池率应显著高于 Rock', vp('fish') > vp('rock') + 0.3],
  ['Rock 入池率应低于 30%', vp('rock') < 0.30],
  ['LAG 加注频率应高于 TAG', aggr('lag') > aggr('tag')],
  ['LAG 加注频率应高于 Fish 数倍', aggr('lag') > aggr('fish') * 2],
  ['TAG 入池率应在 Rock 与 LAG 之间', vp('tag') > vp('rock') && vp('tag') < vp('lag')]
];
var ok = true;
checks.forEach(function (c) {
  console.log('  ' + (c[1] ? 'PASS' : 'FAIL') + ' — ' + c[0]);
  if (!c[1]) ok = false;
});
var conserveOK = rConserve.totalBefore === rConserve.totalAfter;
console.log('  筹码守恒: ' + (conserveOK ? 'PASS' : 'FAIL'));

console.log('\n结果: ' + ((fail === 0 && conserveOK && ok) ? '全部通过' : '存在问题'));
process.exit((fail === 0 && conserveOK && ok) ? 0 : 1);
