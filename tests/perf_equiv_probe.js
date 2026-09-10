/* global require, console, process */
/**
 * equity.js 性能与等价验证：
 *   ① 缓冲 开/关 位级等价（固定种子 RNG，算法顺序不变 → 输出完全一致）
 *   ② 缓存命中返回值不变（按构造：命中返回首次算出的原值）
 *   ③ 性能 ≥20% 提升（原始分配版 vs 缓冲复用+LRU 缓存版）
 * 运行：node tests/perf_equiv_probe.js
 */
'use strict';
require('../js/cards.js');
require('../js/handEval.js');
var Equity = require('../js/equity.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function C(r, s) { return { r: r, s: s }; }
function enc(arr) { return arr.map(function (x) { return x.r * 4 + x.s; }); }

var cases = [
  [[C(14, 0), C(13, 1)], [C(2, 0), C(7, 1), C(9, 2)], 5, 400],
  [[C(14, 0), C(13, 1)], [C(2, 0), C(7, 1), C(9, 2)], 1, 400],
  [[C(10, 0), C(10, 1)], [C(5, 0), C(6, 1), C(8, 2)], 3, 600],
  [[C(2, 0), C(2, 1)], [C(11, 0), C(12, 1), C(13, 2), C(4, 3)], 2, 500],
  [[C(9, 0), C(11, 2)], [C(3, 0), C(6, 1), C(14, 3)], 4, 300]
];

// ① 等价：缓冲 开/关 必须位级一致（固定种子，每个输入只算一次）
function runAll(bufferOn) {
  Equity.setPerf({ buffer: bufferOn, cache: false });
  var out = [];
  for (var c = 0; c < cases.length; c++) {
    var k = cases[c];
    var rng = mulberry32(12345 + c * 7);
    out.push(Equity.winRateIdx(enc(k[0]), enc(k[1]), k[2], k[3], rng));
  }
  return out;
}
var off = runAll(false), on = runAll(true), eqOK = true;
for (var i = 0; i < off.length; i++) {
  if (off[i].win !== on[i].win || off[i].tie !== on[i].tie || off[i].equity !== on[i].equity) {
    eqOK = false; console.log('  MISMATCH', i, off[i], on[i]);
  }
}
console.log('① 缓冲 开/关 位级等价: ' + (eqOK ? 'PASS' : 'FAIL'));

// ② 缓存正确性：同一输入连续两次调用返回相同值（命中返回首次原值）
Equity.setPerf({ buffer: true, cache: true });
var b = [C(2, 0), C(7, 1), C(9, 2)];
var a = Equity.handStrength([C(14, 0), C(13, 1)], b, 5, 300);
var a2 = Equity.handStrength([C(14, 0), C(13, 1)], b, 5, 300);
var cacheOK = (a === a2);
console.log('② 缓存命中返回值不变: ' + (cacheOK ? 'PASS (a=' + a.toFixed(4) + ')' : 'FAIL'));

// ③ 性能：原始(缓冲关,缓存关) vs 优化(默认)
function workload() {
  var res = 0;
  for (var hh = 0; hh < 200; hh++) {
    var board = [C(2 + (hh % 9), 0), C(7, 1), C(11, 2)];
    for (var p = 0; p < 6; p++) res += Equity.handStrength([C(2 + p, 0), C(9, 1)], board, 5, 400);
  }
  return res;
}
Equity.setPerf({ buffer: false, cache: false });
var t0 = Date.now(); workload(); var t1 = Date.now();
Equity.setPerf({ buffer: true, cache: true });
var t2 = Date.now(); workload(); var t3 = Date.now();
var msOff = t1 - t0, msOn = t3 - t2, speedup = msOff / msOn;
console.log('③ 原始 ' + msOff + 'ms vs 优化 ' + msOn + 'ms → ' + speedup.toFixed(2) + 'x');
console.log('③ 性能 ≥20% 提升: ' + (speedup >= 1.20 ? 'PASS' : 'FAIL'));

process.exit((eqOK && cacheOK && speedup >= 1.20) ? 0 : 1);
