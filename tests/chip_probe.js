/* 筹码面额探针：App.chipBreakdown 纯函数（贪心拆解，只含 n>0 的面额） */
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

// DOM stub（同 raise_stepper_probe：同 id 返回同一对象）
var reg = {};
function fakeEl(id) {
  if (reg[id]) return reg[id];
  var e = {
    id: id, dataset: {}, innerHTML: '', textContent: '', value: '',
    min: '', max: '', disabled: false, className: '',
    style: { setProperty: function (k, v) { this[k] = v; }, removeProperty: function () {}, getPropertyValue: function (k) { return this[k] || ''; } },
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    setAttribute: function () {}, removeAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function () {}, append: function () {}, remove: function () {},
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    focus: function () {}, click: function () {},
    clientWidth: 1280, clientHeight: 1000, scrollTop: 0, scrollHeight: 0
  };
  reg[id] = e;
  return e;
}
var windowObj = { location: { search: '', href: '', hash: '', reload: function () {} } };
var sandbox = {
  window: windowObj, location: windowObj.location, console: console,
  document: {
    readyState: 'complete',
    addEventListener: function () {},
    getElementById: function (id) { return fakeEl(id); },
    getElementsByClassName: function () { return []; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return fakeEl('__tmp' + Math.random()); },
    body: fakeEl('__body'), documentElement: fakeEl('__html')
  },
  Math: Math, Date: Date, setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval, JSON: JSON,
  Object: Object, Array: Array, Uint8Array: Uint8Array, Number: Number,
  String: String, Boolean: Boolean, isNaN: isNaN, isFinite: isFinite,
  parseFloat: parseFloat, parseInt: parseInt
};
sandbox.self = windowObj;
sandbox.globalThis = windowObj;
vm.createContext(sandbox);
scripts.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(D, f), 'utf8'), sandbox, { filename: f }); });

var App = windowObj.Poker.App;
ok(!!App, 'Poker.App 已挂载');
ok(typeof App.chipBreakdown === 'function', 'App.chipBreakdown 存在');

function fmt(parts) {
  return '[' + parts.map(function (p) { return '{v:' + p.v + ',n:' + p.n + '}'; }).join(',') + ']';
}
function sum(parts) {
  var t = 0;
  parts.forEach(function (p) { t += p.v * p.n; });
  return t;
}
function expect(amount, want) {
  var got = App.chipBreakdown(amount);
  ok(fmt(got) === want, 'chipBreakdown(' + amount + ') → ' + want + '（实际 ' + fmt(got) + '）');
}

// ---- 1) 无效 / 边界输入一律 [] ----
expect(0, '[]');
expect(-1, '[]');
expect(-5, '[]');
expect(-2000, '[]');
expect(NaN, '[]');
expect(undefined, '[]');
expect(null, '[]');
expect('abc', '[]');
expect('', '[]');

// ---- 2) 精确期望（含派单点名的 5 / 10 / 20 / 120 / 2000 / 99999）----
expect(5, '[{v:5,n:1}]');
expect(10, '[{v:5,n:2}]');
expect(20, '[{v:5,n:4}]');
expect(25, '[{v:25,n:1}]');
expect(100, '[{v:100,n:1}]');
expect(120, '[{v:100,n:1},{v:5,n:4}]');
expect(500, '[{v:500,n:1}]');
expect(525, '[{v:500,n:1},{v:25,n:1}]');
expect(1000, '[{v:1000,n:1}]');
expect(2000, '[{v:1000,n:2}]');
expect(99999, '[{v:1000,n:99},{v:500,n:1},{v:100,n:4},{v:25,n:3},{v:5,n:4}]');

// ---- 3) 通用性质：总额守恒（余数必小于最小面额 5）、只含 n>0、面额降序 ----
[5, 7, 10, 20, 33, 120, 678, 2000, 99999].forEach(function (a) {
  var parts = App.chipBreakdown(a);
  var s = sum(parts);
  ok(s <= a && (a - s) < 5,
    'chipBreakdown(' + a + ') 总额守恒：Σ=' + s + '，余 ' + (a - s) + '（< 最小面额 5）');
  ok(parts.every(function (p) { return p.n > 0; }),
    'chipBreakdown(' + a + ') 只含 n>0 的面额');
  var desc = true;
  for (var i = 1; i < parts.length; i++) if (parts[i].v > parts[i - 1].v) desc = false;
  ok(desc, 'chipBreakdown(' + a + ') 面额从大到小排列');
});

// ---- 4) 常见注码 / 起始筹码必须能被面额体系精确表示（10=2×5，20=4×5，2000=2×1000）----
[10, 20, 30, 40, 60, 80, 100, 120, 150, 200, 300, 500, 1000, 2000].forEach(function (a) {
  ok(sum(App.chipBreakdown(a)) === a,
    '常见注码 ' + a + ' 可精确拆解（Σ=' + sum(App.chipBreakdown(a)) + '）');
});

// ---- 5) 底池摞的上限保护：单摞最多显示 5 枚（renderPotChips 用 min(n,5) 截断）----
var bigFirst = App.chipBreakdown(100000)[0];
ok(Math.min(bigFirst.n, 5) === 5, '超大额首摞显示枚数被截断到 5（实际 n=' + bigFirst.n + ' → 显示 ' + Math.min(bigFirst.n, 5) + '）');
ok(App.chipBreakdown(100000).length <= 5, '摞数不超过面额种数 5');

fs.writeFileSync(path.join(__dirname, '_chip_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
console.log(L.join('\n'));
console.log('FAILED=' + FAIL);
process.exit(FAIL ? 1 : 0);
