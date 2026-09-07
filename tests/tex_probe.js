/* global require, console, process */
/**
 * tests/tex_probe.js —— 牌面纹理 + 动态下注尺度 探针
 * 运行：node tests/tex_probe.js
 *
 * 覆盖：
 *  ① boardTexture 确定性单测：干/湿/成对/顺子威胁/空牌面
 *  ② 集成：同一人格同一空气底牌，干面 c-bet 率 > 湿面 c-bet 率（大样本，容差收敛）
 *  ③ 动态尺度：合法区间（≥minRaise、≤全下）在所有加注上成立
 *  ④ 极化超池：solver 在「湿面 + 强牌」时 ~25% 打 >1×pot 超池
 */
'use strict';

var path = require('path');
var D = path.join(__dirname, '..');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var C = global.Poker.Cards;
var EQ = global.Poker.Equity;
var P = global.Poker.Personalities;
var Brain = global.Poker.Brain;

var FAILED = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS — ' + msg);
  else { console.log('  FAIL — ' + msg); FAILED++; }
}

function card(r, s) { return C.makeCard(r, s); }

// ---------- ① boardTexture 单测 ----------
console.log('== ① boardTexture 确定性单测 ==');
(function () {
  // A♣7♦2♥：彩虹无连无对 → 干
  var dryB = EQ.boardTexture([card(14, 3), card(7, 2), card(2, 1)]);
  ok(dryB.wet === 0 && dryB.label === '干', 'A♣7♦2♥ 彩虹 → 干');
  ok(dryB.flush === false && dryB.straight === false && dryB.paired === false, '干面无花/顺/对');
  // J♠T♠9♠：三同花 + 三连 → 湿 + flush threat + straight threat
  var wetB = EQ.boardTexture([card(11, 0), card(10, 0), card(9, 0)]);
  ok(wetB.wet === 2 && wetB.label === '湿', 'J♠T♠9♠ → 湿');
  ok(wetB.flush === 'threat', 'J♠T♠9♠ flush=threat（恰 3 同花）');
  ok(wetB.straight === 'threat', 'J♠T♠9♠ straight=threat');
  // K♦K♣8♥：成对 → 中（wet=1）
  var pairB = EQ.boardTexture([card(13, 2), card(13, 3), card(8, 1)]);
  ok(pairB.wet === 1 && pairB.label === '中' && pairB.paired === true, 'K♦K♣8♥ → 成对、中等');
  // Q♥J♦T♣：彩虹三连 → straight threat、湿
  var strB = EQ.boardTexture([card(12, 1), card(11, 2), card(10, 3)]);
  ok(strB.straight === 'threat' && strB.flush === false, 'Q♥J♦T♣ → 顺子威胁、无花威胁');
  ok(strB.wet === 2 && strB.label === '湿', 'Q♥J♦T♣ → 湿');
  // 空 board → 中性
  var emptyB = EQ.boardTexture([]);
  ok(emptyB.wet === 1 && emptyB.label === '中', '空公共牌 → 中性');
  ok(emptyB.flush === false && emptyB.straight === false && emptyB.paired === false, '空牌面无任何威胁标记');
})();

// ---------- 合成决策上下文 ----------
function seatOf(id, hole, chips, over) {
  var base = P.get(id);
  var pers = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) pers[k] = base[k];
  if (over) for (var ok2 in over) if (Object.prototype.hasOwnProperty.call(over, ok2)) pers[ok2] = over[ok2];
  return {
    id: id, name: base.name, personality: pers, hole: hole, chips: chips, bet: 0,
    mood: 0, consecutiveLosses: 0, relations: {}, stats: {}
  };
}
function ctxFor(seat, board, opts) {
  opts = opts || {};
  return {
    seat: seat,
    playerModel: { hands: 10, vpip: 0.30, foldToBet: 0.35, aggression: 0.2 },
    table: {
      board: board,
      pot: opts.pot != null ? opts.pot : 120,
      currentBet: opts.currentBet || 0,
      minRaise: 20, bigBlind: 20,
      street: opts.street || 'flop',
      numOpponents: opts.numOpponents != null ? opts.numOpponents : 2,
      aggressorId: opts.aggressorId != null ? opts.aggressorId : seat.id,
      raiseCount: opts.raiseCount || 0,
      positionFactor: opts.positionFactor || 0.6,
      stealOpportunity: false, stealAttempt: false
    }
  };
}
function isBet(d) { return d.action === 'raise' || d.action === 'allin'; }
function legalRaise(d, seat, pot) {
  // 当前测试场景 currentBet=0，minRaise=20；全下上限 = seat.chips + seat.bet
  if (!isBet(d)) return true;
  if (d.raiseTo < 20) return false;
  if (d.raiseTo > (seat.chips + seat.bet)) return false;
  return true;
}

