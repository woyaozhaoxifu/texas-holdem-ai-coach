/* QA 批量A 独立探针：Ante 引擎 / boardTexture 边界 / 下注尺度约束 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
var fs = require('fs');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var C = global.Poker.Cards;
var EQ = global.Poker.Equity;
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

// ===================== C. Ante 引擎 =====================
log('== C Ante（第6轮起）==');
(function () {
  var RAW = [
    { sb: 10, bb: 20 }, { sb: 15, bb: 30 }, { sb: 25, bb: 50 }, { sb: 40, bb: 80 },
    { sb: 60, bb: 120 }, { sb: 100, bb: 200 }, { sb: 150, bb: 300 }, { sb: 250, bb: 500 },
    { sb: 400, bb: 800 }, { sb: 600, bb: 1200 }];
  var EXPLICIT = RAW.map(function (lv, idx) {
    return { sb: lv.sb, bb: lv.bb, ante: idx >= 5 ? Math.ceil(lv.bb * 0.10 / 5) * 5 : 0 };
  });
  var g = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 2000000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 2000000, rng: mulberry(11),
    match: { enabled: true, roundHands: 1, blindLevels: RAW }
  });
  var TOTAL = 12000000;
  ok(sumChips(g) === TOTAL, '初始总筹码 ' + TOTAL);
  // 推进到第 6 轮（roundHands=1 每轮 1 手）
  for (var r = 1; r <= 5; r++) {
    if (r > 1) { if (g.startNextRound() !== true) throw new Error('startNextRound fail r=' + r); }
    ok(g.ante === 0, '第' + r + '轮 ante=0（低档无 Ante）');
    if (playHand(g) === false) throw new Error('play fail round ' + r);
    if (sumChips(g) !== TOTAL) throw new Error('低档守恒破坏 r=' + r);
  }
  ok(g.startNextRound() === true, '进入第 6 轮');
  ok(g.smallBlind === 100 && g.bigBlind === 200, '第6轮盲注 100/200');
  ok(g.ante === 20, '第6轮 ante=20（BB×10% 取整到5，实际 ' + g.ante + '）');
  // 检查显式 ante 表与自动归一化一致
  var gExpl = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 2000000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 2000000,
    match: { enabled: true, roundHands: 15, blindLevels: EXPLICIT }
  });
  ok(gExpl.ante === 0, '显式表第1轮 ante=0');
  var autoOk = true;
  for (var a = 0; a < 10; a++) {
    var expAnte = EXPLICIT[a].ante;
    // 用另一实例推进对比自动归一化：直接比较 norm 函数结果（构造后 ante 数组不可见，用轮次推进验证到第 6 轮已在上面）
  }
  // 第 6 轮开始一手，检查存活座 ante 缴交 / 淘汰座 0
  // 先淘汰 seat1（转移筹码到 donor 守恒）
  var victim = 1, donor = 2;
  g.seats[donor].chips += g.seats[victim].chips;
  ok(g.eliminateSeat(victim) === true, '强制淘汰 seat' + victim);
  ok(sumChips(g) === TOTAL, '淘汰后转移守恒');
  ok(g.startHand() !== false, '第6轮(淘汰后)开局成功');
  var liveN = 0;
  for (var i = 0; i < g.seats.length; i++) {
    if (g.seats[i].sittingOut) { ok(g.seats[i].committed === 0, '淘汰座 seat' + i + ' committed=0'); continue; }
    liveN++;
    ok(g.seats[i].committed >= 20, '存活座 seat' + i + ' committed≥ante(' + g.seats[i].committed + ')');
    if (g.seats[i].id !== '') { /* noop */ }
  }
  // SB/BB 座确认 bet=blind（非 ante）
  var sbSeat = null, bbSeat = null;
  for (var j = 0; j < g.seats.length; j++) {
    var s2 = g.seats[j];
    if (!s2.sittingOut && s2.bet === g.smallBlind && s2.committed >= g.ante + g.smallBlind) sbSeat = s2;
    if (!s2.sittingOut && s2.bet === g.bigBlind && s2.committed >= g.ante + g.bigBlind) bbSeat = s2;
  }
  ok(!!sbSeat && !!bbSeat, '找到 SB/BB 座（bet=盲注，ante 另计 committed）');
  var expectPot = liveN * 20 + 100 + 200;
  ok(g.potTotal() === expectPot, '底池=存活' + liveN + '×ante20 + SB100 + BB200 = ' + expectPot + '（实际 ' + g.potTotal() + '）');
  // ④ 非盲注座 bet=0：ante 不算当前下注
  var zeroBet = 0, checked = 0;
  for (var k = 0; k < g.seats.length; k++) {
    var s3 = g.seats[k];
    if (s3.sittingOut) continue;
    if (s3.bet === 0 && s3.committed >= 20) { zeroBet++; }
    checked++;
  }
  ok(zeroBet >= liveN - 2, '至少 ' + (liveN - 2) + ' 个非盲存活座 bet=0（ante 不算 bet，实际 ' + zeroBet + '）');
  // 打完本手 → 守恒
  var guard = 0;
  while (!g.isHandOver && guard++ < 800) {
    if (g.currentActor < 0) throw new Error('stuck ante hand');
    var idx = g.currentActor;
    var dd = g.aiDecide(idx);
    g.act(idx, dd.action, dd.raiseTo, dd.reason);
  }
  ok(guard < 800, '含 Ante 本手正常完成');
  ok(sumChips(g) === TOTAL, '第6轮(含Ante+淘汰)整手守恒');
  // 设计语义：handEnd 结算后 committed 保留（供 handEnd 事件携带 lastResult.pot），在下一手 startHand 才归零。
  // roundHands=1 时此刻 pendingRoundEnd=true → 先 startNextRound 进第7轮，再开局验证 committed 全新重置、无 ante/盲注残留。
  ok(g.startNextRound() === true, '进入第 7 轮');
  ok(g.smallBlind === 150 && g.bigBlind === 300 && g.ante === 30, '第7轮盲注 150/300 ante=30（第6轮结算后轮次推进）');
  var pre7 = sumChips(g);
  ok(g.startHand() !== false, '第7轮开局成功');
  var live7 = 0;
  for (var v = 0; v < g.seats.length; v++) if (!g.seats[v].sittingOut) live7++;
  var expectPot7 = live7 * 30 + 150 + 300;
  ok(g.potTotal() === expectPot7, '开局后 committed 全新重置（无残留），底池=' + live7 + '×30+150+300=' + expectPot7 + '（实际 ' + g.potTotal() + '）');
  var guard7 = 0;
  while (!g.isHandOver && guard7++ < 800) {
    if (g.currentActor < 0) throw new Error('stuck r7 hand');
    var i7 = g.currentActor;
    var d7 = g.aiDecide(i7);
    g.act(i7, d7.action, d7.raiseTo, d7.reason);
  }
  ok(guard7 < 800, '第7轮(ante30)本手正常完成');
  ok(sumChips(g) === TOTAL, '第7轮(ante30)整手结算回收后总筹码守恒(实际 chips=' + sumChips(g) + ')');
})();
// 练习模式无 ante
(function () {
  var gp = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver'], 1000).concat([{ id: 'you', name: '你', isHuman: false, personality: P.get('tag'), chips: 1000 }]),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 1000
  });
  ok(gp.ante === 0, '练习模式 g.ante=0');
  ok(gp.startHand() !== false, '练习开局成功');
  ok(gp.potTotal() === 30, '练习底池=SB+BB=30（实际 ' + gp.potTotal() + '）');
  var kinds = gp.drainEvents().map(function (e) { return e.type === 'post' ? (e.kind || '') : ''; }).filter(function (x) { return x; });
  ok(kinds.indexOf('ante') < 0, '练习模式无 ante post 事件');
})();

