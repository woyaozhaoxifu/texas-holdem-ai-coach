/* global importScripts, self, postMessage */
/**
 * equity.worker.js —— 蒙特卡洛胜率后台线程（经典 Worker，UMD / Worker 安全）。
 *
 * 由 equity.js 的 computeAsync 通过 `new Worker('js/equity.worker.js')` 创建。
 * 仅 import handEval.js + equity.js 核心（挂在 self.Poker 上），在后台线程跑重计算，
 * 避免主线程在深筹码 KPC 场景被 oddsPanel / handStrength 卡死。
 *
 * 消息协议：
 *   接收  { type:'handStrength'|'oddsPanel', id, payload }
 *   发出  { type, id, result } 或 { type, id, error }
 * 注意：payload 中的 rng（函数）无法跨 Worker 结构化克隆，UI 调用不传 rng（用内部随机源）。
 */
(function () {
  'use strict';

  importScripts('handEval.js', 'equity.js');

  var Poker = self.Poker || (typeof globalThis !== 'undefined' ? globalThis.Poker : null);

  self.onmessage = function (e) {
    var msg = (e && e.data) || {};
    var payload = msg.payload || {};
    var Equity = Poker && Poker.Equity;
    if (!Equity) {
      self.postMessage({ type: msg.type, id: msg.id, error: 'no-equity' });
      return;
    }
    try {
      if (msg.type === 'handStrength') {
        var hs = Equity.handStrength(payload.hole, payload.board, payload.numOpponents, payload.iterations, payload.rng);
        self.postMessage({ type: 'handStrength', id: msg.id, result: hs });
      } else if (msg.type === 'oddsPanel') {
        var op = Equity.oddsPanel(payload.hole, payload.board, payload.numOpponents, payload.iterations, payload.rng);
        self.postMessage({ type: 'oddsPanel', id: msg.id, result: op });
      } else {
        self.postMessage({ type: msg.type, id: msg.id, error: 'unknown-type' });
      }
    } catch (err) {
      self.postMessage({
        type: msg.type,
        id: msg.id,
        error: String((err && err.message) || err)
      });
    }
  };
})();
