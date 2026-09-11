/* 真机自检 v6：内置静态服务器 + Chromium 实测
 * 覆盖：① 等比缩放（多种分辨率不裁切）② 操作区不重叠
 *      ③ HUD 入池/加注 显示真实百分比 ④ 座位动作标签 ⑤ ±10/±100 步进器 ⑥ 筹码堆落地
 * 运行：NODE_PATH=<workspace>/node_modules node tests/verify_ui_v6.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8791;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const L = [];
let FAIL = 0;
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

  // ---------- A. 等比缩放：多分辨率下不裁切 / 不溢出 ----------
  L.push('== A 等比缩放（transform scale，多分辨率）==');
  const sizes = [[1920, 1080], [1440, 900], [1280, 800], [1024, 700], [900, 620]];
  for (const [w, h] of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`http://127.0.0.1:${PORT}/?autostart=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.seat[data-idx]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const host = document.getElementById('scaleHost');
      const ta = document.querySelector('.table-area');
      const cs = getComputedStyle(host); // --table-scale 设在 #scaleHost 上，不是 :root
      const scale = parseFloat(cs.getPropertyValue('--table-scale'));
      const hb = host.getBoundingClientRect();
      const tb = ta.getBoundingClientRect();
      return {
        scale: scale,
        hostW: Math.round(hb.width), hostH: Math.round(hb.height),
        hostRight: Math.round(hb.right), hostBottom: Math.round(hb.bottom),
        tableW: Math.round(tb.width), tableH: Math.round(tb.height),
        tableRight: Math.round(tb.right), tableBottom: Math.round(tb.bottom),
        bodyOverflowX: document.body.scrollWidth - window.innerWidth,
        transform: getComputedStyle(ta).transform
      };
    });
    ok(r.tableW >= r.hostW - 2, `${w}x${h} 牌桌宽 ${r.tableW} 铺满容器 ${r.hostW}（满屏自适应）`);
    ok(r.tableH >= r.hostH - 2, `${w}x${h} 牌桌高 ${r.tableH} 铺满容器 ${r.hostH}（满屏自适应）`);
    ok(r.tableRight <= r.hostRight + 2 && r.tableBottom <= r.hostBottom + 2, `${w}x${h} 牌桌不超出容器（right=${r.tableRight}/bottom=${r.tableBottom}）`);
    ok(!/matrix/.test(r.transform) || r.transform === 'none', `${w}x${h} 满屏模式 transform 不再等比缩放（${r.transform}）`);
    ok(r.bodyOverflowX <= 0, `${w}x${h} 无横向溢出（${r.bodyOverflowX}）`);
    await page.close();
  }

  // ---------- B. 主用例：操作区 / HUD / 步进器 / 筹码 ----------
  L.push('== B 操作区布局 + HUD + 步进器 + 筹码堆 ==');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/?autostart=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.seat[data-idx]', { timeout: 10000 });
  await page.waitForTimeout(1200);

  // B0 等到「轮到我」：加注框被 enable 且 min/max 已被合法下注区间覆盖
  const myTurn = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 120; i++) {
      const n = document.getElementById('raiseInput');
      const call = document.getElementById('btnCall');
      const chk = document.getElementById('btnCheck');
      const next = document.getElementById('btnNext');
      const nextOn = next && next.offsetParent !== null && !next.classList.contains('hidden');
      const actOn = (call && !call.disabled) || (chk && !chk.disabled);
      if ((actOn && parseInt(n.max, 10) > parseInt(n.min, 10)) || nextOn) {
        return { ok: true, isNext: !!nextOn, min: n.min, max: n.max, value: n.value, waited: i };
      }
      await sleep(150);
    }
    const n = document.getElementById('raiseInput');
    return { ok: false, min: n.min, max: n.max, value: n.value };
  });
  ok(myTurn.ok, '等到玩家可操作状态（min=' + myTurn.min + ', max=' + myTurn.max + ', 等 ' + myTurn.waited + ' 拍）');

  // B1 操作区不重叠
  const layout = await page.evaluate(() => {
    const rect = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    const over = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const z = { cards: rect('#myCards'), bar: rect('.mh-bar'), coach: rect('#coachTip'), ctrls: rect('#controls'), felt: rect('.felt'), bot: rect('#rowBottom') };
    const issues = [];
    if (over(z.cards, z.bar)) issues.push('cards∩bar');
    if (over(z.bar, z.coach)) issues.push('bar∩coach');
    if (over(z.coach, z.ctrls)) issues.push('coach∩ctrls');
    if (over(z.ctrls, z.bot)) issues.push('ctrls∩botRow');
    return { zones: z, issues: issues, overflowX: document.body.scrollWidth - window.innerWidth };
  });
  ok(layout.issues.length === 0, '操作区无重叠（' + (layout.issues.join(',') || 'none') + '）');
  ok(layout.overflowX <= 0, '无横向溢出（scrollWidth-innerWidth=' + layout.overflowX + '）');

  // B2 加注步进器：±10 / ±100
  const step = await page.evaluate(() => {
    const n = document.getElementById('raiseInput');
    const rd = () => parseInt(n.value, 10);
    const out = { min: n.min, max: n.max, start: rd() };
    document.getElementById('btnPlus10').click(); out.p10 = rd();
    document.getElementById('btnPlus100').click(); out.p100 = rd();
    document.getElementById('btnMinus10').click(); out.m10 = rd();
    document.getElementById('btnMinus100').click(); out.m100 = rd();
    // 连点到底验证 clamp
    for (let i = 0; i < 60; i++) document.getElementById('btnMinus100').click();
    out.floor = rd();
    for (let i = 0; i < 80; i++) document.getElementById('btnPlus100').click();
    out.ceil = rd();
    return out;
  });
  ok(step.p10 === step.start + 10, `+10 生效（${step.start}→${step.p10}）`);
  ok(step.p100 === step.p10 + 100, `+100 生效（${step.p10}→${step.p100}）`);
  ok(step.m10 === step.p100 - 10, `-10 生效（${step.p100}→${step.m10}）`);
  ok(step.m100 === step.m10 - 100, `-100 生效（${step.m10}→${step.m100}）`);
  ok(step.floor === parseInt(step.min, 10), `连点 -100 触底 clamp 到 min=${step.min}（实际 ${step.floor}）`);
  ok(step.ceil === parseInt(step.max, 10), `连点 +100 触顶 clamp 到 max=${step.max}（实际 ${step.ceil}）`);

  // B3 打几手 → HUD 应出现真实百分比、座位出现动作标签、底池筹码堆有筹码
  const play = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const App = window.Poker.App;
    const snap = () => ({
      bets: Array.from(document.querySelectorAll('.seat-bet')).map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
      statuses: Array.from(document.querySelectorAll('.seat-status')).map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
      pile: document.getElementById('potChipsPile').children.length
    });
    const clickIf = id => { const b = document.getElementById(id); if (b && !b.disabled && b.offsetParent !== null) { b.click(); return true; } return false; };
    let best = { bets: [], statuses: [], pile: 0 };
    for (let i = 0; i < 120; i++) {
      // 记录过程中出现过的动作标签（快照取最丰富的一帧）
      const s = snap();
      if (s.bets.length > best.bets.length) best = s;
      if (clickIf('btnCall')) { await sleep(140); continue; }
      if (clickIf('btnCheck')) { await sleep(140); continue; }
      if (clickIf('btnNext')) { await sleep(260); continue; }
      await sleep(200);
    }
    const huds = Array.from(document.querySelectorAll('.hud-mini')).map(e => e.textContent.replace(/\s+/g, ' ').trim());
    return {
      hands: App.reviews ? App.reviews.length : -1,
      huds: huds,
      hudHasPct: huds.some(t => /\d+%/.test(t)),
      hudAllDash: huds.length > 0 && huds.every(t => /入池\s*–/.test(t)),
      bets: best.bets.slice(0, 8),
      statuses: best.statuses.slice(0, 8),
      pile: best.pile
    };
  });
  ok(play.huds.length > 0, '页面上渲染出对手 HUD 徽标（' + play.huds.length + ' 个）');
  ok(play.hudHasPct, 'HUD 显示真实百分比，不再是「–」（样例：' + (play.huds[0] || 'N/A') + '）');
  ok(!play.hudAllDash, '不存在「全部只显示 –」的旧问题');
  ok(play.hands > 0, '实际打完的手牌数 ' + play.hands + '（复盘可点）');
  ok(play.bets.length > 0, '座位出现动作/下注标签（样例：' + (play.bets.slice(0, 3).join(' / ') || 'N/A') + '）');
  ok(play.pile > 0, '底池筹码堆里有实体筹码（峰值 ' + play.pile + ' 枚）');

  await page.screenshot({ path: path.join(__dirname, 'shot_ui_v6_1440.png'), fullPage: false });

  // 小窗口截图（看是否被裁切）
  const small = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  await small.goto(`http://127.0.0.1:${PORT}/?autostart=1`, { waitUntil: 'domcontentloaded' });
  await small.waitForSelector('.seat[data-idx]', { timeout: 10000 });
  await small.waitForTimeout(800);
  await small.screenshot({ path: path.join(__dirname, 'shot_ui_v6_1024.png'), fullPage: false });
  await small.close();

  await page.close();
  await browser.close();
  server.close();

  const out = L.join('\n') + '\nFAILED=' + FAIL + '\n';
  fs.writeFileSync(path.join(__dirname, '_verify_ui_v6_out.txt'), out);
  console.log(out);
  process.exit(FAIL ? 1 : 0);
})().catch(e => {
  console.error('ERR', e.stack || e.message);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
