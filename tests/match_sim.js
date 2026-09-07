/* global require, console, process */
/**
 * 比赛模式引擎测试（tests/match_sim.js）
 * 运行：node tests/match_sim.js
 *
 * 覆盖：
 *  1. 第 1 轮恰好 15 手后触发 roundEnd，盲注 10/20；第 2 轮 15/30；第 3 轮 25/50
 *  2. 轮末暂停：pendingRoundEnd 时 startHand 拒绝开局；startNextRound 后恢复
 *  3. 淘汰：筹码归零标记 eliminated，之后发牌/行动跳过，不被补筹
 *  4. 无补筹 & 总筹码守恒（含中途强制淘汰时把筹码转移给幸存者）
 *  5. 名次积分：第1/2/3名 +5/+3/+1，淘汰者 0 分，累计正确
 *  6. 只剩 1 人时比赛结束：over=true、matchEnd 事件、冠军为最后幸存者
 *  7. 练习模式（无 match 配置）行为不变
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

var failed = 0;
function assert(cond, msg) {
  if (cond) console.log('  PASS — ' + msg);
  else { console.log('  FAIL — ' + msg); failed++; }
}
function sumChips(g) {
  var t = 0, i;
  for (i = 0; i < g.seats.length; i++) t += g.seats[i].chips;
  return t;
}

function buildSeats(ids, chips) {
  return ids.map(function (id) {
    var p = P.get(id);
    return { id: id, name: p.name, avatar: p.avatar, isHuman: false, personality: p, chips: chips };
  });
}

/** 完整打完一手（全部 AI 自动行动）。返回 false 表示 startHand 被拒绝。 */
function playHand(g) {
  var started = g.startHand();
  if (started === false) return false;
  var guard = 0;
  while (!g.isHandOver && guard++ < 600) {
    if (g.currentActor < 0) { g.isHandOver = false; break; }
    var idx = g.currentActor;
    var d = g.aiDecide(idx);
    g.act(idx, d.action, d.raiseTo, d.reason);
  }
  if (guard >= 600) throw new Error('第 ' + g.handNo + ' 手疑似死循环');
  g.isHandOver = false;
  return true;
}

function drain(g) {
  var evs = g.drainEvents();
  var out = { roundEnd: null, matchEnd: null };
  evs.forEach(function (e) {
    if (e.type === 'roundEnd') out.roundEnd = e;
    if (e.type === 'matchEnd') out.matchEnd = e;
  });
  return out;
}

