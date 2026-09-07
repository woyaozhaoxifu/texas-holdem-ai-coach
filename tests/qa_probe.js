/* global require, console, process */
/**
 * tests/qa_probe.js —— QA 独立验收探针（fresh eyes，不复用现成断言）
 * 运行：node tests/qa_probe.js
 * 构造真实比赛配置驱动全局 Poker.Game，独立验证：
 *  ① 第1轮前14手不触发轮末、第15手触发，盲注 10/20
 *  ② 第2/3轮盲注 15/30、25/50（含盲注升级表逐档）
 *  ③ 全程筹码守恒（含自然淘汰）
 *  ④ 强制清零某 AI → 后续不发牌/不行动/不补筹
 *  ⑤ 只剩1人 → startHand 拒绝、over、finalStandings[0]=幸存者（自然终局）
 *  ⑥ 中途退出 finalStandings 按积分降序
 */
'use strict';

var path = require('path');
var D = path.join(__dirname, '..');
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'ai/brain.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var Game = require(path.join(D, 'js/game.js'));
var P = global.Poker.Personalities;

var FAILED = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS — ' + msg);
  else { console.log('  FAIL — ' + msg); FAILED++; }
}
function sumChips(g) {
  var t = 0, i;
  for (i = 0; i < g.seats.length; i++) t += g.seats[i].chips;
  return t;
}
// 确定性随机（mulberry32）
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function buildSeats(ids, chips, humanFirst) {
  var arr = [];
  ids.forEach(function (id) {
    var p = P.get(id);
    arr.push({ id: id, name: p.name, avatar: p.avatar, isHuman: false, personality: p, chips: chips });
  });
  if (humanFirst) {
    var you = arr[0];
    arr[0] = { id: 'you', name: '你', isHuman: true, personality: null, chips: chips };
    you.id = 'youX'; // 避免重名影响后续查找
    arr.push(you);   // 把原本的 AI 换到末位，保证仍是 6 座
  }
  return arr;
}
function playHand(g) {
  var started = g.startHand();
  if (started === false) return false;
  var guard = 0;
  while (!g.isHandOver && guard++ < 600) {
    var idx = g.currentActor;
    if (idx < 0) throw new Error('第 ' + g.handNo + ' 手 currentActor<0 但未终局');
    var d = g.aiDecide(idx);
    g.act(idx, d.action, d.raiseTo, d.reason);
  }
  if (guard >= 600) throw new Error('第 ' + g.handNo + ' 手疑似死循环');
  return true;
}
function lastEv(g, type) {
  var evs = g.drainEvents(), out = null;
  evs.forEach(function (e) { if (e.type === type) out = e; });
  return out;
}
function assertSortedByPtsDesc(st) {
  for (var i = 1; i < st.length; i++) {
    if (st[i - 1].totalPts < st[i].totalPts) return false;
  }
  return true;
}

var BLINDS = [{ sb: 10, bb: 20 }, { sb: 15, bb: 30 }, { sb: 25, bb: 50 }, { sb: 40, bb: 80 },
  { sb: 60, bb: 120 }, { sb: 100, bb: 200 }, { sb: 150, bb: 300 }, { sb: 250, bb: 500 },
  { sb: 400, bb: 800 }, { sb: 600, bb: 1200 }];

