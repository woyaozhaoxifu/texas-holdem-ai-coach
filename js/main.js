/* global window */
/**
 * main.js —— 入口：DOM 就绪后启动 App。
 */
(function () {
  'use strict';
  function boot() {
    window.Poker.App.init();
    // 自动化测试用：URL 加上 ?autostart 可跳过选桌直接开始（默认选中 5 个 AI）
    if (window.location.search.indexOf('autostart') >= 0) {
      setTimeout(function () {
        window.Poker.App.selected = ['fish', 'rock', 'tag', 'lag', 'solver'];
        window.Poker.App.startTable(window.Poker.App.selected);
      }, 50);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
