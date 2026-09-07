/* 短码推推乐验证 v3：6 座全人格 + autoRebuy(对手无限深) + 每次 rock 行动前钉住总深度(含已下注)
 * 只统计 rock 的【翻前】决策，观察进入推推乐区间(≤pushBB=16BB)后 fold/allin 行为是否转变。
 * 用法: node tests/pushfold_probe.js
 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
require(path.join(D, 'js/cards.js'));
require(path.join(D, 'js/handEval.js'));
require(path.join(D, 'js/equity.js'));
require(path.join(D, 'js/ai/personalities.js'));
require(path.join(D, 'js/ai/brain.js'));
require(path.join(D, 'js/game.js'));
var P = global.Poker.Personalities;
var Game = global.Poker.Game;

function run(rockTotal, hands) {
  var ids = ['rock', 'tag', 'lag', 'solver', 'boss', 'fish'];
  var seats = ids.map(function (id) {
    var p = P.get(id);
    return { id: id, name: p.name, isHuman: false, personality: p, chips: 20000 };
  });
  var g = new Game({ seats: seats, smallBlind: 20, bigBlind: 40, playerIndex: 0,
    autoRebuy: true, initialChips: 20000, match: null });
  var rock = g.seats[0];
  var st = { pf: 0, allin: 0, fold: 0, call: 0, raise: 0, check: 0 };
  for (var h = 0; h < hands; h++) {
    if (!g.startHand()) break;
    rock.relations = {}; rock.consecutiveLosses = 0; rock.mood = 0; rock.tilt = 0;
    var guard = 0;
    while (!g.isHandOver && guard++ < 1000) {
      if (g.currentActor < 0) break;
      var idx = g.currentActor;
      if (idx === 0) {
        // 钉住 rock 总投入(已下注+剩余) = rockTotal；不足时按能给的给
        var committed = rock.bet || 0;
        rock.chips = Math.max(0, rockTotal - committed);
      }
      if (g.street !== 'preflop') { // 非翻前直接走完，不统计
        var d0 = g.aiDecide(idx);
        g.act(idx, d0.action, d0.raiseTo, d0.reason);
        continue;
      }
      if (idx === 0) {
        st.pf++;
        var d = g.aiDecide(idx);
        var a = d.action;
        if (a === 'allin') st.allin++;
        else if (a === 'call' && (d.amount || 0) >= rock.chips - 0.5) st.allin++; // 跟注即全下
        else st[a] = (st[a] || 0) + 1;
        g.act(idx, d.action, d.raiseTo, d.reason);
      } else {
        var d2 = g.aiDecide(idx);
        g.act(idx, d2.action, d2.raiseTo, d2.reason);
      }
    }
    g.isHandOver = false;
    if (g.pendingRoundEnd) g.pendingRoundEnd = false; // 非比赛模式轮次标记不适用，防御
  }
  return st;
}

[[1000, '25BB(深码对照)'], [320, '8BB'], [200, '5BB'], [120, '3BB']].forEach(function (cfg) {
  var s = run(cfg[0], 700);
  var pf = s.pf || 1;
  var pct = function (k) { return Math.round((s[k] || 0) / pf * 100); };
  console.log('rock @' + cfg[1] + '  翻前决策 ' + s.pf + ' 次 → ' +
    'fold ' + pct('fold') + '% | allin ' + pct('allin') + '% | call ' + pct('call') + '% | ' +
    'raise ' + pct('raise') + '% | check ' + pct('check') + '%');
});
