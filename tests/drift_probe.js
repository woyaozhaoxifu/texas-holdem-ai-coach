/* global require, console, process */
/**
 * drift_probe.js —— AI 策略漂移（人格 derive）验证探针。
 *
 * 核心命题：AI 要有「没那么严格执行策略」的人味儿，但主基调必须仍然可辨识，
 * 否则匿名桌（玩家靠 HUD 的 VPIP/PFR 反推对手身份）就废了。
 *
 * 覆盖：
 *  1. 身份字段（id/name/avatar）与基准完全一致
 *  2. 情绪/序列化相关字段（moodVolatility/adaptivity/pushBB/tiltFactor/equitySamples）不被扰动
 *  3. rng 恒 0 / 恒 1 两个极端下，vpip 偏离都落在 ±35% 保底内
 *  4. 6 人格 × 1000 次采样：vpip 均值与基准偏差 < 5%（证明是围绕基准摆动，不是漂移走样）
 *  5. rock 的 vpip 最大值仍显著低于 fish 的最小值（可辨识性断言 —— 最重要）
 *  6. 极端输入：null / undefined / 未知 id / 空对象 / 缺字段 → 不崩且有安全兜底
 *  7. 不变式：derive 不污染基准对象（含嵌套 betSizing）、pfr ≤ vpip、preflopTop null 守恒
 *  8. 集成：Game 每手替换 seat.personality，id 稳定、basePersonality 锚点不动
 *
 * 运行：node tests/drift_probe.js
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

var PASS = 0, FAIL = 0;
function ok(cond, label, extra) {
  if (cond) { PASS++; console.log('  [OK]   ' + label + (extra ? '  ' + extra : '')); }
  else { FAIL++; console.log('  [FAIL] ' + label + (extra ? '  ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }
function r4(v) { return (typeof v === 'number') ? Math.round(v * 10000) / 10000 : String(v); }
function pct(v) { return (Math.round(v * 10000) / 100) + '%'; }

var IDS = ['fish', 'rock', 'tag', 'lag', 'solver', 'boss'];
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function constRng(v) { return function () { return v; }; }

// =====================================================================
section('[1] 身份字段必须与基准完全一致（匿名桌靠 id 反推身份）');
IDS.forEach(function (id) {
  var base = P.get(id);
  var d = P.derive(base, mulberry(12345 + id.length));
  ok(d.id === base.id && d.name === base.name && d.avatar === base.avatar,
    id + ' id/name/avatar 一致', 'id=' + d.id);
  ok(d.difficulty === base.difficulty && d.style === base.style && d.color === base.color,
    id + ' difficulty/style/color 一致', 'color=' + d.color);
  ok(!!d.moodLines && d.moodLines === base.moodLines, id + ' moodLines 指向同一对象（台词不被漂走）');
});

// =====================================================================
section('[2] 情绪/序列化相关字段不得被扰动');
var FROZEN = ['moodVolatility', 'adaptivity', 'pushBB', 'tiltFactor', 'equitySamples'];
IDS.forEach(function (id) {
  var base = P.get(id);
  var bad = [];
  for (var k = 0; k < 400; k++) {
    var d = P.derive(base, mulberry(9000 + k));
    for (var i = 0; i < FROZEN.length; i++) {
      if (d[FROZEN[i]] !== base[FROZEN[i]]) bad.push(FROZEN[i] + ':' + d[FROZEN[i]] + '!=' + base[FROZEN[i]]);
    }
  }
  ok(bad.length === 0, id + ' 冻结字段 400 次采样零变化', bad.slice(0, 2).join(','));
});

// =====================================================================
section('[3] 极端 rng（恒 0 / 恒 1）下 vpip、pfr 仍不越过 ±35% 保底');
var LIMIT = 0.35;
IDS.forEach(function (id) {
  var base = P.get(id);
  [0, 1, 0.5, 0.999999].forEach(function (rv) {
    var d = P.derive(base, constRng(rv));
    var devV = Math.abs(d.vpip - base.vpip) / base.vpip;
    var devP = Math.abs(d.pfr - base.pfr) / base.pfr;
    ok(devV <= LIMIT + 1e-9, id + ' vpip 保底 rng=' + rv, base.vpip + ' -> ' + r4(d.vpip) + ' (偏离 ' + pct(devV) + ')');
    ok(devP <= LIMIT + 1e-9, id + ' pfr 保底 rng=' + rv, base.pfr + ' -> ' + r4(d.pfr) + ' (偏离 ' + pct(devP) + ')');
  });
});

// =====================================================================
section('[4] 1000 次采样：各人格 vpip 均值与基准偏差 < 5%（围绕基准摆动）');
var N = 1000;
var means = {};
IDS.forEach(function (id) {
  var base = P.get(id);
  var sum = 0, min = Infinity, max = -Infinity;
  var rnd = mulberry(20250821 + id.charCodeAt(0) * 31);
  for (var k = 0; k < N; k++) {
    var v = P.derive(base, rnd).vpip;
    sum += v; if (v < min) min = v; if (v > max) max = v;
  }
  var mean = sum / N;
  means[id] = { mean: mean, min: min, max: max, base: base.vpip };
  var dev = Math.abs(mean - base.vpip) / base.vpip;
  ok(dev < 0.05, id + ' vpip 均值偏差 < 5%',
    'base=' + base.vpip + ' mean=' + r4(mean) + ' (偏差 ' + pct(dev) + ') 区间[' + r4(min) + ', ' + r4(max) + ']');
});

// =====================================================================
section('[5] 可辨识性：rock 的 vpip 上限 仍显著低于 fish 的 vpip 下限');
var rock = means['rock'], fish = means['fish'];
console.log('  rock vpip 区间 [' + r4(rock.min) + ', ' + r4(rock.max) + ']  base=' + rock.base);
console.log('  fish vpip 区间 [' + r4(fish.min) + ', ' + r4(fish.max) + ']  base=' + fish.base);
ok(rock.max < fish.min, 'rock 最大 vpip < fish 最小 vpip（零重叠）',
  r4(rock.max) + ' < ' + r4(fish.min));
ok(rock.max < fish.min * 0.5, 'rock 上限不到 fish 下限的一半（留足推断余量）',
  r4(rock.max) + ' vs 半值 ' + r4(fish.min * 0.5));
// 顺带验证 6 人格 vpip 均值排序与基准排序一致（HUD 推断不会被打乱）
var order = IDS.slice().sort(function (a, b) { return means[a].mean - means[b].mean; });
var baseOrder = IDS.slice().sort(function (a, b) { return P.get(a).vpip - P.get(b).vpip; });
ok(order.join(',') === baseOrder.join(','), '6 人格 vpip 均值排序与基准排序一致',
  order.join('<') + '  ==  ' + baseOrder.join('<'));

// =====================================================================
section('[6] 极端输入：不崩溃且有安全兜底');
function safe(label, fn) {
  try {
    var d = fn();
    var good = !!d && typeof d === 'object' && typeof d.vpip === 'number' &&
      isFinite(d.vpip) && typeof d.pfr === 'number' && isFinite(d.pfr) &&
      d.pfr >= 0 && d.vpip >= 0 && !!d.betSizing && isFinite(d.betSizing.value);
    ok(good, label, good ? ('id=' + d.id + ' vpip=' + r4(d.vpip)) : '结果非法');
    return d;
  } catch (e) {
    ok(false, label, '抛异常: ' + e.message);
    return null;
  }
}
safe('base = null', function () { return P.derive(null, mulberry(1)); });
safe('base = undefined', function () { return P.derive(undefined, mulberry(1)); });
safe('base = 未知 id 字符串', function () { return P.derive('不存在的xyz', mulberry(1)); });
safe('base = 空对象', function () { return P.derive({}, mulberry(1)); });
safe('base = 数字（脏输入）', function () { return P.derive(42, mulberry(1)); });
safe('base = 缺 betSizing / preflopTop', function () {
  return P.derive({ id: 'rock', vpip: 0.13, pfr: 0.12 }, mulberry(1));
});
safe('rng = undefined（回落 Math.random）', function () { return P.derive(P.get('lag')); });
safe('base 传字符串 id fish', function () { return P.derive('fish', mulberry(3)); });
ok(P.derive('fish', constRng(0.5)).id === 'fish', 'base 传 id 字符串时 id 解析正确');

// =====================================================================
section('[7] 不变式：不污染基准 / pfr ≤ vpip / preflopTop null 守恒');
IDS.forEach(function (id) {
  var base = P.get(id);
  var snapshot = JSON.stringify(base);
  for (var k = 0; k < 200; k++) P.derive(base, mulberry(7000 + k));
  ok(JSON.stringify(base) === snapshot, id + ' 200 次 derive 后基准对象零污染');
});
var allZh = [];
IDS.forEach(function (id) {
  for (var k = 0; k < 300; k++) {
    var d = P.derive(P.get(id), mulberry(31 + k));
    allZh.push([id, d]);
  }
});
var pfrBad = allZh.filter(function (x) { return x[1].pfr > x[1].vpip + 1e-9; });
ok(pfrBad.length === 0, 'pfr ≤ vpip 恒成立', pfrBad.length ? pfrBad[0][0] : '');
var topBad = allZh.filter(function (x) {
  var b = P.get(x[0]);
  if (b.preflopTop == null) return x[1].preflopTop != null;
  var dev = Math.abs(x[1].preflopTop - b.preflopTop) / b.preflopTop;
  return dev > 0.16;
});
ok(topBad.length === 0, 'preflopTop：null 守恒、非 null 幅度 ≤ ±15%', topBad.length ? topBad[0][0] : '');
var sizeBad = allZh.filter(function (x) {
  var b = P.get(x[0]).betSizing;
  return Math.abs(x[1].betSizing.value - b.value) / b.value > 0.11 ||
    Math.abs(x[1].betSizing.bluff - b.bluff) / b.bluff > 0.11 ||
    x[1].betSizing.polarize !== b.polarize;
});
ok(sizeBad.length === 0, 'betSizing：value/bluff ≤ ±10%，polarize 不动', sizeBad.length ? sizeBad[0][0] : '');
// 漂移确实“有效”：随机变量不能完全冻结
var tagBase = P.get('tag');
var diffs = 0;
for (var q = 0; q < 200; q++) {
  var dd = P.derive(tagBase, mulberry(555 + q));
  if (Math.abs(dd.aggression - tagBase.aggression) > 1e-9) diffs++;
}
ok(diffs > 190, '漂移确实在生效（200 次中绝大多数 aggression 有变化）', diffs + '/200');

// =====================================================================
section('[8] 集成：Game.startHand 每手替换 seat.personality');
function buildGame(driftOpt) {
  var seats = [{ id: 'you', name: '你', isHuman: true, personality: null, chips: 2000 }];
  IDS.forEach(function (id) {
    seats.push({ id: id, name: P.get(id).name, isHuman: false, personality: P.get(id), chips: 2000 });
  });
  var cfg = {
    seats: seats, smallBlind: 10, bigBlind: 20, playerIndex: 0,
    autoRebuy: false, initialChips: 2000, rng: mulberry(4242)
  };
  if (driftOpt === false) cfg.drift = false;
  return new Game(cfg);
}

var g = buildGame(true);
// 第一次 startHand 之前的冻结：basePersonality 已在构造函数里设定
ok(g.seats[1].basePersonality === P.get('fish'), '构造时 basePersonality 即锚定为基准人格对象');
ok(g.seats[0].basePersonality === null && g.seats[0].personality === null, '人类座位 personality / basePersonality 均为 null');

var idStable = true, changed = 0, anchorOk = true, humanOk = true;
for (var h = 0; h < 20; h++) {
  g.startHand();
  for (var si = 1; si < g.seats.length; si++) {
    var s = g.seats[si];
    if (s.personality.id !== IDS[si - 1]) idStable = false;
    if (s.personality !== g.seats[si].basePersonality) changed++;
    if (s.basePersonality !== P.get(IDS[si - 1])) anchorOk = false;
    if (s.personality.drift !== s.basePersonality.drift) anchorOk = false;
  }
  if (g.seats[0].personality !== null) humanOk = false;
}
ok(idStable, '20 手后每个 AI 的 personality.id 仍 == 基准 id（排行榜/复盘不会失真）');
ok(anchorOk, '20 手后 basePersonality 锚点始终未被改写');
ok(humanOk, '20 手后人类座位 personality 恒为 null');
ok(changed === 20 * IDS.length, '每手都产生了新的派生人格对象（不是同一引用）', changed + '/' + (20 * IDS.length));

// 排行榜序列化读的是 .id（返回顺序按筹码排序，故用集合比较）
g.match = { enabled: true, eliminated: {}, points: {}, roundPts: {}, roundStartChips: {} };
var stand = g.computeRoundStandings();
var gotIds = stand.map(function (x) { return x.personality; }).sort().join(',');
var wantIds = ['you'].concat(IDS).slice(1).concat(['']).sort().join(',');
ok(gotIds === wantIds, 'computeRoundStandings 的 personality 字段仍是正确 id', gotIds);

// 关闭漂移开关：personality 与 basePersonality 同引用（兜底逃生通道）
var g2 = buildGame(false);
g2.startHand();
var same = true;
for (var s2 = 1; s2 < g2.seats.length; s2++) if (g2.seats[s2].personality !== g2.seats[s2].basePersonality) same = false;
ok(same, 'config.drift=false 时完全不漂移（引用同一对象）');

// 单手 interface deriveness
var g3 = buildGame(true);
g3.startHand();
console.log('  示例：tag 本手 vpip ' + g3.seats[3].basePersonality.vpip + ' -> ' + r4(g3.seats[3].personality.vpip) +
  '   (rock ' + g3.seats[2].basePersonality.vpip + ' -> ' + r4(g3.seats[2].personality.vpip) + ')');

// =====================================================================
console.log('\n============================================');
console.log('PASS ' + PASS + '   FAIL ' + FAIL);
console.log('============================================');
process.exit(FAIL ? 1 : 0);
