/* verify_suitcolors: 四花色四色(♠黑♥红♦蓝♣绿) + 渲染接线一致 */
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..'); const PORT = 8806;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const L = []; let FAIL = 0;
function ok(c, s) { if (c) L.push('  PASS - ' + s); else { L.push('  FAIL - ' + s); FAIL++; } }
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#persGrid', { timeout: 8000 });

  // ① 四色 computed color 断言（直接注入 4 张卡）
  var colors = await page.evaluate(function () {
    var sym = window.Poker.Cards.SUIT_SYMBOLS;
    var cls = ['spade', 'heart', 'diamond', 'club'];
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:99999;display:flex;';
    var els = {};
    cls.forEach(function (c) {
      var d = document.createElement('span');
      d.className = 'card small ' + c;
      d.innerHTML = '<span class="r">A</span><span class="s"></span>';
      box.appendChild(d); els[c] = d;
    });
    document.body.appendChild(box);
    var res = {};
    Object.keys(els).forEach(function (c) { res[c] = getComputedStyle(els[c]).color; });
    box.remove();
    return res;
  });
  var expect = { spade: 'rgb(32, 36, 47)', heart: 'rgb(211, 32, 41)', diamond: 'rgb(29, 99, 216)', club: 'rgb(23, 138, 78)' };
  var allMatch = Object.keys(expect).every(function (c) { return colors[c] === expect[c]; });
  ok(allMatch, '四花色 CSS 颜色命中预期（' + JSON.stringify(colors) + '）');
  var distinct = new Set(Object.keys(colors).map(function (c) { return colors[c]; })).size;
  ok(distinct === 4, '四花色颜色两两不同（实测 ' + distinct + ' 种）');

  // ② 实机接线：开桌后 mh 手牌 class = suitClass(hole)
  await page.click('#btnStartTable');
  await page.waitForSelector('.seat[data-idx]', { timeout: 8000 });
  await sleep(500);
  var wiring = await page.evaluate(function () {
    var g = window.Poker.App.game;
    var hole = g.seats[g.playerIndex].hole || [];
    var cards = Array.from(document.querySelectorAll('#myCards .card')).filter(function (c) { return !c.classList.contains('empty'); });
    var okAll = cards.length === hole.length && cards.every(function (el, i) {
      var want = window.Poker.Cards.suitClass(hole[i]);
      return el.classList.contains(want);
    });
    return { holeN: hole.length, cardsN: cards.length, okAll: okAll,
      detail: hole.map(function (h) { return window.Poker.Cards.SUIT_SYMBOLS[h.s] + '->' + window.Poker.Cards.suitClass(h); }).join(' ') };
  });
  ok(wiring.okAll, '我的手牌渲染类=花色映射（' + wiring.detail + '）');

  // ③ 打到公共牌出现（多跟几街），检查 board 卡接线
  var t0 = Date.now(), boardOK = null;
  while (Date.now() - t0 < 60000 && boardOK === null) {
    var st = await page.evaluate(function () {
      var g = window.Poker.App.game;
      if (!g) return { boot: true };
      var l = g.legalActions(g.playerIndex);
      return { over: !!g.isHandOver, turn: g.currentActor === g.playerIndex,
        canBet: l.maxTo > l.minRaiseTo, canCheck: l.canCheck, canCall: l.canCall, board: g.board || [] };
    });
    if (st.boot || st.over) { await sleep(250); continue; }
    if (st.board && st.board.length >= 3) {
      boardOK = await page.evaluate(function () {
        var g = window.Poker.App.game;
        var els = Array.from(document.querySelectorAll('#board .card, .board .card')).filter(function (c) { return !c.classList.contains('empty'); });
        var cards = g.board || [];
        return els.length === cards.length && els.every(function (el, i) {
          return el.classList.contains(window.Poker.Cards.suitClass(cards[i]));
        });
      });
      break;
    }
    if (st.turn) {
      if (st.canBet) await page.keyboard.press('c');
      else if (st.canCheck || st.canCall) await page.keyboard.press('c');
      else await page.keyboard.press('f');
    }
    await sleep(160);
  }
  ok(boardOK !== null && boardOK === true, '公共牌渲染类=花色映射（到翻牌为止，boardOK=' + boardOK + '）');
  if (boardOK === null) ok(false, '60s 内未等到 ≥3 张公共牌');

  await page.screenshot({ path: path.join(__dirname, 'shot_suitcolors.png'), fullPage: false });
  await page.close(); await browser.close(); server.close();
  var out = L.join('\n') + '\nFAILED=' + FAIL + '\n';
  fs.writeFileSync(path.join(__dirname, '_verify_suitcolors_out.txt'), out);
  console.log(out);
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error('ERR', e.stack || e.message); try { server.close(); } catch (_) {} process.exit(1); });