// ===================== D. boardTexture 边界 =====================
log('== D boardTexture 边界 ==');
(function () {
  function T(board) { return EQ.boardTexture(board); }
  function B(rs) { return rs.map(function (x) { return card(x[0], x[1]); }); }
  var f3 = T(B([[14, 0], [9, 0], [3, 0]]));           // A♠9♠3♠（恰3同花，断连）
  ok(f3.flush === 'threat' && f3.wet === 1, '恰3同花断连 → flush=threat、wet=中(' + f3.wet + '/' + f3.label + ')');
  var f4 = T(B([[14, 0], [9, 0], [5, 0], [3, 0]]));   // 4♠（转牌 4 同花）
  ok(f4.flush === 'flush', '4张同花 → flush=flush');
  ok(f4.wet === 2 && f4.label === '湿', '4张同花 → 湿');
  var f5 = T(B([[14, 0], [9, 0], [5, 0], [3, 0], [2, 0]])); // 5♠ 河牌同花
  ok(f5.flush === 'flush' && f5.wet === 2, '5张同花 → flush 且湿');
  var rain = T(B([[14, 3], [7, 2], [2, 1]]));
  ok(rain.wet === 0 && rain.label === '干', 'A♣7♦2♥ 彩虹 → 干');
  ok(rain.flush === false && rain.straight === false && rain.paired === false, '彩虹无威胁');
  var mono = T(B([[11, 0], [10, 0], [9, 0]]));
  ok(mono.flush === 'threat' && mono.straight === 'threat' && mono.wet === 2, 'J♠T♠9♠ → 双威胁湿');
  var rStraight = T(B([[12, 1], [11, 2], [10, 3]]));
  ok(rStraight.straight === 'threat' && rStraight.flush === false && rStraight.wet === 2, 'Q♥J♦T♣ 彩虹三连 → straight threat 湿');
  var pairB = T(B([[13, 2], [13, 3], [8, 1]]));
  ok(pairB.paired === true && pairB.wet === 1, 'K♦K♣8♥ → paired 中');
  // 轮子威胁
  var wheelYes = T(B([[14, 0], [5, 1], [4, 2], [2, 3]]));   // A,5,4,2（4/5 轮子窗）
  ok(wheelYes.straight === 'threat', 'A-5-4-2 → 轮子顺威胁(true)');
  var wheelNo = T(B([[14, 0], [6, 1], [5, 2], [2, 3]]));   // A,6,5,2（仅3/5轮子窗）
  ok(wheelNo.straight === false, 'A-6-5-2 → 非轮子威胁(false)');
  var lowRun = T(B([[2, 0], [3, 1], [4, 2]]));             // 2-3-4 三连
  ok(lowRun.straight === 'threat', '2-3-4 → straight threat');
  var empty = T([]);
  ok(empty.wet === 1 && empty.label === '中' && empty.flush === false && empty.straight === false && empty.paired === false, '空 board → 中性');
})();

