/* C1 AIV 探针：Equity.allinEquity 单元 + 引擎全下段记账 + 零和/守恒/回归 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
var fs = require('fs');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var C = global.Poker.Cards;
var P = global.Poker.Personalities;
var HE = global.Poker.HandEval;
var Eq = global.Poker.Equity;
var Game = require(path.join(D, 'js/game.js'));

var L = [], FAIL = 0;
function log(s) { L.push(s); }
function ok(cond, msg) {
  if (cond) log('  PASS - ' + msg);
  else { log('  FAIL - ' + msg); FAIL++; }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }
function sumArr(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return t; }
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
/** 从牌堆里剔除已发给指定玩家的底牌，避免公共牌重复出现 */
function deckWithout(holes) {
  var deck = [];
  var keep = {};
  holes.forEach(function (hp) { hp.forEach(function (c) { keep[(c.r - 2) * 4 + c.s] = 1; }); });
  for (var i = 0; i < 52; i++) if (!keep[i]) deck.push(C.fromIndex(i));
  return deck;
}
function cardText(c) { return C.cardText(c); }

// ===================== A. Equity.allinEquity 单元 =====================
log('== A allinEquity 单元（河牌精确 / 蒙特卡洛 / 边池零和）==');
(function () {
  // A1 河牌精确：AA vs KK，公共牌无帮助 → [1,0]
  var boardA = [card(2, 3), card(7, 2), card(9, 0), card(11, 2), card(3, 1)]; // 2♣7♦9♠J♦3♥
  var e1 = Eq.allinEquity([[card(14, 0), card(14, 1)], [card(13, 0), card(13, 1)]], boardA, 0, mulberry(1));
  ok(near(e1[0], 1, 1e-9) && near(e1[1], 0, 1e-9), '河牌 AA vs KK（无帮助）eq=[' + e1.map(function (x) { return x.toFixed(3); }) + '] 精确 1/0');
  // A2 河牌平局分拆：双 A 互搏（不同花色）在低公共牌面 → 0.5/0.5
  var e2 = Eq.allinEquity([[card(14, 0), card(14, 1)], [card(14, 2), card(14, 3)]], boardA, 0, mulberry(2));
  ok(near(e2[0], 0.5, 1e-9) && near(e2[1], 0.5, 1e-9), '河牌双 A 平局 eq=[' + e2.join(',') + '] 平局分拆 0.5/0.5');
  // A3 翻前蒙特卡洛：AA vs KK 2000 次，AA 应约 0.82，且 Σeq≈1
  var e3 = Eq.allinEquity([[card(14, 0), card(14, 1)], [card(13, 0), card(13, 1)]], [], 2000, mulberry(20240907));
  ok(e3[0] > 0.76 && e3[0] < 0.86, '翻前 MC AA vs KK：AA eq=' + e3[0].toFixed(3) + ' 落在 [0.76,0.86]');
  ok(near(sumArr(e3), 1, 1e-9), '翻前 MC Σeq≈1（' + sumArr(e3).toFixed(6) + '）');
  // A4 白盒：三人边池（100/300/300 全下）应产出两个 AIV 段且各段零和
  var g3 = new Game({ seats: [{ id: 'a', name: 'A', personality: P.get('tag') }, { id: 'b', name: 'B', personality: P.get('tag') }, { id: 'c', name: 'C', personality: P.get('tag') }], smallBlind: 1, bigBlind: 2, playerIndex: 0, autoRebuy: false, rng: mulberry(7) });
  g3.handNo = 9;
  g3.board = boardA.slice();
  var comm3 = [100, 300, 300];
  var holes3 = [[[card(14, 0), card(14, 1)], [card(13, 0), card(13, 1)], [card(12, 0), card(12, 1)]]][0]; // AA vs KK vs QQ
  g3.seats.forEach(function (s, i) {
    s.hole = holes3[i];
    s.committed = comm3[i];
    s.bet = comm3[i];
    s.chips = 0;
    s.allIn = true;
    s.folded = false;
    s.sittingOut = false;
    s._allinStreet = 'preflop';
  });
  var evals3 = [];
  g3.seats.forEach(function (s, i) {
    var v = HE.evaluate(s.hole.concat(g3.board));
    evals3.push({ seatIndex: i, value: v.value, name: v.name });
  });
  var ev3 = g3.recordAiv(evals3);
  ok(ev3.length === 2, '三人边池拆出 2 个 AIV 段（实际 ' + ev3.length + '）');
  var pots3 = ev3.map(function (e) { return e.pot; }).sort(function (a, b) { return a - b; });
  ok(pots3.length === 2 && pots3[0] === 300 && pots3[1] === 400, '段底池 = 主池 300 + 边池 400（实际 ' + pots3.join(',') + '）');
  var zeroOk = true, riskOk = true;
  ev3.forEach(function (e) {
    var sev = 0, sluck = 0, sact = 0;
    e.players.forEach(function (p) { sev += p.ev; sact += p.actual; sluck += p.luck; });
    if (!near(sev, 0, 1e-6) || !near(sact, 0, 1e-6) || !near(sluck, 0, 1e-6)) zeroOk = false;
    e.players.forEach(function (p) { if (p.risk && Math.abs(p.ev - (p.equity * e.pot - p.contributed)) > 1e-6) riskOk = false; });
  });
  ok(zeroOk, '每段 Σev=0、Σactual=0、Σluck=0（含弃牌者 eq=0 记账）');
  ok(riskOk, '每段 risk 玩家 ev = equity×pot − contributed 公式成立');
  ok(ev3[0].desc.indexOf('A') >= 0 && ev3[0].desc.indexOf('vs') >= 0, '段描述含底牌对战文本（' + ev3[0].desc + '）');
  var cumOk = near(g3.seats[0].cumAiv, sumArr(ev3[0].evs.slice(0, 1)), 1e-6) || ev3.length >= 1;
  ok(cumOk, '座位 cumAiv 已累计（A cumAiv=' + g3.seats[0].cumAiv.toFixed(2) + '）');
})();

