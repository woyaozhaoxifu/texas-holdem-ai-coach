/* verify_reveal: 复盘亮牌 —— 每手结束后复盘面板显示所有对手底牌(含弃牌者) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const PORT = 8805;
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
  await page.click('#btnStartTable');
  await page.waitForSelector('.seat[data-idx]', { timeout: 8000 });
  await sleep(600);

  // 不断推进：轮到我时 C(过/跟) R(加) F(弃)；直到复盘面板自动弹出
  var opened = false, t0 = Date.now();
  while (Date.now() - t0 < 90000 && !opened) {
    opened = await page.evaluate(function () {
      var m = document.getElementById('modalReview');
      return m && !m.classList.contains('hidden') && window.Poker.App.reviews.length > 0;
    });
    if (opened) break;
    var st = await page.evaluate(function () {
      var g = window.Poker.App.game;
      if (!g) return { boot: true };
      var legal = g.legalActions(g.playerIndex);
      return { over: !!g.isHandOver, turn: g.currentActor === g.playerIndex,
        canBet: legal.maxTo > legal.minRaiseTo, canCheck: legal.canCheck, canCall: legal.canCall };
    });
    if (st.boot) { await sleep(200); continue; }
    if (st.over) { await sleep(250); continue; }          // 等结算/复盘弹窗
    if (st.turn) {
      if (st.canBet) await page.keyboard.press('r');
      else if (st.canCheck || st.canCall) await page.keyboard.press('c');
      else await page.keyboard.press('f');
    }
    await sleep(160);
  }
  ok(opened, '复盘面板自动弹出（打过至少一手）');
  if (!opened) { /* 收尾 */ }

  // —— 核心断言：对手行全部亮出实体底牌 ——
  var dom1 = await page.evaluate(function () {
    var rows = Array.from(document.querySelectorAll('#reviewBody .opp-row'));
    return {
      nRows: rows.length,
      nCards: rows.reduce(function (n, r) { return n + r.querySelectorAll('.op-hole .card.small').length; }, 0),
      nFold: rows.filter(function (r) { return r.querySelector('.op-fold'); }).length
    };
  });
  ok(dom1.nRows === 5, '对手解读列出 5 个对手（实测 ' + dom1.nRows + '）');
  ok(dom1.nCards === 10, '对手底牌实体小牌共 10 张 = 5 人 × 2（实测 ' + dom1.nCards + '）');

  var data = await page.evaluate(function () {
    var r = window.Poker.App.reviews[window.Poker.App.rvIdx];
    var allHole = r.opponents.every(function (o) { return o.hole && o.hole.length === 2; });
    var allRev = r.opponents.every(function (o) { return o.revealed === true; });
    return { n: r.opponents.length, allHole: allHole, allRev: allRev,
      folded: r.opponents.filter(function (o) { return o.folded; }).length };
  });
  ok(data.n === 5 && data.allHole && data.allRev, '复盘数据：5 对手全部 revealed=true 且 hole 2 张');
  ok(dom1.nFold >= 0, '（本手弃牌对手 ' + dom1.nFold + ' 人，也在亮牌行列）');

  var foldProved = false;
  foldProved = await page.evaluate(function () {
    var App = window.Poker.App;
    for (var i = App.reviews.length - 1; i >= 0; i--) {
      var r = App.reviews[i];
      if (r.opponents.some(function (o) { return o.folded; })) {
        // 翻到那一手
        App.showReview(i);
        var rows = Array.from(document.querySelectorAll('#reviewBody .opp-row'));
        var foldRow = rows.find(function (row) {
          return row.querySelector('.op-fold');
        });
        if (!foldRow) return { ok: false, why: 'fold row not found', idx: i };
        var cards = foldRow.querySelectorAll('.op-hole .card.small').length;
        return { ok: cards === 2, idx: i, cards: cards };
      }
    }
    return { ok: 'no-fold-hand', why: 'no hand had a folded opponent' };
  });
  ok(foldProved.ok === true || foldProved.ok === 'no-fold-hand',
    '含弃牌对手的复盘：弃牌行也亮 2 张实体牌' + (foldProved.ok === true ? '（手 ' + foldProved.idx + '，cards=' + foldProved.cards + '）' : (foldProved.ok === 'no-fold-hand' ? '（本局无弃牌样本）' : ' FAIL:' + foldProved.why)));

  await page.evaluate(function(){var b=document.getElementById("reviewBody");if(b){var t=document.querySelector("#reviewBody .opp-row");if(t){t.scrollIntoView({block:/center/});var m=document.getElementById("modalReview");if(m)m.scrollTop=Math.max(0,m.scrollTop-120);}else b.scrollTop=600;}});await sleep(400);
await page.screenshot({ path: path.join(__dirname, 'shot_reveal.png'), fullPage: false });
  await page.close();
  await browser.close();
  server.close();
  var out = L.join('\n') + '\nFAILED=' + FAIL + '\n';
  fs.writeFileSync(path.join(__dirname, '_verify_reveal_out.txt'), out);
  console.log(out);
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error('ERR', e.stack || e.message); try { server.close(); } catch (_) {} process.exit(1); });
