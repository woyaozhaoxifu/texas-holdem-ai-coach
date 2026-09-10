/* global window, global */
/**
 * rng.js —— 独立 PRNG（mulberry32）。
 *
 * 原本内联在 game.js 顶部，供「策略漂移」使用。抽出为共享模块，
 * 让 game.js 与 drift.js 都能复用同一份实现，避免 drift.js 反向 require
 * game.js 造成的循环依赖。
 *
 * 设计要点（沿用原 game.js 注释）：
 *   漂移刻意**不**消费牌局主 rng —— 那会挪动洗牌随机流、让所有既有种子回放
 *   测试的牌面全部改变。漂移用自己的流，一手开始前调用次数只取决于手数，
 *   因此仍然完全可复现，同时不碰牌局本身的确定性。
 *
 * UMD：浏览器挂到 window.Poker.makeRng，Node 下走 module.exports。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  /**
   * 造一个独立的可复现 PRNG（mulberry32）。
   * @param {number} seed 整数种子；非法/缺省时回落到默认种子，0 也被替换为默认种子。
   * @returns {function():number} 返回 [0,1) 均匀分布的伪随机函数。
   */
  function makeRng(seed) {
    var a = (typeof seed === 'number' && isFinite(seed)) ? (seed | 0) : 20250821;
    if (a === 0) a = 20250821;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  Poker.makeRng = makeRng;
  if (typeof module !== 'undefined' && module.exports) module.exports = makeRng;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