try {
  var TOTAL = 1200000;   // 6 × 200000：超深筹码，避免随机自然淘汰干扰分轮断言
  var ids = ['boss', 'solver', 'lag', 'tag', 'rock', 'fish'];
  var g = new Game({
    seats: buildSeats(ids, 200000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 200000,
    match: { enabled: true, roundHands: 15, blindLevels: [
      { sb: 10, bb: 20 }, { sb: 15, bb: 30 }, { sb: 25, bb: 50 },
      { sb: 40, bb: 80 }, { sb: 60, bb: 120 }] }
  });

  console.log('—— 比赛模式：开局 ——');
  assert(g.match.enabled && g.match.roundNo === 1, '比赛开启，第 1 轮');
  assert(g.smallBlind === 10 && g.bigBlind === 20, '第 1 轮盲注 10/20');
  assert(g.config.autoRebuy === false, '比赛不补筹（autoRebuy=false）');
  assert(sumChips(g) === TOTAL, '初始总筹码 12000');

  console.log('—— 第 1 轮：15 手轮满 ——');
  for (var h1 = 0; h1 < 14; h1++) {
    if (playHand(g) === false) break;
  }
  assert(!g.match.pendingRoundEnd, '第 1 轮前 14 手未触发轮末');
  playHand(g);
  var ev1 = drain(g);
  assert(!!ev1.roundEnd, '第 15 手触发 roundEnd');
  assert(ev1.roundEnd.roundNo === 1, 'roundEnd 轮次 = 1');
  assert(ev1.roundEnd.handsPlayed === 15, 'roundEnd 手数 = 15');
  assert(ev1.roundEnd.sb === 10 && ev1.roundEnd.bb === 20, 'roundEnd 携带盲注 10/20');
  assert(g.match.pendingRoundEnd === true, 'pendingRoundEnd = true（等待确认）');
  assert(g.startHand() === false, '轮末暂停：startHand 返回 false');
  var st1 = ev1.roundEnd.standings;
  assert(st1.length === 6, '榜单含 6 人');
  assert(st1[0].roundPts === 5 && st1[1].roundPts === 3 && st1[2].roundPts === 1, '积分规则 第1/2/3名 +5/+3/+1');
  assert(st1[3].roundPts === 0 && st1[4].roundPts === 0 && st1[5].roundPts === 0, '第 4 名以后本轮 0 分');
  var ptsSum1 = st1.reduce(function (a, r) { return a + r.roundPts; }, 0);
  assert(ptsSum1 === 9, '本轮总分 = 9');
  var okPtsCum = st1.every(function (r) { return r.totalPts === r.roundPts; });
  assert(okPtsCum, '第 1 轮累计积分 = 本轮积分');
  assert(sumChips(g) === TOTAL, '第 1 轮结束筹码守恒');
  assert(st1.every(function (r) { return !r.eliminated || r.roundPts === 0; }), '若有出局者，本轮积分必须为 0');

  console.log('—— 第 2 轮：盲注升级 + 淘汰跳过 ——');
  assert(g.startNextRound() === true, 'startNextRound 成功');
  assert(g.match.roundNo === 2, '进入第 2 轮');
  assert(g.smallBlind === 15 && g.bigBlind === 30, '第 2 轮盲注 15/30');
  assert(g.match.handsInRound === 0 && !g.match.pendingRoundEnd, '第 2 轮手数清零、解除暂停');

  for (var h2 = 0; h2 < 5; h2++) playHand(g);
  // 找一名可淘汰的座位并保留一名幸存者承接其筹码（模拟“本手输光出局”）
  var victim = -1, i2;
  for (i2 = 1; i2 < g.seats.length; i2++) {
    if (!g.match.eliminated[i2] && g.seats[i2].chips > 0) { victim = i2; break; }
  }
  assert(victim >= 0, '找到可淘汰座位（seat ' + victim + '）');
  var donor = -1, best = -1, i3;
  for (i3 = 0; i3 < g.seats.length; i3++) {
    if (i3 !== victim && !g.match.eliminated[i3] && g.seats[i3].chips > best) { best = g.seats[i3].chips; donor = i3; }
  }
  g.seats[donor].chips += g.seats[victim].chips;
  assert(g.eliminateSeat(victim) === true, 'eliminateSeat 标记淘汰');
  assert(g.match.eliminated[victim] === true && g.seats[victim].sittingOut === true, '淘汰座位被置为坐出');
  assert(g.seats[victim].chips === 0, '淘汰座位筹码为 0');
  assert(g.match.bustRound[victim] === 2, '记录出局轮次 = 2');
  assert(sumChips(g) === TOTAL, '转移后筹码仍守恒');

  playHand(g);
  assert(g.seats[victim].hole.length === 0, '淘汰座位不再被发牌');
  var victimActed = false;
  g.handLog.forEach(function (lg) { if (lg.seatIndex === victim) victimActed = true; });
  assert(!victimActed, '淘汰座位不再行动/下注');
  assert(g.seats[victim].chips === 0, '淘汰座位不被补筹');

  var r2h = 6;
  while (!g.match.pendingRoundEnd && !g.match.over && r2h < 15) { playHand(g); r2h++; }
  assert(g.match.pendingRoundEnd === true, '第 2 轮 15 手触发轮末');
  var ev2 = drain(g);
  assert(!!ev2.roundEnd && ev2.roundEnd.roundNo === 2, '第 2 轮 roundEnd');
  var vrow = null;
  ev2.roundEnd.standings.forEach(function (r) { if (r.seatIndex === victim) vrow = r; });
  assert(!!vrow && vrow.eliminated, '榜单中标示淘汰者');
  assert(!!vrow && vrow.roundPts === 0, '淘汰者本轮记 0 分');
  assert(sumChips(g) === TOTAL, '第 2 轮结束筹码守恒');

  console.log('—— 第 3 轮：终局判定 ——');
  assert(g.startNextRound() === true, '进入第 3 轮');
  assert(g.smallBlind === 25 && g.bigBlind === 50, '第 3 轮盲注 25/50');
  // 直接清到只剩 2 人 → 再淘汰 1 人 → 只剩 1 人，交给 startHand 兜底判定终局
  var alive = [];
  g.seats.forEach(function (s, si) { if (!g.match.eliminated[si] && s.chips > 0) alive.push(si); });
  assert(alive.length >= 2, '尚有至少 2 名存活者');
  var keepA = alive[0], keepB = alive[1], i4;
  for (i4 = 0; i4 < alive.length; i4++) {
    var ai = alive[i4];
    if (ai !== keepA && ai !== keepB) {
      g.seats[keepA].chips += g.seats[ai].chips;
      g.eliminateSeat(ai);
    }
  }
  assert(g.aliveCount() === 2, '只剩 2 人');
  g.seats[keepA].chips += g.seats[keepB].chips;
  g.eliminateSeat(keepB);
  assert(g.aliveCount() === 1, '只剩 1 人');
  assert(g.match.over === false, 'over 尚未触发（等待兜底判定）');
  assert(g.startHand() === false, '只剩 1 人时 startHand 拒绝开局');
  var ev3 = drain(g);
  assert(g.match.over === true, '比赛结束 over=true');
  assert(!!ev3.roundEnd && ev3.roundEnd.over === true, 'roundEnd.over=true');
  assert(!!ev3.matchEnd, 'matchEnd 事件触发');
  // 终局语义（自然终局）：幸存者强制第一并成为冠军；其余按累计积分（同分比筹码）
  var surv = null;
  ev3.matchEnd.standings.forEach(function (r) { if (!r.eliminated) surv = r; });
  assert(!!surv && surv.chips === TOTAL, '最后幸存者持有全部筹码（无补筹）');
  assert(!!surv && ev3.matchEnd.standings[0].id === surv.id, '自然终局 standings[0] = 最后幸存者');
  assert(!!surv && !ev3.matchEnd.standings[0].eliminated, '自然终局冠军未被标记淘汰');
  assert(ev3.matchEnd.champion.id === surv.id, 'matchEnd 冠军 = 最后幸存者');
  assert(sumChips(g) === TOTAL, '终局总筹码守恒（无补筹）');
  assert(g.startHand() === false, '比赛结束后 startHand 恒拒绝');

  // 中途退出语义：比赛未结束（自然幸存者尚未产生）时，最终排名按累计积分 desc
  var g4 = new Game({
    seats: buildSeats(ids, 200000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 200000,
    match: { enabled: true, roundHands: 15, blindLevels: [
      { sb: 10, bb: 20 }, { sb: 15, bb: 30 }, { sb: 25, bb: 50 }] }
  });
  for (var q = 0; q < 15; q++) playHand(g4);
  assert(g4.match.pendingRoundEnd === true && !g4.match.over, '中途退出场景：轮末且未终局');
  var finQ = g4.finalStandings();
  var maxPtsQ = finQ.reduce(function (a, r) { return Math.max(a, r.totalPts); }, -1);
  assert(finQ[0].totalPts === maxPtsQ, '中途退出：榜单第 1 名 = 累计积分最高者');
  assert(finQ[0].totalPts >= finQ[1].totalPts, '中途退出：按累计积分降序');

  console.log('—— 练习模式（无 match 配置）行为不变 ——');
  var g2 = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver'], 2000).concat(
      [{ id: 'you', name: '你', isHuman: false, personality: P.get('tag'), chips: 2000 }]),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 2000
  });
  var r2 = g2.startHand();
  assert(!!r2 && g2.handNo === 1, '练习模式 startHand 正常返回');
  assert(g2.match === null, '练习模式无 match 状态');
  var guard2 = 0;
  while (!g2.isHandOver && guard2++ < 600) {
    if (g2.currentActor < 0) { g2.isHandOver = false; break; }
    var dd = g2.aiDecide(g2.currentActor);
    g2.act(g2.currentActor, dd.action, dd.raiseTo, dd.reason);
  }
  assert(g2.history.length === 1, '练习模式 1 手正常完成');
  assert(sumChips(g2) === 12000, '练习模式筹码守恒');

  console.log('\n结果: ' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.log('EXCEPTION: ' + (e && e.stack || e));
  process.exit(1);
}
