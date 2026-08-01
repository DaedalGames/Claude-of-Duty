// 그레이드 프리셋 수치 검증. GPU 없이 LUT 수학만 돌려 프리셋 간 차이를 실측한다.
// 스타일라이즈 프리셋이 실제로 (a) 더 채도가 높고 (b) 대비가 세고 (c) 하이라이트 채도를
// 덜 잃는지 숫자로 확인한다. "설정했다"가 아니라 "출력이 그렇다"를 재는 게이트.
import { GRADE_PRESETS } from '../src/render/lut.js';

// lut.js의 applyGrade는 비공개라 같은 수식을 여기서 재현하지 않는다.
// 대신 프리셋 파라미터가 의도한 방향인지와, LUT 출력 통계를 직접 잰다.
const { chromium } = await import('playwright');

const SAMPLES = [
  [0.18, 0.18, 0.18], [0.5, 0.5, 0.5], [0.85, 0.2, 0.2],
  [0.2, 0.6, 0.9], [0.9, 0.75, 0.3], [0.05, 0.05, 0.06], [0.95, 0.95, 0.9],
];

function sat(rgb) {
  const mx = Math.max(...rgb), mn = Math.min(...rgb);
  return mx <= 0 ? 0 : (mx - mn) / mx;
}

// createGradeLut은 THREE.Data3DTexture를 만들므로 브라우저 컨텍스트에서 돌린다.
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${process.argv[2] ?? 4174}/`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async (samples) => {
  const mod = await import('/src/render/lut.js');
  const res = {};
  for (const name of Object.keys(mod.GRADE_PRESETS)) {
    const { texture, size } = mod.createGradeLut(name);   // {texture, size} 반환
    const d = texture.image.data, n = size;
    const graded = samples.map(([r, g, b]) => {
      const xi = Math.round(r * (n - 1)), yi = Math.round(g * (n - 1)), zi = Math.round(b * (n - 1));
      const p = ((zi * n + yi) * n + xi) * 4;
      return [d[p] / 255, d[p + 1] / 255, d[p + 2] / 255];
    });
    res[name] = graded;
  }
  return res;
}, SAMPLES).catch(e => ({ __err: String(e) }));

await browser.close();

if (out.__err) { console.log('ERR', out.__err); process.exit(1); }

const names = Object.keys(out);
console.log('preset       meanSat  contrast(p95-p05)  hiSatKeep');
const stat = {};
for (const nm of names) {
  const g = out[nm];
  const sats = g.map(sat);
  const lum = g.map(c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).sort((a, b) => a - b);
  const contrast = lum[lum.length - 1] - lum[0];
  const hi = sat(g[4]);                       // 밝은 채색 샘플의 채도 유지
  stat[nm] = { meanSat: sats.reduce((a, b) => a + b, 0) / sats.length, contrast, hi };
  console.log(`${nm.padEnd(12)} ${stat[nm].meanSat.toFixed(4)}   ${contrast.toFixed(4)}            ${hi.toFixed(4)}`);
}

const s = stat.stylized, d = stat.default;
const checks = [
  ['채도 더 높다', s.meanSat > d.meanSat],
  ['대비 더 세다', s.contrast >= d.contrast],
  ['하이라이트 채도 더 유지', s.hi > d.hi],
];
let bad = 0;
console.log('---');
for (const [label, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) bad++; }
console.log(bad ? `FAILED ${bad}` : 'ALL PASS');
process.exit(bad ? 1 : 0);
