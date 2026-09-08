/* verify_roles: 角色 Puck + 本手已投 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const PORT = 8802;
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
async function waitFor(page, fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 8000)) { if (await page.evaluate(fn)) return true; await sleep(120); }
  if (label) { L.push('  FAIL(超时) - ' + label); FAIL++; }
  return false;
}
(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#persGrid', { timeout: 8000 });
  await page.click('#btnStartTable');
  await page.waitForSelector('.seat[data-idx]', { timeout: 8000 });
  await sleep(800);

  var roleCheck = await page.evaluate(function () {
    var g = window.Poker.App.game;
    var allPucks = Array.from(document.querySelectorAll('.role-puck')).map(function (p) { return p.textContent.trim(); });
    var seatRoles = {};
    g.seats.forEach(function (s) { if (s.role) seatRoles[s.role] = s.index; });
    return {
      rD: allPucks.filter(function (t) { return /庄/.test(t); }).length,
      rSB: allPucks.filter(function (t) { return /小盲/.test(t); }).length,
      rBB: allPucks.filter(function (t) { return /大盲/.test(t); }).length,
      rUp: allPucks.filter(function (t) { return /上家/.test(t); }).length,
      seatRoles: seatRoles,
      upIdx: (g.playerIndex - 1 + g.seats.length) % g.seats.length
    };
  });
  ok(roleCheck.rD === 1, '1 个 庄 Puck（实测 ' + roleCheck.rD + '）');
  ok(roleCheck.rSB === 1, '1 个 小盲 Puck（实测 ' + roleCheck.rSB + '）');
  ok(roleCheck.rBB === 1, '1 个 大盲 Puck（实测 ' + roleCheck.rBB + '）');
  ok(roleCheck.rUp === 1, '1 个 上家 Puck（实测 ' + roleCheck.rUp + '）');
  ok(roleCheck.seatRoles.D != null && roleCheck.seatRoles.SB != null && roleCheck.seatRoles.BB != null,
     '引擎已写入 seat.role D/SB/BB（' + JSON.stringify(roleCheck.seatRoles) + '）');

  var upPuckOnRightSeat = await page.evaluate(function (upIdx) {
    var seat = document.querySelector('.seat[data-idx="' + upIdx + '"]');
    return !!(seat && seat.querySelector('.role-puck.up'));
  }, roleCheck.upIdx);
  ok(upPuckOnRightSeat, '上家 Puck 落在玩家上家座位 (idx=' + roleCheck.upIdx + ')');

  var committed = await page.evaluate(function () {
    var out = {};
    var pi = window.Poker.App.game.playerIndex;
    window.Poker.App.game.seats.forEach(function (s) {
      var seat = document.querySelector('.seat[data-idx="' + s.index + '"]');
      var pill = seat ? seat.querySelector('.seat-committed') : null;
      if (!pill && s.index === pi) {
        var mh = document.querySelector('.mh-meta .seat-committed');
        if (mh) pill = mh;
      }
      var txt = pill ? parseInt(pill.textContent.replace(/[^0-9]/g, ''), 10) : 0;
      out[s.index] = { actual: s.committed || 0, shown: txt };
    });
    return out;
  });
  var bl = Object.values(committed).filter(function (v) { return v.actual > 0; });
  ok(bl.length >= 2, '至少 2 个座位已投（实测 ' + bl.length + '）');
  var allShownCorrect = Object.values(committed).every(function (v) { return v.shown === v.actual; });
  ok(allShownCorrect, '每位本手已投 数字=实际累计（' + JSON.stringify(committed) + '）');

  // 走 UI 键盘路径（R=加注）：等玩家回合 → 能加则 R，否则 C 跟/过推进 → 最多跨 8 手
  await page.mouse.move(400, 400).catch(function () {});
  await page.evaluate(function () { window.focus(); document.body.focus(); });
  var raised = false;
  var t1 = Date.now();
  while (Date.now() - t1 < 60000 && !raised) {
    var st = await page.evaluate(function () {
      var g = window.Poker.App.game;
      if (!g) return { boot: true };
      var legal = g.legalActions(g.playerIndex);
      return {
        over: !!g.isHandOver, turn: g.currentActor === g.playerIndex,
        canBet: legal.maxTo > legal.minRaiseTo,
        canCheck: legal.canCheck, canCall: legal.canCall,
        committed: g.seats[g.playerIndex].committed || 0, hand: g.handNo
      };
    });
    if (st.boot || !st.turn || st.over) { await sleep(200); continue; }
    if (st.canBet) {
      await page.keyboard.press('r');
      raised = true;
      break;
    }
    if (st.canCheck || st.canCall) { await page.keyboard.press('c'); }
    else { await page.keyboard.press('f'); }
    await sleep(200);
  }
  await sleep(600);
  var after = await page.evaluate(function () {
    var s = window.Poker.App.game.seats[window.Poker.App.game.playerIndex];
    var seat = document.querySelector('.seat[data-idx="' + s.index + '"]');
    var pill = seat ? seat.querySelector('.seat-committed') : (document.querySelector('.mh-meta .seat-committed') || null);
    return { actual: s.committed || 0, shown: pill ? parseInt(pill.textContent.replace(/[^0-9]/g, ''), 10) : 0 };
  });
  ok(raised, '轮到时成功加注（R 键）');
  ok(after.actual > 20 && after.shown === after.actual, '玩家加注后 本手已投 数字刷新（shown=' + after.shown + ', actual=' + after.actual + '）');

  var fits = await page.evaluate(function () {
    var wrap = document.querySelector('.table-area-wrap');
    var rowB = document.querySelector('.seat-row.bottom');
    if (!wrap || !rowB) return { ok: false, why: 'missing nodes' };
    var w = wrap.getBoundingClientRect();
    var r = rowB.getBoundingClientRect();
    return { ok: r.bottom <= w.bottom + 1, wrapBottom: Math.round(w.bottom), rowBottom: Math.round(r.bottom) };
  });
  ok(fits.ok, '底部座位行不超出缩放容器（wrap.bottom=' + fits.wrapBottom + ', rowBottom=' + fits.rowBottom + '）');

  await page.screenshot({ path: path.join(__dirname, 'shot_roles.png'), fullPage: false });
  await page.close();
  await browser.close();
  server.close();
  var out = L.join('\n') + '\nFAILED=' + FAIL + '\n';
  fs.writeFileSync(path.join(__dirname, '_verify_roles_out.txt'), out);
  console.log(out);
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error('ERR', e.stack || e.message); try { server.close(); } catch (_) {} process.exit(1); });
