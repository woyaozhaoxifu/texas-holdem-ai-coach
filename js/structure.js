/* global window, global */
/**
 * structure.js —— 锦标赛赛制结构（单一数据源）。
 * 零依赖。浏览器挂 window.Poker.Structures，Node 下 module.exports。
 *
 * 背景：盲注表原先在 game.js 与 ui.js 各存一份同值副本（硬伤）。
 * 现在统一由本文件提供，两边都从 window.Poker.Structures 读取。
 *
 * 每个结构对象字段：
 *   id / name / startStack / levels[{sb,bb,ante}] / handsPerLevel
 *   payoutPct（进圈比例）/ allowReentry / reentryUntilLevel / reentryMax / awardRule
 *   —— ante 每级显式写死数值，便于调表与测试断言（不再运行时推算）。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  var DEFAULT_ID = 'fast';

  /** 名次积分默认规则（进圈者按名次给分，未进圈 0） */
  var DEFAULT_AWARD = [5, 3, 1];

  /**
   * 标准名次奖金拆分（百分比，合计 100）。下标 = 进圈人数 - 1。
   * 3 人档 [50,30,20] 与改造前 ui.js 硬编码的 payouts 完全一致（回归不变量）。
   */
  var PAYOUT_SPLITS = [
    [100],
    [65, 35],
    [50, 30, 20],
    [40, 30, 20, 10],
    [38, 26, 18, 11, 7],
    [34, 24, 17, 12, 8, 5]
  ];

  var STRUCTURES = {
    // ---- 快节奏：与改造前行为逐项一致（回归不变量）----
    fast: {
      id: 'fast',
      name: '快节奏 · 标准赛',
      desc: '起始 2000（100BB），15 手升一级，第 6 级起 Ante = BB×10% 取整到 5，进圈 3 人，不可重入。',
      startStack: 2000,
      handsPerLevel: 15,
      payoutPct: 0.5,        // 6 人 × 50% → 进圈 3 人
      allowReentry: false,
      reentryUntilLevel: 0,
      reentryMax: 0,
      awardRule: [5, 3, 1],
      levels: [
        { sb: 10, bb: 20, ante: 0 },
        { sb: 15, bb: 30, ante: 0 },
        { sb: 25, bb: 50, ante: 0 },
        { sb: 40, bb: 80, ante: 0 },
        { sb: 60, bb: 120, ante: 0 },
        { sb: 100, bb: 200, ante: 20 },
        { sb: 150, bb: 300, ante: 30 },
        { sb: 250, bb: 500, ante: 50 },
        { sb: 400, bb: 800, ante: 80 },
        { sb: 600, bb: 1200, ante: 120 }
      ]
    },

    // ---- KPC 深筹：慢升盲 + 深起始筹码 + 中前期 Ante + 更狠的钱圈 ----
    kpc: {
      id: 'kpc',
      name: 'KPC 深筹 · 慢升盲',
      desc: '起始 6000（300BB），20 手升一级，第 4 级起 Ante = BB×12.5% 取整到 5，进圈 2 人（33%），第 3 级前可重入 1 次。',
      startStack: 6000,
      handsPerLevel: 20,
      payoutPct: 0.15,       // 6 人 × 15% → round(0.9)=1 → 下限 2 人
      allowReentry: true,
      reentryUntilLevel: 3,
      reentryMax: 1,
      awardRule: [5, 3, 1],
      levels: [
        { sb: 10, bb: 20, ante: 0 },
        { sb: 15, bb: 30, ante: 0 },
        { sb: 25, bb: 50, ante: 0 },
        { sb: 40, bb: 80, ante: 10 },
        { sb: 60, bb: 120, ante: 15 },
        { sb: 100, bb: 200, ante: 25 },
        { sb: 150, bb: 300, ante: 40 },
        { sb: 200, bb: 400, ante: 50 },
        { sb: 300, bb: 600, ante: 75 },
        { sb: 400, bb: 800, ante: 100 },
        { sb: 600, bb: 1200, ante: 150 },
        { sb: 800, bb: 1600, ante: 200 }
      ]
    }
  };

  /** 取结构（未知 id 退回 fast） */
  function get(id) {
    return STRUCTURES[id] || STRUCTURES[DEFAULT_ID];
  }

  /** 全部结构（供 UI 下拉） */
  function all() {
    return [STRUCTURES.fast, STRUCTURES.kpc];
  }

  /**
   * 进圈人数：max(2, round(参赛人数 × payoutPct))，且不超过参赛人数。
   * 6 人桌：fast 0.5 → 3 人；kpc 0.15 → round(0.9)=1 → 下限 2 人。
   */
  function inMoneyCount(st, nPlayers) {
    var s = st || get(DEFAULT_ID);
    var n = Number(nPlayers) || 0;
    if (n <= 0) return 0;
    var pct = (typeof s.payoutPct === 'number') ? s.payoutPct : 0.5;
    var m = Math.max(2, Math.round(n * pct));
    return Math.min(m, n);
  }

  /** 名次奖金拆分（百分比数组，合计 100），长度 = 进圈人数 */
  function payoutsFor(st, nPlayers) {
    var n = inMoneyCount(st, nPlayers);
    if (n <= 0) return [];
    var splits = PAYOUT_SPLITS[n - 1];
    if (splits) return splits.slice();
    // 超过预置档位：按 0.55 等比递减后归一化到 100
    var raw = [], total = 0, i;
    for (i = 0; i < n; i++) { var v = Math.pow(0.55, i); raw.push(v); total += v; }
    var out = [];
    for (i = 0; i < n; i++) out.push(Math.round(raw[i] / total * 100));
    return out;
  }

  /** 名次积分：awardRule 按进圈人数截断（fast 3 人 → [5,3,1]；kpc 2 人 → [5,3]） */
  function awardFor(st, nPlayers) {
    var s = st || get(DEFAULT_ID);
    var rule = (s.awardRule && s.awardRule.length) ? s.awardRule : DEFAULT_AWARD;
    var n = inMoneyCount(s, nPlayers);
    return rule.slice(0, Math.min(rule.length, n));
  }

  /** 该级别是否允许重入（级别从 1 起） */
  function canReenterAt(st, level) {
    var s = st || get(DEFAULT_ID);
    if (!s.allowReentry) return false;
    return level <= (s.reentryUntilLevel || 0);
  }

  var Structures = {
    DEFAULT_ID: DEFAULT_ID,
    DEFAULT_AWARD: DEFAULT_AWARD,
    get: get,
    all: all,
    inMoneyCount: inMoneyCount,
    payoutsFor: payoutsFor,
    awardFor: awardFor,
    canReenterAt: canReenterAt
  };

  Poker.Structures = Structures;
  if (typeof module !== 'undefined' && module.exports) module.exports = Structures;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