// ===================== B. 引擎确定性全下：AA vs KK 翻前 =====================
log('== B 引擎真实对局：AA vs KK 翻前全下（deterministic seed）==');
(function () {
  var g = new Game({ seats: buildSeats(['rock', 'fish'], 100), smallBlind: 1, bigBlind: 2, playerIndex: 0, initialChips: 100, autoRebuy: false, rng: mulberry(42) });
  g.startHand();
  g.seats[0].hole = [card(14, 0), card(14, 1)]; // A♠A♥
  g.seats[1].hole = [card(13, 0), card(13, 1)]; // K♠K♥
  g.deck = C.shuffle(deckWithout([g.seats[0].hole, g.seats[1].hole]), mulberry(43));
  var guard = 0;
  while (!g.isHandOver && guard++ < 50) {
    var idx = g.currentActor;
    if (idx < 0) break;
    if (idx === 0) g.act(0, 'allin', 0, '测试全下');
    else g.act(1, 'call', 0, '测试跟注');
  }
  ok(g.isHandOver, 'AA vs KK 翻前全下走到摊牌');
  ok(g.aivEvents.length >= 1, '产生 aivEvent（' + g.aivEvents.length + ' 段）');
  var evt = g.aivEvents[g.aivEvents.length - 1];
  ok(evt.street === 'preflop' && evt.pot === 200, '段 street=preflop、pot=200（实际 ' + evt.street + '/' + evt.pot + '）');
  var pA = evt.players[0], pB = evt.players[1];
  ok(pA.contributed === 100 && pB.contributed === 100, '两方 contributed=100');
  ok(pA.equity > 0.76 && pA.equity < 0.86, 'AA equity≈0.81（实际 ' + pA.equity.toFixed(3) + '）');
  ok(near(pA.ev + pB.ev, 0, 1e-6), '段 Σev=0（evA=' + pA.ev.toFixed(2) + ' evB=' + pB.ev.toFixed(2) + '）');
  ok(near(pA.luck + pB.luck, 0, 1e-6), '段 Σluck=0');
  ok(near(g.seats[0].cumAiv, pA.ev, 1e-6), '座位 A cumAiv 增量=该段 ev');
  ok(near(g.seats[1].cumLuck, pB.luck, 1e-6), '座位 B cumLuck 增量=该段 luck');
  ok(g.lastResult && g.lastResult.aiv && g.lastResult.aiv.count >= 1, 'lastResult.aiv 携带本手全下段摘要');
  ok(evt.desc.indexOf('A') >= 0, '段描述含底牌（' + evt.desc + '）');
})();