// ===================== E. 下注尺度约束 =====================
log('== E 尺度合法性（真实自动对战收集）==');
(function () {
  var pers = ['fish', 'rock', 'tag', 'lag', 'solver', 'boss'];
  var NMATCH = 4, records = [], bad = 0;
  for (var mi = 0; mi < NMATCH; mi++) {
    var g = new Game({
      seats: buildSeats(pers, 20000), smallBlind: 10, bigBlind: 20, playerIndex: 0,
      initialChips: 20000, rng: mulberry(3000 + mi)
    });
    for (var h = 0; h < 25; h++) {
      if (g.startHand() === false) break;
      var guard = 0;
      while (!g.isHandOver && guard++ < 800) {
        if (g.currentActor < 0) throw new Error('stuck');
        var idx = g.currentActor;
        var seat = g.seats[idx];
        var d = g.aiDecide(idx);
        if (d.action === 'raise' || d.action === 'allin') {
          var pot = g.potTotal();
          var toCall = Math.max(0, g.currentBet - seat.bet);
          var maxTo = seat.bet + seat.chips;
          var minTo = g.currentBet + Math.max(g.minRaise, g.bigBlind);
          records.push({
            pers: seat.personality ? seat.personality.id : 'human', act: d.action, rt: d.raiseTo,
            minTo: minTo, maxTo: maxTo, pot: pot, cb: g.currentBet, toCall: toCall, bb: g.bigBlind
          });
          if (d.action === 'raise') {
            if (!(d.raiseTo >= minTo && d.raiseTo <= maxTo)) { bad++; log('    BAD raise ' + seat.personality.id + ' rt=' + d.raiseTo + ' min=' + minTo + ' max=' + maxTo); }
          } else { // allin
            if (d.raiseTo !== maxTo) { bad++; log('    BAD allin rt=' + d.raiseTo + ' maxTo=' + maxTo); }
          }
        }
        g.act(idx, d.action, d.raiseTo, d.reason);
      }
      if (g.match && g.match.over) break;
    }
  }
  ok(bad === 0, '自动对战收集 ' + records.length + ' 个 raise/allin，全部满足 target≥minRaise、target≤全下');
  // 越界 frac：非 allin 且 pot 足够大时，raise 净增量不应超过 1.35×base + minTo 容差
  var fracBad = 0, fracN = 0;
  records.forEach(function (r) {
    if (r.act !== 'raise') return;
    var base = r.pot + r.toCall;
    var inc = r.rt - r.cb;
    var step = Math.max(r.minTo - r.cb, 0);
    fracN++;
    var cap = Math.max(Math.round(base * 1.36), step);
    if (inc > cap + 1) { fracBad++; log('    FRAC out: ' + r.pers + ' inc=' + inc + ' base=' + base + ' step=' + step); }
  });
  ok(fracBad === 0, '非 allin raise 增量 ≤ max(1.36×base, min步进)（检查 ' + fracN + ' 个）');
})();
// 超池统计：solver/boss（polarize>0.6）湿面强牌 ≈25%；非极化人格不应超池
(function () {
  var hole = [card(14, 0), card(10, 0)];
  var board = [card(13, 0), card(12, 0), card(11, 0)];
  var N = 2000;
  function seatOf(id) {
    var base = P.get(id); var p2 = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) p2[k] = base[k];
    p2.equitySamples = 120;
    return { id: id, name: base.name, personality: p2, hole: hole, chips: 5000, bet: 0, mood: 0, consecutiveLosses: 0, relations: {}, stats: {} };
  }
  function ctx(seat) {
    return { seat: seat, playerModel: { hands: 10, vpip: 0.3, foldToBet: 0.35, aggression: 0.2 },
      table: { board: board, pot: 300, currentBet: 0, minRaise: 20, bigBlind: 20, street: 'flop', numOpponents: 2, aggressorId: seat.id, raiseCount: 0, positionFactor: 0.7, stealOpportunity: false, stealAttempt: false } };
  }
  var agg = {};
  ['solver', 'boss'].forEach(function (pid) {
    var over = 0, total = 0;
    for (var i = 0; i < N; i++) {
      var st = seatOf(pid);
      var d = Brain.decide(ctx(st));
      if (d.action !== 'raise' && d.action !== 'allin') continue;
      total++;
      if (d.raiseTo > 300) over++;
    }
    agg[pid] = { total: total, over: over, rate: total ? over / total : 0 };
    log('  ' + pid + ': 价值/raise ' + total + '，超池 ' + over + '，占比 ' + (agg[pid].rate * 100).toFixed(1) + '%');
  });
  ['fish', 'rock', 'tag', 'lag'].forEach(function (pid) {
    var over = 0, total = 0;
    for (var i = 0; i < 1200; i++) {
      var st = seatOf(pid);
      var d = Brain.decide(ctx(st));
      if (d.action !== 'raise' && d.action !== 'allin') continue;
      total++;
      if (d.raiseTo > 300) over++;
    }
    agg[pid] = { total: total, over: over, rate: total ? over / total : 0 };
    log('  ' + pid + '(非极化): raise ' + total + '，超池 ' + over + '（应为0）');
    ok(over === 0, pid + ' 无超池（polarize≤0.6）');
  });
  var s = agg.solver, b = agg.boss;
  ok(s.total + b.total > 1000, 'solver+boss 拿到足够样本');
  var okR = s.total && b.total;
  if (okR) {
    ok(s.rate > 0.15 && s.rate < 0.35, 'solver 超池占比≈25%±10pp（' + (s.rate * 100).toFixed(1) + '%）');
    ok(b.rate > 0.15 && b.rate < 0.35, 'boss 超池占比≈25%±10pp（' + (b.rate * 100).toFixed(1) + '%）');
  }
})();

fs.writeFileSync(path.join(__dirname, '_qa_ba_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL === 0 ? 0 : 1);