// ---------- ② 干面 vs 湿面 c-bet 率（TAG，同一空气底牌）----------
console.log('== ② 干面 vs 湿面 c-bet 率（TAG 空气牌，大样本）==');
(function () {
  var hole = [card(3, 1), card(2, 2)];                       // 3♥2♦：纯空气，不连牌面
  var dryBoard = [card(14, 0), card(13, 1), card(9, 2)];     // A♠K♥9♦ 彩虹干面
  var wetBoard = [card(8, 0), card(7, 0), card(6, 0)];       // 8♠7♠6♠ 湿面（听花/顺双威胁）
  var N = 5000, i, d, seatD, seatW, cD = 0, cW = 0, legalBad = 0;
  for (i = 0; i < N; i++) {
    seatD = seatOf('tag', hole, 5000, { equitySamples: 150 });
    d = Brain.decide(ctxFor(seatD, dryBoard));
    if (isBet(d)) cD++;
    if (!legalRaise(d, seatD)) legalBad++;
  }
  for (i = 0; i < N; i++) {
    seatW = seatOf('tag', hole, 5000, { equitySamples: 150 });
    d = Brain.decide(ctxFor(seatW, wetBoard));
    if (isBet(d)) cW++;
    if (!legalRaise(d, seatW)) legalBad++;
  }
  var rD = cD / N, rW = cW / N;
  console.log('    c-bet 率：干面 ' + (rD * 100).toFixed(1) + '% vs 湿面 ' + (rW * 100).toFixed(1) + '%');
  ok(rD > rW, '干面 c-bet 率 > 湿面 c-bet 率（容差收敛）');
  ok(legalBad === 0, '全部加注落在合法区间（≥minRaise、≤全下）');
})();

// ---------- ④ 极化超池：solver 湿面强牌 ~25% 超池 ----------
console.log('== ④ 极化超池（solver · 湿面 · 强牌）==');
(function () {
  var hole = [card(14, 0), card(10, 0)];           // A♠T♠
  var board = [card(13, 0), card(12, 0), card(11, 0)];  // K♠Q♠J♠：皇家成牌 + 湿面
  var N = 3000, over = 0, total = 0, i, d, seat;
  for (i = 0; i < N; i++) {
    seat = seatOf('solver', hole, 5000, { equitySamples: 120 });
    d = Brain.decide(ctxFor(seat, board, { pot: 300 }));
    if (!isBet(d)) continue;                        // 只统计价值下注样本
    total++;
    if (!legalRaise(d, seat)) { ok(false, '超池样本出界 raiseTo=' + d.raiseTo); FAILED++; break; }
    if (d.raiseTo > 300) over++;                    // pot=300 → >1×pot 视为超池
  }
  var rate = total ? over / total : 0;
  console.log('    价值下注 ' + total + ' 次，超池 ' + over + ' 次，占比 ' + (rate * 100).toFixed(1) + '%');
  ok(total > 1000, '拿到足够价值下注样本（total>1000）');
  ok(rate > 0.16 && rate < 0.36, '超池占比落在 25%±容差内（实际 ' + (rate * 100).toFixed(1) + '%）');
})();

// ---------- ③ 跨人格随机局面：加注合法性 ----------
console.log('== ③ 跨人格随机局面：加注合法区间 ==');
(function () {
  var persIds = ['fish', 'rock', 'tag', 'lag', 'solver', 'boss'];
  var N = 150, i, j, d, seat, bad = 0, betCount = 0;
  for (i = 0; i < N; i++) {
    var deck = C.shuffle(C.buildDeck());
    var hole = [deck.pop(), deck.pop()];
    var board = [deck.pop(), deck.pop(), deck.pop()];
    var pot = 40 + Math.floor(Math.random() * 400);
    var currentBet = Math.random() < 0.5 ? 0 : Math.round(pot * (0.3 + Math.random() * 0.4));
    // currentBet 随机 <= pot 保证场景不荒谬
    if (currentBet > pot) currentBet = pot;
    for (j = 0; j < persIds.length; j++) {
      seat = seatOf(persIds[j], hole, 2000 + Math.floor(Math.random() * 3000));
      d = Brain.decide(ctxFor(seat, board, { pot: pot, currentBet: currentBet, positionFactor: Math.random(), numOpponents: 1 + Math.floor(Math.random() * 4) }));
      if (isBet(d)) {
        betCount++;
        var minTo = currentBet + 20;
        var maxTo = seat.chips + seat.bet;
        if (d.raiseTo < minTo && d.raiseTo < maxTo) { bad++; }
        if (d.raiseTo > maxTo) { bad++; }
        if (d.action === 'allin' && d.raiseTo !== maxTo) { bad++; }
      }
    }
  }
  console.log('    加注/全下样本 ' + betCount + ' 个');
  ok(bad === 0, '随机局面下所有加注/全下均合法（≥minRaise、≤全下）');
})();

console.log('\n结果: ' + (FAILED === 0 ? '全部通过' : FAILED + ' 项失败'));
process.exit(FAILED === 0 ? 0 : 1);