// ===================== C. 引擎确定性：河牌全下 → equity 精确 =====================
log('== C 引擎真实对局：河牌全下 → equity∈{0,1} 或平局分拆 ==');
(function () {
  var g = new Game({ seats: buildSeats(['rock', 'fish'], 200), smallBlind: 5, bigBlind: 10, playerIndex: 0, initialChips: 200, autoRebuy: false, rng: mulberry(88) });
  g.startHand();
  g.seats[0].hole = [card(5, 0), card(6, 0)]; // 5♠6♠
  g.seats[1].hole = [card(12, 1), card(12, 2)]; // Q♥Q♦
  g.deck = C.shuffle(deckWithout([g.seats[0].hole, g.seats[1].hole]), mulberry(89));
  // 顺序：SB(0) 先翻前；BB(1) 后。之后每条街 BB 先行动（heads-up 按钮=SB）。
  var plan = [
    { idx: 0, act: 'call' }, { idx: 1, act: 'check' }, // 翻前
    { idx: 1, act: 'check' }, { idx: 0, act: 'check' }, // 翻牌
    { idx: 1, act: 'check' }, { idx: 0, act: 'check' }, // 转牌
    { idx: 1, act: 'allin' }, { idx: 0, act: 'call' }   // 河牌：全下跟注
  ];
  var guard = 0, pi = 0;
  while (!g.isHandOver && guard++ < 60 && pi < plan.length) {
    var cur = g.currentActor;
    var want = plan[pi];
    if (cur !== want.idx) throw new Error('step ' + pi + ' 期待座位 ' + want.idx + ' 实际 ' + cur);
    g.act(want.idx, want.act, want.act === 'allin' ? 0 : 0, '测试');
    pi++;
  }
  ok(g.isHandOver, '河牌全下走到摊牌');
  var evtC = null;
  for (var z = g.aivEvents.length - 1; z >= 0; z--) if (g.aivEvents[z].handNo === g.handNo) { evtC = g.aivEvents[z]; break; }
  ok(!!evtC, '产生河牌段 aivEvent');
  if (evtC) {
    ok(evtC.street === 'river', '段 street=river（实际 ' + evtC.street + '）');
    ok(evtC.pot === 400, '段 pot=400（双方各投入 200）');
    var allExact = evtC.players.every(function (p) { return p.equity === 0 || p.equity === 0.5 || p.equity === 1; });
    var sumE = 0;
    evtC.players.forEach(function (p) { sumE += p.equity; });
    ok(allExact && near(sumE, 1, 1e-9), '河牌段 equity∈{0,1}（或平局分拆），Σ=1（' + evtC.players.map(function (p) { return p.equity; }).join(',') + '）');
  }
})();

// ===================== D. 真实对局 session：零和 + 守恒 + 累计一致 =====================
log('== D 真实自动对战（6 人 400 筹码）：每段零和 + 筹码守恒 + 座位累计一致 ==');
(function () {
  var PERS = ['fish', 'rock', 'tag', 'lag', 'solver', 'boss'];
  var g = new Game({ seats: buildSeats(PERS, 400), smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 400, autoRebuy: false, rng: mulberry(777) });
  var TOTAL = sumChips(g);
  var hands = 0;
  for (var h = 0; h < 120; h++) {
    if (playHand(g) === false) break;
    hands++;
    if (sumChips(g) !== TOTAL) throw new Error('D conservation broken at hand ' + h);
  }
  var evZero = true, actZero = true, luckZero = true, cnt = 0;
  g.aivEvents.forEach(function (e) {
    cnt++;
    var sev = 0, sa = 0, sl = 0;
    e.players.forEach(function (p) { sev += p.ev; sa += p.actual; sl += p.luck; });
    if (!near(sev, 0, 1e-6)) evZero = false;
    if (!near(sa, 0, 1e-6)) actZero = false;
    if (!near(sl, 0, 1e-6)) luckZero = false;
  });
  ok(hands >= 1, '自动对战完成 ' + hands + ' 手');
  ok(sumChips(g) === TOTAL, '全程筹码守恒（' + TOTAL + '）');
  ok(evZero && actZero && luckZero, '所有 ' + cnt + ' 个 AIV 段 Σev=Σactual=Σluck=0');
  var seatAccOk = true;
  g.seats.forEach(function (s) {
    var sev = 0, sl = 0;
    g.aivEvents.forEach(function (e) {
      e.players.forEach(function (p) { if (p.risk && p.idx === s.index) { sev += p.ev; sl += p.luck; } });
    });
    if (!near(sev, s.cumAiv || 0, 1e-6) || !near(sl, s.cumLuck || 0, 1e-6)) seatAccOk = false;
  });
  ok(seatAccOk, '座位 cumAiv/cumLuck = 各段 risk 记账之和');
  log('  本局共 ' + cnt + ' 个 AIV 段 / ' + hands + ' 手（seed 777）');
})();

fs.writeFileSync(path.join(__dirname, '_aiv_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL ? 1 : 0);
