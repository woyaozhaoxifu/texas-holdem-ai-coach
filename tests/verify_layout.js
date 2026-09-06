/* 布局验证：操作区在牌下方、无重叠溢出 */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('http://127.0.0.1:8790/?autostart=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.seat[data-idx]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3500);

  const r = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const over = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const zones = {
      topRow: rect('#rowTop'), center: rect('.center'), cards: rect('#myCards'),
      bar: rect('.mh-bar'), coach: rect('#coachTip'), ctrls: rect('#controls'),
      botRow: rect('#rowBottom'), felt: rect('.felt')
    };
    const issues = [];
    if (over(zones.topRow, zones.center)) issues.push('topRow∩center');
    if (over(zones.center, zones.cards)) issues.push('center∩cards');
    if (over(zones.cards, zones.bar)) issues.push('cards∩bar');
    if (over(zones.bar, zones.coach)) issues.push('bar∩coach');
    if (over(zones.coach, zones.ctrls)) issues.push('coach∩ctrls');
    if (over(zones.ctrls, zones.botRow)) issues.push('ctrls∩botRow');
    const btnRect = rect('#btnCall');
    return {
      viewport: innerWidth + 'x' + innerHeight,
      bodyScroll: { w: document.body.scrollWidth, h: document.body.scrollHeight },
      zones,
      btnCall: btnRect,
      btnCallBelowCards: btnRect ? (btnRect.top >= zones.cards.bottom) : 'N/A',
      issues,
      btnVisible: Array.from(document.querySelectorAll('.controls .btn')).map(b => b.id + ':' + (b.offsetParent !== null))
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: 'D:/我的项目/12-德州扑克AI对战/tests/shot_v5.png' });
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
