/* global window, global */
/**
 * relations.js —— 关系系统（Relations）。
 *
 * 从 game.js 抽出的纯函数式关系操作。座位数据字段
 *   seat.relations            // { 对手id: 关系值 } 负=记恨，正=觉得好欺负
 * 仍然由 game.js 维护（AI 大脑直接读这些字段），本模块只提供「如何读写它们」的逻辑，
 * 不持有任何状态。
 *
 * 覆盖原 game.js 四处逻辑：
 *   1. 关系读取（Game.prototype.relationOf 的读取表达式） -> Relations.get(seat, otherId)
 *   2. 关系增量更新（updateRelations 内 clampRel(...)）    -> Relations.update(attacker, victim, delta)
 *   3. 关系随时间的衰减（startHand 内 relations decay 循环）-> Relations.decay(seats)
 *   4. 关系表浅拷贝（helper）                               -> Relations.all(seat)
 *
 * 原 game.js 的 clampRel（夹紧到 [-100,100] 并四舍五入）一并迁入本模块私有实现。
 * 行为与原 game.js 完全一致。
 *
 * UMD：浏览器挂到 window.Poker.Relations，Node 下走 module.exports。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  /** 关系值夹紧到 [-100, 100] 并四舍五入（原 game.js clampRel） */
  function clampRel(v) {
    return Math.max(-100, Math.min(100, Math.round(v)));
  }

  /**
   * 读取某座位对 otherId 的关系值（缺省 0）。
   * @param {Object} seat
   * @param {string} otherId
   * @returns {number}
   */
  function get(seat, otherId) {
    return (seat && seat.relations && seat.relations[otherId]) || 0;
  }

  /**
   * 更新 attacker 对 victim 的关系值（增量叠加 + 夹紧）。
   * 原 game.js：attacker.relations[victim.id] = clampRel((attacker.relations[victim.id] || 0) + delta)
   * @param {Object} attacker  关系持有方座位
   * @param {Object} victim    关系指向方座位（需 .id）
   * @param {number} delta     增量（已含波动率权重）
   */
  function update(attacker, victim, delta) {
    if (!attacker || !attacker.relations || !victim) return;
    attacker.relations[victim.id] = clampRel((attacker.relations[victim.id] || 0) + delta);
  }

  /**
   * 关系随时间淡忘（原 game.js startHand 内 relations decay 循环，整桌一次性衰减）。
   * 每手开始时对每个存活座位的 relations 做 *0.97 衰减，绝对值 < 5 直接淡忘（删除）。
   * @param {Array<Object>} seats
   */
  function decay(seats) {
    if (!seats) return;
    for (var i = 0; i < seats.length; i++) {
      var rel = seats[i] && seats[i].relations;
      if (!rel) continue;
      for (var rid in rel) {
        if (!Object.prototype.hasOwnProperty.call(rel, rid)) continue;
        var rv = Math.round(rel[rid] * 0.97);
        if (Math.abs(rv) < 5) delete rel[rid];
        else rel[rid] = rv;
      }
    }
  }

  /**
   * 返回某座位关系表的浅拷贝（helper，供 AI 大脑快照/序列化用）。
   * @param {Object} seat
   * @returns {Object}
   */
  function all(seat) {
    var out = {};
    if (seat && seat.relations) {
      for (var k in seat.relations) {
        if (Object.prototype.hasOwnProperty.call(seat.relations, k)) out[k] = seat.relations[k];
      }
    }
    return out;
  }

  var Relations = {
    get: get,
    update: update,
    decay: decay,
    all: all
  };

  Poker.Relations = Relations;
  if (typeof module !== 'undefined' && module.exports) module.exports = Relations;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
