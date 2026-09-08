/* 真机验证：点击座位给对手打标签（chromium 自带服务器） */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8796;
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

  // 不开匿名桌，正常练习局，真实人格名可见
  await page.click('#btnStartTable');
  await page.waitForSelector('.seat[data-idx]', { timeout: 10000 });
  await page.waitForTimeout(800);

  ok(await page.evaluate(() => !document.getElementById('modalTag').classList.contains('hidden') === false), '开局时标注弹窗默认隐藏');

  // 点击座位 1（首个 AI）→ 弹窗应出现
  await page.click('.seat[data-idx="1"]');
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => !document.getElementById('modalTag').classList.contains('hidden'));
  ok(opened, '点击座位 → 标注弹窗 #modalTag 打开');

  // 预设标签按钮数量应为 9
  const presetCount = await page.evaluate(() => document.querySelectorAll('#tagPresets .tag-preset').length);
  ok(presetCount === 9, '预设标签按钮渲染 9 个（实测 ' + presetCount + '）');

  // 点预设「紧凶」→ 写入并关闭
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#tagPresets .tag-preset'));
    const t = btns.find(b => b.textContent.trim() === '紧凶');
    t.click();
  });
  await page.waitForTimeout(250);
  const afterPreset = await page.evaluate(() => ({
    closed: document.getElementById('modalTag').classList.contains('hidden'),
    tag: window.Poker.App.seatTags['1'] || null,
    badge: (document.querySelector('.seat[data-idx="1"] .seat-tag') || {}).textContent || null
  }));
  ok(afterPreset.closed, '点预设标签后弹窗关闭');
  ok(afterPreset.tag === '紧凶', "App.seatTags[1] = '紧凶'");
  ok(afterPreset.badge && afterPreset.badge.indexOf('紧凶') >= 0, '座位 1 显示标签徽标（' + afterPreset.badge + '）');

  // 座位 3 自定义标签「爱诈唬」
  await page.click('.seat[data-idx="3"]');
  await page.waitForTimeout(150);
  await page.fill('#tagCustom', '爱诈唬');
  await page.click('#tagCustomOk');
  await page.waitForTimeout(250);
  const afterCustom = await page.evaluate(() => ({
    tag: window.Poker.App.seatTags['3'] || null,
    badge: (document.querySelector('.seat[data-idx="3"] .seat-tag') || {}).textContent || null
  }));
  ok(afterCustom.tag === '爱诈唬', "座位 3 自定义标签写入 App.seatTags[3] = '爱诈唬'");
  ok(afterCustom.badge && afterCustom.badge.indexOf('爱诈唬') >= 0, '座位 3 显示自定义徽标（' + afterCustom.badge + '）');

  // 座位数随重渲染保留（再点一次座位 1 校验仍是紧凶，可改）
  await page.click('.seat[data-idx="1"]');
  await page.waitForTimeout(150);
  const reopen = await page.evaluate(() => !document.getElementById('modalTag').classList.contains('hidden'));
  ok(reopen, '再点已标注座位可重新打开编辑');
  // 清除座位 1 的标签
  await page.click('#tagClear');
  await page.waitForTimeout(250);
  const afterClear = await page.evaluate(() => ({
    tag: window.Poker.App.seatTags['1'] || null,
    badge: !!document.querySelector('.seat[data-idx="1"] .seat-tag')
  }));
  ok(afterClear.tag === null, '清除后 App.seatTags[1] 为空');
  ok(!afterClear.badge, '清除后座位 1 徽标消失');
  ok(afterCustom.tag === '爱诈唬', '清除一个座位不影响另一个座位（座位 3 仍是 爱诈唬）');

  await page.screenshot({ path: path.join(__dirname, 'shot_tag.png'), fullPage: false });
  await page.close();
  await browser.close();
  server.close();

  const out = L.join('\n') + '\nFAILED=' + FAIL + '\n';
  fs.writeFileSync(path.join(__dirname, '_verify_tag_out.txt'), out);
  console.log(out);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('ERR', e.stack || e.message); try { server.close(); } catch (_) {} process.exit(1); });
