/* stage_fold_probe: 比赛全程分阶段统计弃牌节奏
   用法: node tests/stage_fold_probe.js [--post]    --post 输出对照行
   统计: 按在场人数分桶的 每手入池(非翻牌前弃牌)人数 / 分人格近似VPIP / <=3人局连续弃牌序列 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
require(path.join(D, 'js/cards.js'));
require(path.join(D, 'js/handEval.js'));
require(path.join(D, 'js/equity.js'));
require(path.join(D, 'js/icm.js'));
require(path.join(D, 'js/ai/personalities.js'));
require(path.join(D, 'js/ai/brain.js'));
var Game = require(path.join(D, 'js/game.js'));
var P = global.Poker.Personalities;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

var POST = process.argv.indexOf('--post') >= 0;
var TAG = POST ? 'POST ' : 'PRE  ';

var ids = ['boss', 'solver', 'lag', 'tag', 'rock', 'fish'];
var START = 4000;
var blindLevels = [];
(function () {
  var sb = 10;
  for (var i = 0; i < 14; i++) {
    blindLevels.push({ sb: sb, bb: sb * 2 });
    if (i < 3) sb = sb * 1.5;
    else if (i < 6) sb = Math.round(sb * 1.6 / 5) * 5;
    else sb = Math.round(sb * 1.75 / 10) * 10;
  }
})();

function buildSeats() {
  return ids.map(function (id) {
    var p = P.get(id);
    return { id: id, name: p.name, avatar: p.avatar, isHuman: false, personality: p, chips: START };
  });
}

function newGame(seed) {
  return new Game({
    seats: buildSeats(), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: START,
    rng: mulberry32(seed),
    match: { enabled: true, roundHands: 10, blindLevels: blindLevels, payouts: [0.5, 0.3, 0.2] }
  });
}

function playHand(g) {
  if (g.startHand() === false) return 'blocked';
  var guard = 0;
  while (!g.isHandOver && guard++ < 800) {
    if (g.currentActor < 0) { g.isHandOver = true; break; }
    var d = g.aiDecide(g.currentActor);
    g.act(g.currentActor, d.action, d.raiseTo || 0, d.reason || '');
  }
  if (guard >= 800) throw new Error('死循环 hand ' + g.handNo);
  return 'ok';
}

function runOnce(seed) {
  var g = newGame(seed);
  var agg = {};
  var vpip = {}; ids.forEach(function (i) { vpip[i] = { dealt: 0, enter: 0 }; });
  var seqAll = {}; ids.forEach(function (i) { seqAll[i] = []; });
  var handsByAlive = {}; [2, 3, 4, 5, 6].forEach(function (k) { handsByAlive[k] = 0; });
  var totalHands = 0, ev, guardMax = 2000;
  while (!g.match.over && totalHands < guardMax) {
    var r = playHand(g);
    if (r === 'blocked') { g.drainEvents(); if (g.startNextRound) g.startNextRound(); continue; }
    var alive = g.seats.filter(function (s) { return !g.match.eliminated[s.index] && s.chips > 0; });
    var n = alive.length;
    var foldedSeats = {};
    (g.handLog || []).forEach(function (l) {
      if (l.street === 'preflop' && l.action === 'fold' && !g.match.eliminated[l.seatIndex]) foldedSeats[l.seatIndex] = 1;
    });
    if (n >= 2) {
      agg[n] = agg[n] || { hands: 0, dealt: 0, enter: 0 };
      agg[n].hands++; totalHands++;
      alive.forEach(function (s) {
        vpip[s.id].dealt++;
        if (!foldedSeats[s.index]) vpip[s.id].enter++;
      });
      agg[n].dealt += alive.length;
      agg[n].enter += alive.length - Object.keys(foldedSeats).length;
      handsByAlive[n]++;
      if (n <= 3) {
        alive.forEach(function (s) { seqAll[s.id].push(foldedSeats[s.index] ? 1 : 0); });
      }
    }
    ev = g.drainEvents();
    if (ev && ev.roundEnd && g.startNextRound) g.startNextRound();
    if (ev && ev.matchEnd) break;
  }
  var longest = {}; ids.forEach(function (i) { longest[i] = 0; });
  ids.forEach(function (i) {
    var run = 0;
    seqAll[i].forEach(function (v) { if (v === 1) { run++; if (run > longest[i]) longest[i] = run; } else run = 0; });
  });
  var out = { tag: TAG + seed, hands: totalHands, handsByAlive: handsByAlive, buckets: {}, vpip: {}, longest: {} };
  Object.keys(agg).forEach(function (k) {
    out.buckets[k] = { h: agg[k].hands, enterPer: +(agg[k].enter / agg[k].hands).toFixed(2),
      foldRate: +(1 - agg[k].enter / agg[k].dealt).toFixed(2) };
  });
  ids.forEach(function (i) { out.vpip[i] = vpip[i].dealt ? +(vpip[i].enter / vpip[i].dealt).toFixed(3) : -1; });
  ids.forEach(function (i) { out.longest[i] = longest[i]; });
  return out;
}

var SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 101];
var sums = { hands: 0, handsByAlive: {}, buckets: {}, vpip: {}, longest: {} };
ids.forEach(function (i) { sums.vpip[i] = 0; sums.longest[i] = 0; });
[2, 3, 4, 5, 6].forEach(function (k) { sums.handsByAlive[k] = 0; sums.buckets[k] = { hands: 0, enter: 0 }; });
SEEDS.forEach(function (seed) {
  var o = runOnce(seed);
  sums.hands += o.hands;
  [2, 3, 4, 5, 6].forEach(function (k) {
    sums.handsByAlive[k] += o.handsByAlive[k] || 0;
    var b = o.buckets[k];
    if (b) { sums.buckets[k].hands += b.h; sums.buckets[k].enter += b.enterPer * b.h; }
  });
  ids.forEach(function (i) { sums.vpip[i] += o.vpip[i]; if (o.longest[i] > sums.longest[i]) sums.longest[i] = o.longest[i]; });
});
var N = SEEDS.length;
console.log(TAG + '============================');
console.log(TAG + '平均总手数 ~ ' + Math.round(sums.hands / N));
[6, 5, 4, 3, 2].forEach(function (k) {
  var b = sums.buckets[k];
  var ep = b && b.hands ? (b.enter / b.hands).toFixed(2) : '-';
  var ff = b && b.hands ? (1 - b.enter / (b.hands * k + 0.0001)).toFixed(2) : '-';
  console.log(TAG + '在场' + k + '人: 手数=' + Math.round(sums.handsByAlive[k] / N) + '  每手入池=' + ep + '人  翻前弃牌率≈' + ff);
});
console.log(TAG + '—— 近似VPIP(参与手/发牌手) ——');
ids.forEach(function (i) { console.log(TAG + '  ' + i + '  ' + (sums.vpip[i] / N).toFixed(3)); });
console.log(TAG + '—— <=3人局 最长连续弃牌(>=6 属过紧) ——');
ids.forEach(function (i) { console.log(TAG + '  ' + i + '  ' + (sums.longest[i] || 0) + ' 手'); });
