/* 真机验证：本轮优化批（偏好记忆 / 键盘快捷键 / 战绩小结 / 对手统计跨会话持久化 / 音效开关）
   chromium 自带 http 服务器；同 context 内 reload 保留 localStorage。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8798;
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(page, fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 8000)) {
    if (await page.evaluate(fn)) return true;
    await sleep(120);
  }
  if (label) { L.push('  FAIL(超时) - ' + label); FAIL++; }
  return false;
}

/** 页内：若轮到自己则做一次稳健行动（check > call > 大额弃牌 > fold），返回是否行动过 */
const actOnce = () => {
  const g = window.Poker.App.game;
  const click = id => { const b = document.getElementById(id); if (b && !b.disabled && b.offsetParent !== null) { b.click(); return true; } return false; };
  if (!g || g.isHandOver) return 'next';
  if (g.currentActor !== g.playerIndex) return 'wait';
  const legal = g.legalActions(g.playerIndex);
  if (legal.canCheck) return click('btnCheck') ? 'acted' : 'wait';
  const me = g.seats[g.playerIndex];
  if (legal.canCall && legal.toCall > (me.chips || 0) * 0.5) return click('btnFold') ? 'folded' : 'wait';
  return click('btnCall') ? 'acted' : 'wait';
};
const myTurnCond = () => {
  const b = document.getElementById('btnFold');
  const g = window.Poker.App.game;
  return !!b && !b.disabled && b.offsetParent !== null && !!g && !g.isHandOver && g.currentActor === g.playerIndex;
};
const curHandNo = page => page.evaluate(() => parseInt(document.getElementById('handNo').textContent, 10) || 0);
const lastLogHas = (page, re) => page.evaluate(re => {
  const logs = Array.from(document.querySelectorAll('#log > div')).map(x => x.textContent || '');
  return logs.slice(-8).some(t => re.test(t));
}, re);

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // ---------- 1) 音效/快捷键模块存在 + 默认偏好 ----------
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#persGrid', { timeout: 8000 });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => typeof window.Poker.App.sfx === 'function' && typeof window.Poker.App._tone === 'function'), '音效模块 App.sfx/_tone 已挂载');
  ok(await page.evaluate(() => !!window.Poker.App._keysBound), '键盘快捷键已绑定（App._keysBound）');
  ok(await page.evaluate(() => !!document.getElementById('chkSound')), '顶栏存在 🔔 音效开关 #chkSound');
  ok(await page.evaluate(() => document.getElementById('chkCoach').checked === true), '教学提示默认勾选（prefs 缺省 true）');

  // ---------- 2) 偏好记忆：关掉 教学提示+音效 → 刷新后仍是关 ----------
  await page.evaluate(() => {
    ['chkCoach', 'chkSound'].forEach(id => {
      const c = document.getElementById(id); c.checked = false; c.dispatchEvent(new Event('change'));
    });
  });
  await sleep(150);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#persGrid', { timeout: 8000 });
  const afterReload = await page.evaluate(() => ({
    coach: document.getElementById('chkCoach').checked,
    sound: document.getElementById('chkSound').checked
  }));
  ok(afterReload.coach === false && afterReload.sound === false, '刷新后 教学提示/音效 仍为关（偏好记忆生效）');

  // ---------- 3) 开局驱动对局：连打推进，期间用键盘 F 完成一次弃牌 ----------
  await page.click('#btnStartTable');
  await page.waitForSelector('.seat[data-idx]', { timeout: 10000 });
  await sleep(600);

  let foldedViaKey = false;
  let reached = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 70000) {
    // 优先：等一次「轮到我们」的机会（第 2 手起）按 F 弃牌
    const hn = await curHandNo(page);
    if (!foldedViaKey && hn >= 2 && await page.evaluate(myTurnCond)) {
      await page.keyboard.press('f');
      await sleep(450);
      foldedViaKey = await lastLogHas(page, /你.*弃牌|弃牌.*你/);
      continue;
    }
    const st = await page.evaluate(actOnce);
    if (st === 'next') {
      await page.evaluate(() => { const b = document.getElementById('btnNext'); if (b && !b.disabled && b.offsetParent !== null) { b.click(); return true; } return false; });
    }
    if (foldedViaKey && hn >= 3) { reached = true; break; }
    await sleep(110);
  }
  const finalHand = await curHandNo(page);
  ok(foldedViaKey, '键盘 F 完成一次弃牌（日志出现「你 弃牌」）');
  ok(reached && finalHand >= 3, '对局推进到第 ' + finalHand + ' 手（≥3）');

  await page.evaluate(() => { ['modalReview', 'modalRound', 'modalFinal'].forEach(id => { const m = document.getElementById(id); if (m && !m.classList.contains('hidden')) m.classList.add('hidden'); }); });

  // ---------- 4) 战绩小结弹窗 ----------
  await page.evaluate(() => { const b = document.getElementById('btnSession'); if (b) b.click(); });
  await sleep(300);
  const sess = await page.evaluate(() => {
    const m = document.getElementById('modalSession');
    return {
      open: m && !m.classList.contains('hidden'),
      rows: document.querySelectorAll('#sessionBody .ss-row').length,
      meta: (document.getElementById('sessionMeta').textContent || ''),
      txt: window.Poker.App.sessionText()
    };
  });
  ok(sess.open, '「战绩」按钮 → 战绩弹窗打开');
  ok(sess.rows === 6, '战绩列出 你+5 对手 共 6 行（实测 ' + sess.rows + '）');
  ok(/练习/.test(sess.meta) && sess.txt.indexOf('手数') >= 0, '战绩摘要含模式与手数，文本可生成');
  await page.evaluate(() => document.getElementById('modalSession').classList.add('hidden'));

  // ---------- 5) 对手统计跨会话持久化 ----------
  const stored = await page.evaluate(() => {
    window.Poker.App.saveOppStats();
    try { return JSON.parse(localStorage.getItem('poker_opp_stats_v1') || '{}'); } catch (e) { return {}; }
  });
  const idsWithHands = Object.keys(stored).filter(k => stored[k] && (stored[k].hands || 0) >= 1);
  ok(idsWithHands.length >= 4, 'localStorage 已存对手统计（≥4 个人格有手数：' + idsWithHands.join('/') + '）');
  const fishHands = stored['fish'] ? stored['fish'].hands : 0;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#persGrid', { timeout: 8000 });
  await page.click('#btnStartTable');
  await page.waitForSelector('.seat[data-idx]', { timeout: 10000 });
  await sleep(400);
  const seeded = await page.evaluate((expectFish) => {
    const g = window.Poker.App.game;
    const fish = g.seats.find(s => s.id === 'fish');
    return { fishHands: fish ? fish.stats.hands : -1, vpip: fish ? (fish.stats.vpip || 0) : 0, expect: expectFish };
  }, fishHands);
  ok(seeded.fishHands === fishHands + 1, '重启后 fish 手数 = 历史 + 1（' + fishHands + '→' + seeded.fishHands + '，跨会话累积）');
  ok(seeded.fishHands >= 1, 'HUD 统计基于累积数据（手数 ' + seeded.fishHands + '）');

  await page.screenshot({ path: path.join(__dirname, 'shot_enhance.png'), fullPage: false });
  await page.close();
  await browser.close();
  server.close();

  const out = L.join('\n') + '\nFAILED=' + FAIL + '\n';
  fs.writeFileSync(path.join(__dirname, '_verify_enhance_out.txt'), out);
  console.log(out);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('ERR', e.stack || e.message); try { server.close(); } catch (_) {} process.exit(1); });
