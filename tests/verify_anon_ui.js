/* 真机验证：匿名桌 + 筹码分面额（chromium 自带服务器） */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8792;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
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

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#persGrid', { timeout: 8000 });
  await page.waitForTimeout(300);

  // 勾选「匿名桌」并开局
  const hasChk = await page.evaluate(() => !!document.getElementById('chkAnon'));
  ok(hasChk, '选桌弹窗存在「匿名桌」开关 #chkAnon');
  await page.evaluate(() => { const c = document.getElementById('chkAnon'); if (c) { c.checked = true; c.dispatchEvent(new Event('change')); } });

  await page.click('#btnStartTable');
  await page.waitForSelector('.seat[data-idx]', { timeout: 10000 });
  await page.waitForTimeout(1500);
  const anonOn = await page.evaluate(() => !!window.Poker.App.anonMode);
  ok(anonOn, '开局后 App.anonMode = true（隐藏身份生效）');

  // 座位名应为方位代号，且不是真实人格名
  const seats = await page.evaluate(() => Array.from(document.querySelectorAll('.seat-name')).map(e => e.textContent.trim()));
  const REAL = ['新手小鱼', '岩石老张', '紧凶小杨', '松凶阿浪', 'GTO 教学', '暴怒鲨鱼'];
  const CODES = ['东家', '南家', '西家', '北家', '中家'];
  ok(seats.length > 0, '渲染出座位名（' + seats.length + ' 个）');
  ok(seats.every(n => CODES.indexOf(n) >= 0), '匿名态：座位名全是方位代号（' + seats.join('/') + '）');
  ok(seats.every(n => REAL.indexOf(n) < 0), '匿名态：没有任何座位露出真实人格名');

  // HUD 统计仍可见（玩家推断线索）
  const huds = await page.evaluate(() => Array.from(document.querySelectorAll('.hud-mini')).length);
  ok(huds > 0, 'HUD 统计徽标仍显示（' + huds + ' 个，推断线索保留）');

  // 打几手，让底池出现筹码 → 验证分面额
  const chips = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const App = window.Poker.App;
    const clickIf = id => { const b = document.getElementById(id); if (b && !b.disabled && b.offsetParent !== null) { b.click(); return true; } return false; };
    for (let i = 0; i < 80; i++) {
      if (clickIf('btnCall')) { await sleep(120); continue; }
      if (clickIf('btnCheck')) { await sleep(120); continue; }
      if (clickIf('btnNext')) { await sleep(200); continue; }
      await sleep(150);
    }
    const pile = document.getElementById('potChipsPile');
    return {
      stacks: pile ? pile.querySelectorAll('.pin-stack').length : 0,
      denomClasses: pile ? Array.from(pile.querySelectorAll('.pile-chip')).map(c => c.className.replace('pile-chip', '').trim()) : [],
      revealBtnVisible: (() => { const b = document.getElementById('btnReveal'); return b ? !b.classList.contains('hidden') : false; })()
    };
  });
  ok(chips.stacks > 0, '底池出现面额分摞（' + chips.stacks + ' 摞）');
  ok(chips.denomClasses.some(c => /den-(5|25|100|500|1000)/.test(c)), '底池筹码带面额色类（样例：' + chips.denomClasses.slice(0, 4).join(' ') + '）');
  ok(chips.revealBtnVisible, '匿名态：顶栏「揭晓身份」按钮可见');

  // 点击揭晓 → 名字变真实人格（先关掉可能挡路的复盘弹窗）
  await page.evaluate(() => {
    ['modalReview', 'modalRound', 'modalFinal'].forEach(id => {
      const m = document.getElementById(id);
      if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
    });
  });
  await page.click('#btnReveal');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    names: Array.from(document.querySelectorAll('.seat-name')).map(e => e.textContent.trim()),
    revealed: !!window.Poker.App.anonymRevealed
  }));
  ok(after.revealed, '点击后 App.anonymRevealed = true（不可逆）');
  ok(after.names.some(n => REAL.indexOf(n) >= 0), '揭晓后至少出现真实人格名（' + after.names.join('/') + '）');

  await page.screenshot({ path: path.join(__dirname, 'shot_anon.png'), fullPage: false });
  await page.close();
  await browser.close();
  server.close();

  const out = L.join('\n') + '\nFAILED=' + FAIL + '\n';
  fs.writeFileSync(path.join(__dirname, '_verify_anon_out.txt'), out);
  console.log(out);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('ERR', e.stack || e.message); try { server.close(); } catch (_) {} process.exit(1); });
