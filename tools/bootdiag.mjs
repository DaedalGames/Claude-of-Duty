// 부팅 진단: __READY__가 안 뜨는 게 느려서인지 에러라서인지 가른다.
// 콘솔·페이지 에러를 그대로 찍고, 일정 간격으로 부팅 단계 전역값을 폴링한다.
import { chromium } from 'playwright';

const PORT = process.argv[2] ?? '4174';
const WAIT = Number(process.argv[3] ?? 120000);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });

page.on('console', m => console.log(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 500)}`));
page.on('requestfailed', r => console.log(`[reqfail] ${r.url().slice(0, 120)}`));

await page.goto(`http://127.0.0.1:${PORT}/?capture=1&q=low`, { waitUntil: 'domcontentloaded' });

const t0 = Date.now();
while (Date.now() - t0 < WAIT) {
  const s = await page.evaluate(() => ({
    ready: !!window.__READY__,
    pump: typeof window.__PUMP__,
    canvas: !!document.getElementById('game'),
    gl: (() => {
      try {
        const c = document.getElementById('game');
        return c && c.getContext ? !!(c.getContext('webgl2') || c.__ctx) : false;
      } catch { return 'err'; }
    })(),
  })).catch(e => ({ err: String(e).slice(0, 120) }));
  console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(s));
  if (s.ready) { console.log('READY'); break; }
  await page.waitForTimeout(10000);
}
await browser.close();
