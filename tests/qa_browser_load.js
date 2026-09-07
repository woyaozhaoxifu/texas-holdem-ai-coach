/* QA 批量C：浏览器加载路径模拟 —— 无 require/module，按 index.html 顺序 eval 全部脚本 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var D = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(D, 'index.html'), 'utf8');
var scripts = [];
var re = /<script src="(js\/[^"]+)"><\/script>/g;
var m;
while ((m = re.exec(html)) !== null) scripts.push(m[1]);
var L = [], FAIL = 0;
function ok(c, s) { if (c) L.push('  PASS - ' + s); else { L.push('  FAIL - ' + s); FAIL++; } }

// 纯浏览器风格沙箱：有 window/console、无 module/require；document 给可写 stub（元素在 body 末尾存在）
function fakeEl() {
  return {
    onclick: null, onchange: null, oninput: null, onscroll: null,
    style: {}, innerHTML: '', textContent: '', value: '', className: '',
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    setAttribute: function () {}, removeAttribute: function () {}, appendChild: function () {}, append: function () {},
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    focus: function () {}, remove: function () {}, scrollTop: 0, scrollHeight: 0
  };
}
var windowObj = { location: { search: '', href: '', hash: '', reload: function () {} } };
var sandbox = {
  window: windowObj,
  location: windowObj.location,
  console: console,
  document: {
    readyState: 'complete',
    addEventListener: function () {},
    getElementById: function () { return fakeEl(); },
    getElementsByClassName: function () { return []; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return fakeEl(); },
    body: fakeEl(), documentElement: fakeEl()
  },
  Math: Math, Date: Date, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval, JSON: JSON, Object: Object, Array: Array, Uint8Array: Uint8Array, Number: Number, String: String, Boolean: Boolean, isNaN: isNaN, parseFloat: parseFloat, parseInt: parseInt
};
sandbox.self = windowObj;
sandbox.globalThis = windowObj;
vm.createContext(sandbox);

ok(scripts.length >= 11, 'index.html 解析到 ' + scripts.length + ' 个 <script src>');
var loadErr = null, loaded = [];
for (var i = 0; i < scripts.length && !loadErr; i++) {
  var file = scripts[i];
  var code = fs.readFileSync(path.join(D, file), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: file });
    loaded.push(file);
  } catch (e) {
    loadErr = file + ': ' + e.message;
  }
}
ok(!loadErr, '按页面顺序逐文件 eval 全部通过（' + loaded.length + ' 个，' + (loadErr || '无异常') + '）');
var P = windowObj.Poker;
ok(!!P && typeof P.ICM === 'object' && typeof P.ICM.icmEquity === 'function', 'Poker.ICM 浏览器路径可用（typeof=' + (P && P.ICM && typeof P.ICM.icmEquity) + '）');
ok(!!P && typeof P.Equity === 'object' && typeof P.Equity.allinEquity === 'function', 'Poker.Equity.allinEquity 浏览器路径可用');
ok(!!P && typeof P.Brain === 'object' && typeof P.Brain.decide === 'function', 'Poker.Brain.decide 浏览器路径可用（brain 加载时 Poker.ICM 已就位不触发 treq）');
ok(!!P && typeof P.Game === 'function', 'Poker.Game 构造函数浏览器路径可用');
// 浏览器路径真算一把 ICM（防“加载了但调用崩”）
if (P && P.ICM && typeof P.ICM.icmEquity === 'function') {
  var ev = P.ICM.icmEquity([100, 100, 100], [50, 30, 20]);
  ok(Math.abs(ev[0] - 100 / 3) < 1e-9 && Math.abs(ev[0] + ev[1] + ev[2] - 100) < 1e-6, '浏览器路径 icmEquity([100,100,100],[50,30,20]) 实际可算 → [' + ev.map(function (x) { return x.toFixed(4); }).join(',') + ']');
}
// 浏览器路径真跑一次 allinEquity（河牌精确）
if (P && P.Equity && typeof P.Equity.allinEquity === 'function') {
  var h1 = [14, 0], h2 = [14, 1]; // 两 A 同点数不同花作平局底
  function mk(r, s) { return { r: r, s: s }; }
  var board5 = [mk(2, 3), mk(7, 2), mk(9, 0), mk(11, 2), mk(3, 1)];
  var eq5 = P.Equity.allinEquity([[mk(14, 0), mk(14, 1)], [mk(13, 0), mk(13, 1)]], board5, 0);
  ok(eq5[0] === 1 && eq5[1] === 0, '浏览器路径 allinEquity 河牌 AA vs KK → [' + eq5.join(',') + ']');
}
// 检查没有遗漏的“Node能跑但浏览器缺script”的新依赖：把 js 目录里所有文件与页面清单比对
var files = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(function (f) {
    var p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { walk(p); return; }
    if (/\.js$/.test(f)) files.push(path.relative(D, p).replace(/\\/g, '/'));
  });
})(path.join(D, 'js'));
var missing = files.filter(function (f) { return scripts.indexOf(f) < 0; });
ok(missing.length === 0, 'js/ 下所有文件均被 index.html 加载（无遗漏：' + (missing.length ? missing.join(',') : 'none') + '）');
fs.writeFileSync(path.join(__dirname, '_qa_browser_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
process.exit(FAIL ? 1 : 0);
