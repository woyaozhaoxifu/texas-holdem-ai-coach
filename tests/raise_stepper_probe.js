/* 加注步进器探针：±10 / ±100 按钮 + 数字输入 clamp 行为 */
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

// 带 id 记忆的 DOM stub：同 id 返回同一对象，支持 dataset/min/max/value/disabled
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
  String: String, Boolean: Boolean, isNaN: isNaN, parseFloat: parseFloat, parseInt: parseInt
};
sandbox.self = windowObj;
sandbox.globalThis = windowObj;
vm.createContext(sandbox);
scripts.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(D, f), 'utf8'), sandbox, { filename: f }); });

var App = windowObj.Poker.App;
ok(!!App, 'Poker.App 已挂载');

var num = fakeEl('raiseInput');
num.min = '60'; num.max = '2000'; num.value = '200';
App.syncRaise(true);
ok(num.value === 200, '初始 200 在区间内 → 保持 200（实际 ' + num.value + '）');

App.stepRaise(10);
ok(num.value === 210, '+10 → 210（实际 ' + num.value + '）');
App.stepRaise(100);
ok(num.value === 310, '+100 → 310（实际 ' + num.value + '）');
App.stepRaise(-10);
ok(num.value === 300, '-10 → 300（实际 ' + num.value + '）');
App.stepRaise(-100);
ok(num.value === 200, '-100 → 200（实际 ' + num.value + '）');

// 下界 clamp：连点 -100 不会低于 min
App.stepRaise(-100); App.stepRaise(-100); App.stepRaise(-100);
ok(num.value === 60, '连点 -100 下界 clamp 到 min=60（实际 ' + num.value + '）');
// 上界 clamp：从 60 连点 +100 到顶
for (var i = 0; i < 40; i++) App.stepRaise(100);
ok(num.value === 2000, '连点 +100 上界 clamp 到 max=2000（实际 ' + num.value + '）');
// 顶部再点 +10 不越界
App.stepRaise(10);
ok(num.value === 2000, '触顶后 +10 仍为 2000（实际 ' + num.value + '）');

// 手动输入越界 → syncRaise(true) 回写 clamp
num.value = '99999'; App.syncRaise(true);
ok(num.value === 2000, '手动输入 99999 → clamp 2000（实际 ' + num.value + '）');
num.value = '1'; App.syncRaise(true);
ok(num.value === 60, '手动输入 1 → clamp 60（实际 ' + num.value + '）');
// 输入过程中不回写（writeBack=false）但 dataset 已 clamp
num.value = '5';
App.syncRaise(false);
ok(String(num.value) === '5' && String(num.dataset.value) === '60', '输入中不回写：value 保持 "5"，dataset clamp 为 60（value=' + num.value + ', dataset=' + num.dataset.value + '）');

// raiseAmount 读 dataset
num.value = '500'; App.syncRaise(true);
ok(App.raiseAmount() === 500, 'raiseAmount() 读回 500（实际 ' + App.raiseAmount() + '）');

// 四个按钮 handler 已绑定且可用（模拟点击）
App.stepRaise = App.stepRaise; // no-op guard
var before = App.raiseAmount();
fakeEl('btnPlus100').onclick && fakeEl('btnPlus100').onclick();
ok(App.raiseAmount() === before + 100, 'btnPlus100 已绑定 onclick，点击 +100（' + before + '→' + App.raiseAmount() + '）');
fakeEl('btnMinus10').onclick && fakeEl('btnMinus10').onclick();
ok(App.raiseAmount() === before + 90, 'btnMinus10 已绑定 onclick，点击 -10（→' + App.raiseAmount() + '）');
ok(typeof fakeEl('btnPlus10').onclick === 'function', 'btnPlus10 handler 存在');
ok(typeof fakeEl('btnMinus100').onclick === 'function', 'btnMinus100 handler 存在');

// disableControls 能一并禁用步进按钮
App.disableControls(true);
ok(fakeEl('btnPlus10').disabled === true && fakeEl('btnMinus100').disabled === true && num.disabled === true,
  'disableControls(true) 同时禁用 ±10/±100 与输入框');
App.disableControls(false);
ok(fakeEl('btnPlus10').disabled === false && num.disabled === false, 'disableControls(false) 恢复可用');

fs.writeFileSync(path.join(__dirname, '_raise_stepper_out.txt'), L.join('\n') + '\nFAILED=' + FAIL + '\n');
console.log(L.join('\n'));
console.log('FAILED=' + FAIL);
process.exit(FAIL ? 1 : 0);
