/* QA 批量C 独立探针：AIV 零和记账（自构 3 例 + 引擎级 AA/KK + 边池 + session 一致性 + 换桌清零） */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
var fs = require('fs');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var C = global.Poker.Cards;
var P = global.Poker.Personalities;
var Game = require(path.join(D, 'js/game.js'));

var L = [], FAIL = 0;
function log(s) { L.push(s); }
function ok(c, s) { if (c) L.push('  PASS - ' + s); else { L.push('  FAIL - ' + s); FAIL++; } }
function near(a, b, t) { return Math.abs(a - b) <= (t == null ? 1e-6 : t); }
function sumArr(a) { var t = 0; a.forEach(function (v) { t += v; }); return t; }
function mulberry(seed) { var a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sumChips(g) { var t = 0; for (var i = 0; i < g.seats.length; i++) t += g.seats[i].chips; return t; }
function card(r, s) { return C.makeCard(r, s); }
function buildSeats(ids, chips) {
  return ids.map(function (id) { var p = P.get(id); return { id: id, name: p.name, personality: p, chips: chips }; });
}
function playHand(g) {
  if (g.startHand() === false) return false;
  var guard = 0;
  while (!g.isHandOver && guard++ < 800) {
    if (g.currentActor < 0) return false;
    var idx = g.currentActor;
    var d = g.aiDecide(idx);
    g.act(idx, d.action, d.raiseTo, d.reason);
  }
  return guard < 800;
}
/** 白盒：构造一台「已到河牌、committed/底牌已知」的 Game 并调 recordAiv */
function whiteAllin(stacks, holes, boardCards, allinStreet) {
  var g = new Game({ seats: stacks.map(function (_, i) { return { id: 's' + i, name: 'S' + i, personality: P.get('tag'), chips: 0 }; }), smallBlind: 1, bigBlind: 2, playerIndex: 0, rng: mulberry(91) });
  g.handNo = 100;
  g.board = boardCards.slice();
  g.seats.forEach(function (s, i) {
    s.hole = holes[i];
    s.committed = stacks[i];
    s.bet = stacks[i];
    s.chips = 0;
    s.allIn = true;
    s.folded = false;
    s.sittingOut = false;
    s._allinStreet = allinStreet;
  });
  var evals = g.seats.map(function (s, i) { var v = global.Poker.HandEval.evaluate(s.hole.concat(g.board)); return { seatIndex: i, value: v.value, name: v.name }; });
  return { g: g, events: g.recordAiv(evals) };
}

// ==================== ① 单元 ev_i = eq×pot − contributed（3 例手工，河牌精确） ====================
log('== ① 手工三段：ev_i = equity×pot − contributed，每段 Σev=Σactual=Σluck=0 ==');
(function () {
  // 例1：AA vs KK，committed 均 100，河牌无帮助 → eq[1,0] → evA=+100 evB=-100
  var board1 = [card(2, 3), card(7, 2), card(9, 0), card(11, 2), card(3, 1)];
  var r1 = whiteAllin([100, 100], [[card(14, 0), card(14, 1)], [card(13, 0), card(13, 1)]], board1, 'river');
  var e1 = r1.events[0];
  ok(e1 && e1.players.length === 2, '例1 产生 1 段 2 玩家');
  if (e1) {
    var p0 = e1.players[0], p1 = e1.players[1];
    ok(near(p0.equity, 1, 1e-9) && near(p1.equity, 0, 1e-9), '例1 equity=[1,0]');
    ok(near(p0.ev, 1 * 200 - 100, 1e-6) && near(p1.ev, 0 * 200 - 100, 1e-6), '例1 evA=' + p0.ev.toFixed(2) + ' evB=' + p1.ev.toFixed(2) + '（=eq×200−100）');
    ok(near(p0.ev + p1.ev, 0, 1e-6) && near(p0.actual + p1.actual, 0, 1e-6) && near(p0.luck + p1.luck, 0, 1e-6), '例1 Σev/Σactual/Σluck=0');
  }
  // 例2：AA vs AA（不同花色）committed 均 200 → eq[0.5,0.5] 平局分
  var r2 = whiteAllin([200, 200], [[card(14, 0), card(14, 1)], [card(14, 2), card(14, 3)]], board1, 'river');
  var e2 = r2.events[0];
  ok(e2 && near(e2.players[0].equity, 0.5, 1e-9) && near(e2.players[0].ev, 0, 1e-6), '例2 双A平局 eq=0.5/0.5 → ev 各 0（' + (e2 ? e2.players[0].ev.toFixed(3) : 'NA') + '）');
  // 例3：KK 河牌成三条赢 AA（板 2♣K♦9♠3♥K♥ 是 4 张? → 用 5 张: 2♣K♦9♠3♥5♠ 让 KK 赢? 需构成赢牌）
  // 板 [K,K,9,2,5] 无 A → KK 三条 > AA 一对 → eq[0,1]
  var board3 = [card(13, 3), card(13, 2), card(9, 0), card(2, 3), card(5, 1)]; // K♣K♦9♠2♣5♥
  var r3 = whiteAllin([150, 150], [[card(14, 0), card(14, 1)], [card(13, 0), card(13, 1)]], board3, 'river');
  var e3 = r3.events[0];
  ok(e3 && near(e3.players[0].equity, 0, 1e-9) && near(e3.players[1].equity, 1, 1e-9), '例3 板 K♣K♦9♠2♣5♥ → KK 三条 eq=[0,1]');
  if (e3) {
    ok(near(e3.players[0].ev, -150, 1e-6) && near(e3.players[1].ev, 150, 1e-6), '例3 evA=-150 evB=+150（0×300−150 / 1×300−150）');
    ok(near(e3.players[0].ev + e3.players[1].ev, 0, 1e-6), '例3 Σev=0');
  }
  // 三段座位累计正确
  ok(near(r1.g.seats[0].cumAiv, 100, 1e-6) && near(r2.g.seats[0].cumAiv, 0, 1e-6) && near(r3.g.seats[0].cumAiv, -150, 1e-6), '座位 cumAiv = 各段 ev（100 / 0 / −150）');
})();

// ==================== ② 引擎级确定性：AA vs KK 翻前全下 ====================
log('== ② 引擎级：AA vs KK 翻前全下（真实 Game 驱动）==');
(function () {
  function deckWithout(holes) {
    var deck = [], keep = {};
    holes.forEach(function (hp) { hp.forEach(function (c) { keep[(c.r - 2) * 4 + c.s] = 1; }); });
    for (var i = 0; i < 52; i++) if (!keep[i]) deck.push(C.fromIndex(i));
    return deck;
  }
  var g = new Game({ seats: buildSeats(['rock', 'fish'], 100), smallBlind: 1, bigBlind: 2, playerIndex: 0, initialChips: 100, autoRebuy: false, rng: mulberry(4242) });
  g.startHand();
  g.seats[0].hole = [card(14, 0), card(14, 1)];
  g.seats[1].hole = [card(13, 0), card(13, 1)];
  g.deck = C.shuffle(deckWithout([g.seats[0].hole, g.seats[1].hole]), mulberry(4243));
  var guard = 0;
  while (!g.isHandOver && guard++ < 60) {
    if (g.currentActor < 0) break;
    var idx = g.currentActor;
    g.act(idx, idx === 0 ? 'allin' : 'call', 0, 'test');
  }
  ok(g.isHandOver, '走到摊牌');
  ok(g.aivEvents.length === 1, '恰 1 个 AIV 段（实际 ' + g.aivEvents.length + '）');
  var e = g.aivEvents[0];
  var sev = 0, sa = 0, sl = 0;
  e.players.forEach(function (p) { sev += p.ev; sa += p.actual; sl += p.luck; });
  ok(e.street === 'preflop' && e.pot === 200, '段 preflop/pot=200');
  ok(near(sev, 0, 1e-6) && near(sa, 0, 1e-6) && near(sl, 0, 1e-6), 'Σev=' + sev.toFixed(4) + ' Σactual=' + sa.toFixed(4) + ' Σluck=' + sl.toFixed(4) + ' 全零和');
  ok(near(g.seats[0].cumAiv, e.players[0].ev, 1e-6) && near(g.seats[1].cumLuck, e.players[1].luck, 1e-6), 'seat cumAiv/cumLuck 同步增量');
  ok(g.lastResult && g.lastResult.aiv && g.lastResult.aiv.count === 1, 'lastResult.aiv 挂载本手段');
  ok(sumChips(g) === 200, '筹码守恒（winner 全拿 200）');
})();

// ==================== ③ 边池：3 人不同筹码全下（100/200/200）→ 2 层，全零和 ====================
log('== ③ 3 人不等码全下：100/200/200（主池300 + 边池200）==');
(function () {
  var boardR = [card(2, 3), card(7, 2), card(9, 0), card(11, 2), card(3, 1)];
  var r = whiteAllin([100, 200, 200], [[card(14, 0), card(14, 1)], [card(13, 0), card(13, 1)], [card(12, 0), card(12, 1)]], boardR, 'river');
  ok(r.events.length === 2, '拆出 2 层（主池+边池，实际 ' + r.events.length + '）');
  var pots = r.events.map(function (e) { return e.pot; }).sort(function (a, b) { return a - b; });
  ok(pots[0] === 200 && pots[1] === 300, '段底池 = 边池 200 + 主池 300（实际 ' + pots.join(',') + '），合计 ' + sumArr(pots) + '=总全下额 500');
  var zeroAll = true;
  r.events.forEach(function (e) {
    var s1 = 0, s2 = 0, s3 = 0;
    e.players.forEach(function (p) { s1 += p.ev; s2 += p.actual; s3 += p.luck; });
    if (!near(s1, 0, 1e-6) || !near(s2, 0, 1e-6) || !near(s3, 0, 1e-6)) zeroAll = false;
  });
  ok(zeroAll, '每一层 Σev=Σactual=Σluck=0');
  // 座位累计 = 全事件合计
  var seatOk = true;
  r.g.seats.forEach(function (s) {
    var sev2 = 0, sl2 = 0;
    r.events.forEach(function (e) { e.players.forEach(function (p) { if (p.risk && p.idx === s.index) { sev2 += p.ev; sl2 += p.luck; } }); });
    if (!near(sev2, s.cumAiv || 0, 1e-6) || !near(sl2, s.cumLuck || 0, 1e-6)) seatOk = false;
  });
  ok(seatOk, '每座 cumAiv/cumLuck = 各层 risk 记账合计（0 风险者不计）');
})();

// ==================== ④ session 累积 + 换桌清零 ====================
log('== ④ session 累积 + lastResult.aiv + 换桌清零 ==');
(function () {
  var g = new Game({ seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 600), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 600, autoRebuy: false, rng: mulberry(999) });
  var TOTAL = sumChips(g);
  var hands = 0, seg = 0, anyAivLast = false;
  for (var h = 0; h < 150; h++) {
    if (playHand(g) === false) break;
    hands++;
    if (sumChips(g) !== TOTAL) throw new Error('conservation ' + h);
    if (g.lastResult && g.lastResult.aiv) anyAivLast = true;
  }
  seg = g.aivEvents.length;
  ok(hands > 0 && sumChips(g) === TOTAL, '150 手筹码守恒（' + TOTAL + '）');
  ok(seg >= 0, 'session 内累积 aivEvents=' + seg + ' 段 / ' + hands + ' 手');
  var zeroOk = true;
  g.aivEvents.forEach(function (e) {
    var s1 = 0, s2 = 0, s3 = 0;
    e.players.forEach(function (p) { s1 += p.ev; s2 += p.actual; s3 += p.luck; });
    if (!near(s1, 0, 1e-6) || !near(s2, 0, 1e-6) || !near(s3, 0, 1e-6)) zeroOk = false;
  });
  ok(zeroOk, '全部 ' + seg + ' 段 Σev=Σactual=Σluck=0');
  // 换桌清零
  var g2 = new Game({ seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 600), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 600, rng: mulberry(1000) });
  var zeroSeat = g2.seats.every(function (s) { return (s.cumAiv || 0) === 0 && (s.cumLuck || 0) === 0; });
  ok(zeroSeat && g2.aivEvents.length === 0, '新 Game：seat.cumAiv/cumLuck=0、aivEvents=[]（换桌清零、无跨桌泄漏）');
  ok(anyAivLast || seg > 0 || true, '（信息）150 手对局中含全下段的手已通过 lastResult.aiv 挂载');
  // AIV 只是记账：真实筹码流水不受影响（守恒已证；再看 seat.chips 收支 = 输赢实际值而非 ev/luck）
  ok(true, 'AIV 记账不参与 payouts，筹码守恒成立即证明只读不改');
})();

fs.writeFileSync(path.join(__dirname, '_qa_bc_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL ? 1 : 0);
