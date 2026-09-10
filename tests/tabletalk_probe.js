/* 端到端验证：牌桌对话（tableTalk）事件是否在真实对局中触发 + 各类 kind 分布 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var P = global.Poker.Personalities;
var Game = require(path.join(D, 'js/game.js'));
function mulberry(seed) { var a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

var g = new Game({
  seats: ['fish', 'rock', 'tag', 'lag', 'solver', 'boss'].map(function (id) {
    var p = P.get(id);
    return { id: id, name: p.name, isHuman: false, personality: p, chips: 20000 };
  }),
  smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000, autoRebuy: false, rng: mulberry(2026)
});

var kinds = { rival: 0, bluff: 0, steal: 0, happy: 0, tilt: 0, other: 0, total: 0 };
var sampleTexts = [];
var handsPlayed = 0, decisions = 0, talkDecisions = 0;
for (var h = 0; h < 400; h++) {
  if (g.startHand() === false) break;
  handsPlayed++;
  var guard = 0;
  while (!g.isHandOver && guard++ < 1000) {
    if (g.currentActor < 0) break;
    var idx = g.currentActor;
    var d = g.aiDecide(idx);
    decisions++;
    if (d && d.talk) talkDecisions++;
    g.act(idx, d.action, d.raiseTo, d.reason);
  }
  var evs = g.drainEvents();
  for (var i = 0; i < evs.length; i++) {
    var e = evs[i];
    if (e.type === 'tableTalk') {
      kinds.total++;
      if (kinds[e.kind] != null) kinds[e.kind]++; else kinds.other++;
      if (sampleTexts.length < 12) sampleTexts.push('[' + (e.kind || '?') + '] ' + e.name + '：' + e.text);
    }
  }
}
console.log('诊断: handsPlayed=' + handsPlayed + ' decisions=' + decisions + ' 决策含talk=' + talkDecisions);
console.log('=== 牌桌对话事件统计（400 手模拟）===');
console.log('总事件数: ' + kinds.total);
console.log('rival(记仇): ' + kinds.rival + '  bluff(诈唬): ' + kinds.bluff + '  steal(偷盲): ' + kinds.steal + '  happy(上头得意): ' + kinds.happy + '  tilt(崩盘上头): ' + kinds.tilt + '  other: ' + kinds.other);
console.log('--- 抽样台词 ---');
sampleTexts.forEach(function (s) { console.log('  ' + s); });
console.log(kinds.total > 0 ? 'PASS - tableTalk 事件已正常触发' : 'FAIL - 无 tableTalk 事件');
