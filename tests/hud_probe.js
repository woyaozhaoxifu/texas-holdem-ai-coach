/* C2 对手 HUD 探针：hudData/hudBadgeHtml 纯函数派生 + 源码静态自检
 * 说明：renderSeats 依赖 DOM，Node 无法真跑浏览器；
 * 采用「把 HUD 派生逻辑做成可单测纯函数 + 断言 ui.js/style.css 含 .hud-mini 模板」的静态路径。 */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
var fs = require('fs');
// ui.js 的 UMD root 取 window；Node 下给 global 起个别名即可在不碰 DOM 的情况下加载
global.window = global;
['cards.js', 'handEval.js', 'equity.js', 'ai/personalities.js', 'coach.js', 'review.js', 'ui.js'].forEach(function (f) {
  require(path.join(D, 'js', f));
});
var App = global.Poker.App;

var L = [], FAIL = 0;
function log(s) { L.push(s); }
function ok(cond, msg) {
  if (cond) log('  PASS - ' + msg);
  else { log('  FAIL - ' + msg); FAIL++; }
}
function seat(stats) { return { isHuman: false, stats: stats }; }

log('== A hudData 派生（hands<5 → –；≥5 → 百分比；分母 0 → –）==');
ok(!!App && typeof App.hudData === 'function', 'ui.js 在 Node 环境可加载且暴露 App.hudData');
var h1 = App.hudData(seat({ hands: 3, vpip: 2, pfr: 1, cBetFaced: 0, foldToCBet: 0, showdowns: 0 }));
ok(!!h1 && h1.vpip === '–' && h1.pfr === '–', 'hands=3（<5）→ 入池/加注显示 –');
var h2 = App.hudData(seat({ hands: 5, vpip: 2, pfr: 1, cBetFaced: 4, foldToCBet: 2, showdowns: 3 }));
ok(!!h2 && h2.vpip === '40%' && h2.pfr === '20%', 'hands=5 边界：vpip=2/5→40%、pfr=1/5→20%');
ok(!!h2 && h2.f2c === '50%', 'foldToCBet=2/4→50%');
var h3 = App.hudData(seat({ hands: 10, vpip: 3, pfr: 1, cBetFaced: 0, foldToCBet: 0, showdowns: 1 }));
ok(!!h3 && h3.f2c === '–', 'cBetFaced=0 → 弃c-bet 显示 –（分母 0）');
ok(!!h3 && h3.tooltip.indexOf('手数 10') >= 0 && h3.tooltip.indexOf('摊牌 1') >= 0, 'tooltip 含完整统计（手数/摊牌等）');
ok(App.hudData(null) === null, '无 stats → null（不渲染）');

log('== B hudBadgeHtml 徽标串 ==');
var b = App.hudBadgeHtml(h2);
ok(b.indexOf('hud-mini') >= 0 && b.indexOf('入池 40%') >= 0 && b.indexOf('加注 20%') >= 0, '徽标 HTML 含 .hud-mini 与两格文本');
ok(App.hudBadgeHtml(null) === '', '空 hud → 空串');

log('== C 静态自检（模板落点：seatEl 只在 bot 名下插入）==');
var src = fs.readFileSync(path.join(D, 'js', 'ui.js'), 'utf8');
ok(src.indexOf('hud-mini') >= 0 && src.indexOf('App.hudData') >= 0 && src.indexOf('App.hudBadgeHtml') >= 0 && src.indexOf('!s.isHuman') >= 0,
  'ui.js 源码：App.hudData/App.hudBadgeHtml 定义 + .hud-mini 输出 + 仅非人类渲染（静态依据）');
var css = fs.readFileSync(path.join(D, 'css', 'style.css'), 'utf8');
ok(css.indexOf('.hud-mini') >= 0, 'style.css 定义 .hud-mini 暗色小字样式');
var bad = App.hudData(seat({ hands: 5, vpip: 1, pfr: 0, cBetFaced: 0, foldToCBet: 0, showdowns: 0 }));
ok(bad.vpip === '20%' && bad.pfr === '0%', '边界：1/5→20%、0/5→0%（非 –，因为 hands≥5）');

fs.writeFileSync(path.join(__dirname, '_hud_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL ? 1 : 0);
