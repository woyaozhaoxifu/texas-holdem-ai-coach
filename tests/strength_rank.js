/* global require, console, process */
/**
 * AI 难度梯度（赛制零和版）：
 * 每 session：6 人桌(目标AI + fish/rock/tag/lag/solver)，起始 2000，autoRebuy=false，
 * 打到有人出局或 40 手封顶。目标 AI 的筹码变化就是零和桌面的真实 EV。
 * 运行：node tests/strength_rank.js [session数]
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
var P = global.Poker.Personalities;

function runSessions(targetId, sessions) {
  var foes = ['fish', 'rock', 'tag', 'lag', 'solver'];
  var deltas = [], handsList = [], wins = 0;
  for (var k = 0; k < sessions; k++) {
    var seats = [{ id: targetId, name: P.get(targetId).name, isHuman: false, personality: P.get(targetId), chips: 2000 }];
    foes.forEach(function (fid) {
      var p = P.get(fid);
      seats.push({ id: fid, name: p.name, isHuman: false, personality: p, chips: 2000 });
    });
    var g = new global.Poker.Game({ seats: seats, smallBlind: 10, bigBlind: 20, playerIndex: 0, autoRebuy: false, initialChips: 2000 });
    var h = 0;
    while (h < 40) {
      var active = g.seats.filter(function (s) { return s.chips > 0 && !s.sittingOut; }).length;
      if (active <= 1) break;
      g.startHand();
      var guard = 0;
      while (!g.isHandOver && guard++ < 400) {
        if (g.currentActor < 0) { g.isHandOver = false; break; }
        var idx = g.currentActor;
        var d = g.aiDecide(idx);
        g.act(idx, d.action, d.raiseTo, d.reason);
      }
      g.isHandOver = false;
      h++;
      // 玩家出局直接中止本 session
      if (g.seats[0].chips <= 0) break;
    }
    deltas.push(g.seats[0].chips - 2000);
    handsList.push(h);
    if (g.seats[0].chips > 0 && g.seats.every(function (s) { return s.chips <= 0 || s.sittingOut || s.id === targetId; })) wins++;
    var maxChip = Math.max.apply(null, g.seats.map(function (s) { return s.chips; }));
    if (g.seats[0].chips === maxChip && g.seats[0].chips > 0) wins++;
  }
  var avgDelta = deltas.reduce(function (a, b) { return a + b; }, 0) / sessions;
  var avgHands = handsList.reduce(function (a, b) { return a + b; }, 0) / sessions;
  return { avgDelta: +avgDelta.toFixed(1), per100: +(avgDelta / avgHands * 100).toFixed(1), bb100: +(avgDelta / avgHands / 20 * 100).toFixed(1), winRate: +(wins / sessions * 100).toFixed(0), avgHands: +avgHands.toFixed(0) };
}

var SESSIONS = parseInt(process.argv[2] || '100', 10);
var order = ['boss', 'solver', 'lag', 'tag', 'rock', 'fish'];
console.log('难度梯度（赛制零和，' + SESSIONS + ' session/AI，首破出局或≤40手封顶）');
console.log(['AI'.padEnd(6), 'session均盈亏', '净赢/百手', 'BB/百手', '夺冠率%'].join('\t'));
var rows = [];
order.forEach(function (id) {
  var r = runSessions(id, SESSIONS);
  rows.push({ id: id, r: r });
  console.log([id.padEnd(6), String(r.avgDelta).padStart(9), String(r.per100).padStart(8), String(r.bb100).padStart(8), String(r.winRate).padStart(6)].join('\t'));
});
rows.sort(function (a, b) { return b.r.per100 - a.r.per100; });
console.log('排名: ' + rows.map(function (x) { return x.id + '(' + x.r.bb100 + ')'; }).join(' > '));
