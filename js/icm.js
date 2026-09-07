/* global window, global */
/**
 * icm.js —— 锦标赛 ICM（Independent Chip Model）生存价值计算。
 * 零依赖。浏览器挂 window.Poker.ICM，Node 下 module.exports = Poker.ICM。
 *
 * icmEquity(stacks, payouts)：
 *   用 Harville 模型枚举名次顺序（≤6 座 → ≤720 种，确定性，无需蒙特卡洛），
 *   算每人「当前筹码 → 各名次概率分布」，再乘 payouts 得每人锦标赛 $EV。
 *   stacks: number[] 每人筹码（只应传「仍在争夺名次」的选手，可为 0 = 已出局/跟注输光）；
 *           payouts: number[] 名次奖金（payouts[0]=冠军；长度可短于人数，缺失视为 0）。
 *   返回 number[]，长度 = stacks.length，总 EV = Σ payouts（筹码不凭空生钱）。
 *
 *   Harville 正确姿势是「每轮按筹码比例抽一名选手拿当前名次奖金，再在剩余者中
 *   递归下一名次」——不是「抽被淘汰者」。0 筹码选手获胜概率为 0，必然沉底；
 *   若某子集全员 0 筹码（已全部出局），则他们均分剩余未发放名次奖金。
 *
 * riskPremium(stacks, payouts, i, toCall, totalPot)：
 *   评估「跟注全下可能出局」的 ICM 保守系数（简化三态模型，不建模弃牌后底池
 *   转移给对手——即偏保守、鼓励保护名次，供决策参考）。
 *   约定：stacks[i] 为决策前筹码（尚未扣 toCall）；totalPot 为「跟注并赢下后的
 *   总底池」（含你的 toCall）。
 *     - fold      ：筹码不变 stacks[i]（弃牌不付跟注，后手保留）
 *     - call&win  ：筹码变 stacks[i] + totalPot - toCall（净得整池）
 *     - call&lose ：筹码归 0（出局 → 拿剩余名次最低奖金）
 *   EV_call 盈亏平衡所需胜率 threshold = (EV_fold-EV_lose)/(EV_win-EV_lose)。
 *   返回 threshold 相对纯筹码底池赔率(toCall/totalPot) 的倍数：
 *     ≈1 表示无 ICM 压力；>1 表示因锦标赛生存价值需要「更高胜率才划算」（越接近泡沫越大）。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  /**
   * @param {number[]} stacks 每人筹码
   * @param {number[]} payouts 名次奖金（payouts[0]=第1名；可短于人数）
   * @return {number[]} 每人锦标赛 $EV
   */
  function icmEquity(stacks, payouts) {
    var n = stacks.length;
    var ev = new Array(n);
    var i;
    for (i = 0; i < n; i++) ev[i] = 0;
    if (n === 0) return ev;
    if (n === 1) { ev[0] = (payouts[0] || 0); return ev; }

    var all = [];
    for (i = 0; i < n; i++) all.push(i);

    // Harville：每轮按筹码比例抽「当前名次得主」，再递归给剩余者发下一名次。
    // 0 筹码选手 p=0 永远抽不中 → 自然沉底到最后。
    function rec(alive, place, mult) {
      var L = alive.length;
      if (L === 1) { ev[alive[0]] += mult * (payouts[place] || 0); return; }
      var t = 0, k;
      for (k = 0; k < L; k++) t += Math.max(0, stacks[alive[k]]);
      if (t <= 0) {
        // 剩余全是 0 筹码（全出局）→ 均分剩余奖金（对称）
        var share = 0, q;
        for (q = 0; q < L; q++) share += (payouts[place + q] || 0);
        share /= L;
        for (k = 0; k < L; k++) ev[alive[k]] += mult * share;
        return;
      }
      var prize = payouts[place] || 0;
      for (k = 0; k < L; k++) {
        var p = Math.max(0, stacks[alive[k]]) / t;
        if (p <= 0) continue;                 // 0 筹码不会拿当前名次
        if (prize > 0) ev[alive[k]] += mult * p * prize;
        var next = [];
        var j;
        for (j = 0; j < L; j++) if (alive[j] !== alive[k]) next.push(alive[j]);
        rec(next, place + 1, mult * p);
      }
    }
    rec(all, 0, 1);
    return ev;
  }

  /**
   * @param {number[]} stacks 每人当前筹码（只含仍在争夺名次的选手）
   * @param {number[]} payouts 名次奖金
   * @param {number} i 自己座位号
   * @param {number} toCall 需跟注额（未扣；视为全下风险额）
   * @param {number} totalPot 跟注并赢下后的总底池（含自己的 toCall）
   * @return {number} ICM 保守系数（≈1 无压力，>1 需更高胜率）
   */
  function riskPremium(stacks, payouts, i, toCall, totalPot) {
    var n = stacks.length;
    if (i < 0 || i >= n) return 1;
    var base = Math.max(0, stacks[i] || 0);
    var call = Math.max(0, toCall || 0);
    var pot = Math.max(0, totalPot || 0);
    function myEv(chipsI) {
      var c = stacks.slice();
      c[i] = Math.max(0, chipsI);
      var e = icmEquity(c, payouts);
      return e[i] || 0;
    }
    var evFold = myEv(base);              // 弃牌：后手不变
    var evWin = myEv(base + pot - call);  // 跟注并赢：净得整池（先扣自己的跟注）
    var evLose = myEv(0);                 // 跟注输光：出局 → 拿剩余最低名次
    var denom = evWin - evLose;
    var threshold = denom > 1e-9 ? Math.max(0, (evFold - evLose) / denom) : 1;
    var chipOdds = pot > 1e-9 ? call / pot : 1;
    var premium = chipOdds > 1e-9 ? threshold / chipOdds : 1;
    return premium;
  }

  var ICM = {
    icmEquity: icmEquity,
    riskPremium: riskPremium
  };

  Poker.ICM = ICM;
  if (typeof module !== 'undefined' && module.exports) module.exports = ICM;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
