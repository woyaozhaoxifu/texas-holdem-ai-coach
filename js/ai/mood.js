/* global window, global */
/**
 * mood.js —— 情绪系统（Mood）。
 *
 * 从 game.js 抽出的纯函数式情绪操作。座位数据字段
 *   seat.mood / seat.moodLabel / seat.moodEvent
 * 仍然由 game.js 维护（AI 大脑直接读这些字段），本模块只提供「如何更新它们」的逻辑，
 * 不持有任何状态。
 *
 * 覆盖原 game.js 三处逻辑：
 *   1. Personalities.moodLabel(m)        -> Mood.label(m)
 *   2. Game.prototype.updateMood(...)    -> Mood.applyHandResult(seat, ctx)
 *   3. startHand 内「情绪随时间回归平静」 -> Mood.decay(seat)
 *
 * 行为与原 game.js 完全一致（含 'mood' 事件形状 {seat,name,mood,label,event}）。
 *
 * UMD：浏览器挂到 window.Poker.Mood，Node 下走 module.exports。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  function treq(p) {
    try { return typeof require !== 'undefined' ? require(p) : null; } catch (e) { return null; }
  }

  // 需要 Personalities.moodLabel 作为标签来源；缺失时退化为内联实现（与人格表一致）。
  var Personalities = Poker.Personalities || treq('./personalities.js');

  /**
   * 情绪值(-100..100) -> 中文标签（原 Personalities.moodLabel 逻辑，逐字保留）。
   * @param {number} mood
   * @returns {string}
   */
  function label(mood) {
    if (Personalities && typeof Personalities.moodLabel === 'function') return Personalities.moodLabel(mood);
    // 兜底：与 Personalities.moodLabel 完全一致的复刻，保证 Personalities 未加载时也不崩。
    if (mood >= 60) return '得意';
    if (mood >= 25) return '愉悦';
    if (mood <= -60) return '上头';
    if (mood <= -25) return '烦躁';
    return '平静';
  }

  /**
   * 某 AI 座位在一手结束后结算情绪（原 game.js Game.prototype.updateMood）。
   *
   * @param {Object} seat  AI 座位对象（需含 mood/moodLabel/moodEvent/index/name/personality/consecutiveLosses）
   * @param {Object} ctx   上下文：
   *   - won        {boolean} 本手是否赢钱
   *   - wasAggressor {boolean} 本手最后一手行动是否为 raise / allin
   *   - handRank   {number}  -1 表示无摊牌排名；0..8 为牌力排名
   *   - delta      {number}  本手筹码净增减（win - committed）
   *   - bigBlind   {number}  大盲注（阈值判断用）
   *   - vol        {number=} 情绪波动系数；缺省时按 seat.personality.moodVolatility 计算（与原文一致）
   *   - emit       {function=} 事件发射器；传入则按原 shape 发出 'mood' 事件
   *
   * 行为与原 updateMood 完全一致：
   *   - |delta| <= bigBlind*3 时仅轻微衰减、不发事件直接返回；
   *   - 否则按输赢/牌力/激进度调整 mood，夹紧到 [-100,100]，刷新 moodLabel；
   *   - 仅在情绪标签跨越时记录 moodEvent；
   *   - 当 ev 非空时发出 {seat,name,mood,label,event} 事件。
   */
  function applyHandResult(seat, ctx) {
    ctx = ctx || {};
    var vol = seat.personality ? (seat.personality.moodVolatility || 0.3) : 0.3;
    if (typeof ctx.vol === 'number') vol = ctx.vol; // 调用方显式覆盖（默认与上式一致）
    var bigBlind = ctx.bigBlind || 0;

    var before = seat.mood || 0;
    var ev = '';

    // 盲注级别的正常损耗不值得动情绪，只有真正的输赢大池才影响心态
    if (Math.abs(ctx.delta) <= bigBlind * 3) {
      seat.mood = Math.round((seat.mood || 0) * 0.9);
      seat.moodLabel = label(seat.mood);
      return;
    }

    if (ctx.delta > 0) {
      seat.mood += (12 + Math.min(32, ctx.delta / 15)) * (0.4 + vol);
      if (ctx.won && ctx.wasAggressor && ctx.handRank >= 0 && ctx.handRank <= 1) { seat.mood += 14 * vol; ev = '偷鸡得手，飘了'; }
      else if (ctx.won && ctx.handRank >= 6) { seat.mood += 9 * vol; ev = '大牌收池，心情不错'; }
      if (!ev && ctx.delta > bigBlind * 8) ev = '赢下大池，士气大振';
    } else if (ctx.delta < 0) {
      seat.mood -= (12 + Math.min(32, -ctx.delta / 15)) * (0.4 + vol);
      if (ctx.handRank >= 5 && !ctx.won) { seat.mood -= 22 * vol; ev = '被 bad beat，心态炸了'; }
      else if (ctx.wasAggressor && ctx.handRank >= 0 && ctx.handRank <= 1) { seat.mood -= 11 * vol; ev = '诈唬被抓，恼火'; }
      else if (seat.consecutiveLosses >= 3) { seat.mood -= 12 * vol; ev = '连败不止，越打越急'; }
      if (!ev && -ctx.delta > bigBlind * 8) ev = '输掉大池，陷入低谷';
    }

    seat.mood = Math.max(-100, Math.min(100, Math.round(seat.mood)));
    seat.moodLabel = label(seat.mood);

    // 只在情绪状态发生跨越时记录事件（供 UI 冒泡显示）
    if (ev && label(before) !== seat.moodLabel) seat.moodEvent = ev;
    else if (!ev) seat.moodEvent = '';
    if (ev && typeof ctx.emit === 'function') {
      ctx.emit('mood', { seat: seat.index, name: seat.name, mood: seat.mood, label: seat.moodLabel, event: ev });
    }
  }

  /**
   * 周期情绪衰减（原 game.js startHand 内「情绪随时间回归平静」）。
   * 直接就地修改 seat.mood / seat.moodLabel。
   * @param {Object} seat
   */
  function decay(seat) {
    if (seat.mood) {
      seat.mood = Math.round(seat.mood * 0.82);
      // 极端情绪会随时间平复，避免永久上头
      if (seat.mood < -40) seat.mood += 7;
      else if (seat.mood > 40) seat.mood -= 5;
      if (Math.abs(seat.mood) < 3) seat.mood = 0;
      seat.moodLabel = label(seat.mood);
    }
  }

  var Mood = {
    label: label,
    applyHandResult: applyHandResult,
    decay: decay
  };

  Poker.Mood = Mood;
  if (typeof module !== 'undefined' && module.exports) module.exports = Mood;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
