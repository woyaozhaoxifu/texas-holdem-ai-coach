/* global window, global */
/**
 * drift.js —— 策略漂移系统（Drift）。
 *
 * 从 game.js 抽出的漂移相关逻辑：漂移流的初始化与「每手围绕基准人格派生」的封装。
 * 座位数据字段
 *   seat.personality / seat.basePersonality
 * 仍然由 game.js 维护（AI 大脑读 basePersonality 取「出厂基准」），
 * 本模块只负责「漂移流怎么来」与「一次 derive 怎么调」。
 *
 * 覆盖原 game.js 两处逻辑：
 *   1. 构造函数内 driftEnabled / driftSeed / driftRng 的初始化 -> Drift.setup(config)
 *   2. applyPersonalityDrift 内的 Personalities.derive 调用     -> Drift.derive(personality, rng)
 *
 * 关键约束（沿用原注释）：
 *   漂移刻意不消费牌局主 rng，避免改变既有种子回放的牌面。漂移用自己的独立 PRNG
 *   （见 js/ai/rng.js），一手开始前调用次数只取决于手数，因此仍完全可复现。
 *
 * 循环依赖规避：本模块只 require rng.js 与 personalities.js，绝不 require game.js。
 *
 * UMD：浏览器挂到 window.Poker.Drift，Node 下走 module.exports。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  function treq(p) {
    try { return typeof require !== 'undefined' ? require(p) : null; } catch (e) { return null; }
  }

  // 漂移专用 PRNG（共享模块，避免与 game.js 循环依赖）。
  var makeRng = Poker.makeRng || treq('./rng.js');
  // 人格派生实现。
  var Personalities = Poker.Personalities || treq('./personalities.js');

  /** 漂移流的默认种子。config.driftSeed 可覆盖；config.drift=false 或环境变量
   *  POKER_NO_DRIFT=1 可整桌关闭漂移（QA 做「漂移前/后」对照时会用到）。 */
  var DEFAULT_DRIFT_SEED = 20250821;

  /** 环境变量逃生开关：浏览器下 process 不存在，静默返回 false */
  function driftEnvOff() {
    try {
      if (typeof process !== 'undefined' && process.env && process.env.POKER_NO_DRIFT === '1') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  // 最近一次 setup 的结果（让 enabled 标志在模块外也可访问）。
  var _state = { enabled: false, seed: DEFAULT_DRIFT_SEED, rng: null };

  /**
   * 初始化漂移流。
   * @param {Object} config  游戏配置（读取 config.drift / config.driftSeed）
   * @returns {{enabled:boolean, seed:number, rng:(function():number)|null}}
   */
  function setup(config) {
    config = config || {};
    _state.enabled = config.drift !== false && !driftEnvOff();
    _state.seed = typeof config.driftSeed === 'number' ? config.driftSeed : DEFAULT_DRIFT_SEED;
    _state.rng = (typeof makeRng === 'function') ? makeRng(_state.seed) : null;
    return _state;
  }

  /**
   * 围绕基准人格派生一个「带人味儿」的临时人格（包装 Personalities.derive）。
   * @param {Object} personality  基准人格（basePersonality）
   * @param {function():number} rng  漂移专用 PRNG（Drift.setup 返回的那个）
   * @returns {Object} 派生人格；Personalities 不可用时原样返回。
   */
  function derive(personality, rng) {
    if (!Personalities || typeof Personalities.derive !== 'function') return personality;
    return Personalities.derive(personality, rng);
  }

  /** 取最近一次 setup 的状态（含 enabled 标志） */
  function getState() {
    return _state;
  }

  var Drift = {
    setup: setup,
    derive: derive,
    getState: getState,
    DEFAULT_DRIFT_SEED: DEFAULT_DRIFT_SEED
  };
  // enabled 标志直接可访问：Drift.state.enabled
  Drift.state = _state;

  Poker.Drift = Drift;
  if (typeof module !== 'undefined' && module.exports) module.exports = Drift;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