try {
  console.log('== 探针A：真实低筹码自然比赛至终局 ==');
  var INIT = 1000, TOTAL = 6 * INIT;
  var g = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], INIT),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: INIT,
    rng: rng(20260907),
    match: { enabled: true, roundHands: 15, blindLevels: BLINDS }
  });
  ok(g.config.autoRebuy === false, '比赛自动置 autoRebuy=false');
  ok(sumChips(g) === TOTAL, '初始筹码总和 ' + TOTAL);

  var maxHands = 500, h = 0, naturalOver = false, fullRounds = 0, lastRoundCheck = null;
  var conservationBroken = null;
  var roundHandCounts = {};   // 每轮结算时的已打手数
  while (h < maxHands && !naturalOver) {
    if (g.match.pendingRoundEnd) {
      var rd = g.match.roundNo;
      // 轮末（未终局）时快照
      if (!g.match.over) {
        roundHandCounts[rd] = g.match.handsInRound;
        var stE = g.match.lastStandings;
        // 积分只应在此刻结算：校验每行 roundPts ∈ {0,1,3,5}，淘汰=0
        stE.forEach(function (r) {
          var bad = (r.roundPts !== 0 && r.roundPts !== 1 && r.roundPts !== 3 && r.roundPts !== 5);
          if (bad) { console.log('  FAIL — 积分非法值 ' + r.roundPts + ' @ round ' + rd); FAILED++; }
        });
        stE.forEach(function (r) {
          if (r.eliminated && r.roundPts !== 0) { console.log('  FAIL — 淘汰者仍得分 @ round ' + rd); FAILED++; }
        });
        if (g.match.roundNo <= BLINDS.length) {
          var lv = BLINDS[rd - 1];
          if (!(g.smallBlind === lv.sb && g.bigBlind === lv.bb)) {
            console.log('  FAIL — 轮 ' + rd + ' 盲注应为 ' + lv.sb + '/' + lv.bb + ' 实际 ' + g.smallBlind + '/' + g.bigBlind); FAILED++;
          }
        }
      }
      // 轮末到下一轮：验证 startNextRound 语义
      if (g.aliveCount() > 1) {
        var before = g.match.roundNo;
        var nxt = g.startNextRound();
        ok(nxt === true, '轮末 alive>1 时 startNextRound 成功');
        if (g.match.roundNo === 2 && before === 1) lastRoundCheck = { sb: g.smallBlind, bb: g.bigBlind };
        fullRounds++;
      } else {
        // alive<=1 而 pendingRoundEnd（自然终局已在结算时置 over），防御分支
        if (!g.match.over) { console.log('  FAIL — alive<=1 且未 over'); FAILED++; }
      }
    }
    if (g.match.over) { naturalOver = true; break; }
    if (g.aliveCount() <= 1 && !g.match.over) { g.startHand(); continue; } // 触发兜底
    var startedH = playHand(g);
    if (startedH === false) { if (g.match.over) { naturalOver = true; break; } }
    h++;
    var s = sumChips(g);
    if (s !== TOTAL) { conservationBroken = '第' + g.handNo + '手 总和=' + s; break; }
    if (h % 50 === 0) console.log('    …已打 ' + h + ' 手, 存活 ' + g.aliveCount() + ', 轮 ' + g.match.roundNo + ', 盲注 ' + g.smallBlind + '/' + g.bigBlind);
  }
  console.log('  自然进程: 打完 ' + h + ' 手, 经历完整轮 ' + fullRounds + ' 个, 终局=' + naturalOver);

  // ① 第1轮 15 手触发（若第1轮是满手数结束）
  console.log('== 探针A1：轮满边界 ==');
  var g15 = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 20000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 20000,
    rng: rng(777),
    match: { enabled: true, roundHands: 15, blindLevels: BLINDS }
  });
  var t14 = true;
  for (var q = 0; q < 14; q++) { if (playHand(g15) === false) { t14 = false; break; } }
  ok(t14 && !g15.match.pendingRoundEnd && !g15.match.over, '第1轮前14手不触发轮末/终局');
  ok(g15.smallBlind === 10 && g15.bigBlind === 20, '第1轮盲注 10/20');
  playHand(g15);
  ok(g15.match.pendingRoundEnd === true, '第15手触发轮末暂停');
  var re1 = lastEv(g15, 'roundEnd');
  ok(!!re1 && re1.roundNo === 1 && re1.handsPlayed === 15, 'roundEnd roundNo=1 handsPlayed=15');
  ok(!!re1 && re1.sb === 10 && re1.bb === 20, 'roundEnd 盲注 10/20');
  // 积分规则校验（对轮内自然淘汰保持稳健：被淘汰者不占名次分）
  // 注：翻后胜率用 Math.random（蒙特卡洛），故轮内是否自然淘汰在多次运行间会变化；
  // 这里校验的是「5/3/1 名次分 + 淘汰者 0 分 + 按名次单调不增」这一不变规则。
  var st1A = re1.standings;
  ok(st1A[0].roundPts === 5 && st1A[1].roundPts === 3, '第1/2名积分 5/3');
  ok(st1A.every(function (r) { return r.roundPts === 0 || r.roundPts === 1 || r.roundPts === 3 || r.roundPts === 5; }), '单行积分仅允许 0/1/3/5');
  ok(st1A.every(function (r) { return !r.eliminated || r.roundPts === 0; }), '淘汰者本轮必为 0 分');
  var monoA = true, prevP = 99;
  st1A.forEach(function (r) { if (r.roundPts > prevP) monoA = false; prevP = r.roundPts; });
  ok(monoA, '按名次积分单调不增（存活者第三名 +1，淘汰者不占分）');
  var cumOk = re1.standings.every(function (r) { return r.totalPts === r.roundPts; });
  ok(cumOk, '第1轮累计积分=本轮积分（只在轮末结算一次）');
  // 轮末 startHand 拒绝
  ok(g15.startHand() === false, '轮末 startHand 拒绝开局');

  // ② 第2/3轮盲注升级（注意：startNextRound 仅在轮末 pendingRoundEnd 时可调）
  ok(g15.startNextRound() === true, '第2轮 startNextRound');
  ok(g15.smallBlind === 15 && g15.bigBlind === 30, '第2轮盲注 15/30');
  for (var q2 = 0; q2 < 15; q2++) playHand(g15);   // 打满第2轮
  ok(g15.match.pendingRoundEnd === true, '第2轮打满后进入轮末');
  ok(g15.startNextRound() === true, '第3轮 startNextRound');
  ok(g15.smallBlind === 25 && g15.bigBlind === 50, '第3轮盲注 25/50');

  console.log('== 探针B：强制淘汰后跳过/不补筹 + 单挑自然终局 ==');
  var g2 = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 1000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 1000,
    rng: rng(4242),
    match: { enabled: true, roundHands: 15, blindLevels: BLINDS }
  });
  playHand(g2);
  // 找非0座位强制清零并转移给另一名幸存者（守恒模拟真实输光）
  var v = -1, i;
  for (i = 1; i < g2.seats.length; i++) { if (!g2.match.eliminated[i] && g2.seats[i].chips > 0) { v = i; break; } }
  ok(v >= 0, '找到强制淘汰目标 seat ' + v);
  var d2 = -1, b2 = -1;
  for (i = 0; i < g2.seats.length; i++) {
    if (i !== v && !g2.match.eliminated[i] && g2.seats[i].chips > b2) { b2 = g2.seats[i].chips; d2 = i; }
  }
  g2.seats[d2].chips += g2.seats[v].chips;
  ok(g2.eliminateSeat(v) === true, 'eliminateSeat 成功');
  ok(g2.match.eliminated[v] && g2.seats[v].sittingOut && g2.seats[v].chips === 0, '淘汰座位 chips=0 & sittingOut');
  ok(sumChips(g2) === TOTAL, '转移后筹码守恒');
  var actedLog = null;
  playHand(g2);
  actedLog = g2.handLog.some(function (lg) { return lg.seatIndex === v; });
  ok(!actedLog, '强制淘汰座位不参与行动');
  ok(g2.seats[v].hole.length === 0, '淘汰座位不再发牌');
  ok(g2.seats[v].chips === 0, '淘汰座位不被补筹');
  var deadAtRound = g2.match.bustRound[v];
  ok(deadAtRound === g2.match.roundNo || deadAtRound >= 1, '淘汰轮次已记录');

  // 直接清到 1 名幸存者 → 验证终局语义（含 ① alive 检测兜底 startHand）
  var alive = [];
  g2.seats.forEach(function (s, si) { if (!g2.match.eliminated[si] && s.chips > 0) alive.push(si); });
  ok(alive.length >= 2, '仍有 ≥2 存活，可构造终局');
  var keeper = alive[0], i2;
  for (i2 = 0; i2 < alive.length; i2++) {
    if (alive[i2] !== keeper) {
      g2.seats[keeper].chips += g2.seats[alive[i2]].chips;
      g2.eliminateSeat(alive[i2]);
    }
  }
  ok(g2.aliveCount() === 1, '只剩 1 人');
  ok(g2.match.over === false, 'over 尚未置位（等待兜底）');
  ok(g2.startHand() === false, '只剩1人时 startHand 拒绝');
  var me2 = lastEv(g2, 'matchEnd');
  ok(!!me2, 'matchEnd 事件触发');
  var surv2 = null;
  me2.standings.forEach(function (r) { if (!r.eliminated) surv2 = r; });
  ok(!!surv2 && surv2.chips === TOTAL, '幸存者持有全部筹码');
  ok(me2.standings[0].id === surv2.id && me2.champion.id === surv2.id, '自然终局 standings[0] & champion = 最后幸存者');
  ok(!me2.standings[0].eliminated, '冠军未被标记淘汰');
  ok(sumChips(g2) === TOTAL, '终局筹码守恒');
  ok(g2.startHand() === false, 'over 后 startHand 恒拒绝');
  var st2 = g2.finalStandings();
  ok(st2[0].id === surv2.id, 'finalStandings[0]=幸存者');

  console.log('== 探针C：中途退出（无自然幸存者）按积分降序 ==');
  var g3 = new Game({
    seats: buildSeats(['fish', 'rock', 'tag', 'lag', 'solver', 'boss'], 5000),
    smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 5000,
    rng: rng(99),
    match: { enabled: true, roundHands: 15, blindLevels: BLINDS }
  });
  for (var q3 = 0; q3 < 15; q3++) playHand(g3);
  ok(g3.match.pendingRoundEnd && !g3.match.over, '场景就绪：轮末且未终局');
  var fin3 = g3.finalStandings();
  ok(fin3.length === 6, '榜单含 6 人');
  ok(assertSortedByPtsDesc(fin3), '中途退出 finalStandings 按 totalPts 降序');
  var maxPts = 0;
  fin3.forEach(function (r) { if (r.totalPts > maxPts) maxPts = r.totalPts; });
  ok(fin3[0].totalPts === maxPts, '#1 为累计积分最高者（冠军语义）');
  // 同分比筹码：人工构造两组同分，验证次排序键
  var fin3b = fin3.slice().sort(function (a, b) {
    if (b.totalPts !== a.totalPts) return b.totalPts - a.totalPts;
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    return (b.chips - a.chips) || (a.seatIndex - b.seatIndex);
  });
  var sameOk = fin3.every(function (r, k) { return fin3b[k].seatIndex === r.seatIndex; });
  ok(sameOk, '同分时按筹码降序（与 finalStandings 实现一致）');

  console.log('== 探针D：整场守恒（自然比赛全程逐步校验） ==');
  ok(conservationBroken === null, conservationBroken === null ? '探针A 全程筹码守恒' : ('守恒破坏: ' + conservationBroken));

  console.log('\n结果: ' + (FAILED === 0 ? '全部通过' : FAILED + ' 项失败'));
  process.exit(FAILED === 0 ? 0 : 1);
} catch (e) {
  console.log('EXCEPTION: ' + (e && e.stack || e));
  process.exit(1);
}
