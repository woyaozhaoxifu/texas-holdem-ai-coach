/* global require, console, process */
/**
 * 情绪影响量化探针：强制固定某个 AI 的 mood，跑大量牌局，统计行为差异。
 * 运行：node tests/mood_probe.js
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

function run(targetId, moodVal, hands) {
  var ids = ['tag', 'rock', 'fish', 'lag', 'solver'];
  if (ids.indexOf(targetId) < 0) ids[0] = targetId;
  var seats = [{ id: 'you', name: '你', isHuman: false, personality: P.get('tag'), chips: 2000 }];
  ids.forEach(function (id) {
    var p = P.get(id);
    seats.push({ id: id, name: p.name, isHuman: false, personality: p, chips: 2000 });
  });
  // 目标座位 = 第 2 个（index 1）
  seats[1] = { id: targetId, name: P.get(targetId).name, isHuman: false, personality: P.get(targetId), chips: 2000 };

  var g = new global.Poker.Game({
    seats: seats, smallBlind: 10, bigBlind: 20, playerIndex: 0,
    autoRebuy: true, initialChips: 2000
  });
  var target = g.seats[1];

  var st = { vpip: 0, pfr: 0, raises: 0, calls: 0, folds: 0, steals: 0, postCalls: 0, postFolds: 0, hands: 0, checks: 0 };

  for (var h = 0; h < hands; h++) {
    g.startHand();
    target.relations = {};              // 排除「记仇/拿捏」干扰，只测情绪
    target.consecutiveLosses = 0;
    st.hands++;
    var guard = 0;
    while (!g.isHandOver && guard++ < 400) {
      if (g.currentActor < 0) { g.isHandOver = false; break; }
      var idx = g.currentActor;
      if (idx === 1) g.seats[idx].mood = moodVal;   // 每次决策前钉死心境
      var streetBefore = g.street;
      var d = g.aiDecide(idx);
      g.act(idx, d.action, d.raiseTo, d.reason);
      if (idx !== 1) continue;
      if (streetBefore === 'preflop') {
        if (d.action === 'call' || d.action === 'raise' || d.action === 'allin') st.vpip++;
        if (d.action === 'raise' || d.action === 'allin') st.pfr++;
      } else {
        if (d.action === 'call') st.postCalls++;
        if (d.action === 'fold') st.postFolds++;
      }
      if (d.action === 'raise' || d.action === 'allin') st.raises++;
      if (d.action === 'check') st.checks++;
      if (d.action === 'call') st.calls++;
      if (d.action === 'fold') st.folds++;
      if (/偷/.test(d.reason || '')) st.steals++;
    }
    g.isHandOver = false;
  }

  var post = st.postCalls + st.postFolds;
  return {
    id: targetId,
    mood: moodVal,
    vpip: +(st.vpip / st.hands * 100).toFixed(1),
    pfr: +(st.pfr / st.hands * 100).toFixed(1),
    raisesPerHand: +(st.raises / st.hands).toFixed(2),
    postCallRate: post ? +(st.postCalls / post * 100).toFixed(1) : 0,
    stealsPer100: +(st.steals / st.hands * 100).toFixed(1)
  };
}

var targets = process.argv[2] ? [process.argv[2]] : ['lag', 'rock', 'fish'];
var moods = [-100, -60, -20, 0, 20, 60, 100];
var HANDS = parseInt(process.argv[3] || '120', 10);

targets.forEach(function (tid) {
  var p = P.get(tid);
  console.log('\n===== ' + p.avatar + ' ' + p.name + '（moodVolatility=' + p.moodVolatility + '，' + HANDS + ' 手/档）=====');
  console.log(['mood'.padStart(5), 'VPIP%', 'PFR%', '加注/手', '翻后跟注率%', '偷鸡/百手'].join('\t'));
  var rows = [];
  moods.forEach(function (m) {
    var r = run(tid, m, HANDS);
    rows.push(r);
    console.log([String(m).padStart(5), String(r.vpip).padStart(5), String(r.pfr).padStart(5),
      String(r.raisesPerHand).padStart(6), String(r.postCallRate).padStart(10), String(r.stealsPer100).padStart(8)].join('\t'));
  });
  var base = rows.filter(function (r) { return r.mood === 0; })[0];
  console.log('— 相对平静(mood=0)的变化 —');
  rows.forEach(function (r) {
    if (r.mood === 0) return;
    console.log('mood ' + String(r.mood).padStart(4) + ': VPIP ' +
      (r.vpip - base.vpip >= 0 ? '+' : '') + (r.vpip - base.vpip).toFixed(1) +
      'pt, 加注/手 ' + (r.raisesPerHand - base.raisesPerHand >= 0 ? '+' : '') + (r.raisesPerHand - base.raisesPerHand).toFixed(2) +
      ', 翻后跟注率 ' + (r.postCallRate - base.postCallRate >= 0 ? '+' : '') + (r.postCallRate - base.postCallRate).toFixed(1) + 'pt');
  });
});
