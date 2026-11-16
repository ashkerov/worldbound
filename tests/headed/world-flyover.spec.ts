// Облёт мира M в обычном видимом окне браузера (вертикальная синхронизация включена):
// частота кадров, длинные кадры, такты симуляции на ×8. Отдельно WebGPU и WebGL 2, пресет из WB_QUALITY.
// Запуск: npm run build && npx playwright test --config playwright.headed.config.ts world-flyover

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type {} from '../../src/app/debugHandle';

const RESULTS = 'docs/measurements';
const SHOTS = 'docs/screenshots/phase2';
mkdirSync(RESULTS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const BACKENDS = (process.env.WB_BACKENDS ?? 'webgpu,webgl2').split(',') as ('webgpu' | 'webgl2')[];
const QUALITY = process.env.WB_QUALITY ?? 'medium';
const SEGMENT_MS = Number(process.env.WB_SEGMENT_MS ?? 8000);

/** Маршрут: обзор → побережье → вдоль реки низко → горы → свободная камера у воды → снова обзор. */
const ROUTE = [
  { name: 'обзор мира', mode: 'strategic', target: [2048, 40, 2048], yaw: 0.7, pitch: 0.9, distance: 4300 },
  { name: 'побережье', mode: 'strategic', target: [3300, 10, 1200], yaw: 1.4, pitch: 0.7, distance: 1300 },
  { name: 'долина низко', mode: 'strategic', target: [1500, 40, 2300], yaw: 2.4, pitch: 0.45, distance: 500 },
  { name: 'горы', mode: 'strategic', target: [500, 250, 3200], yaw: 3.6, pitch: 0.55, distance: 900 },
  { name: 'у реки, свободная камера', mode: 'free', target: [700, 52, 1700], yaw: 0.3, pitch: 0.15, distance: 60 },
  { name: 'обзор мира', mode: 'strategic', target: [2048, 40, 2048], yaw: 4.0, pitch: 0.95, distance: 4500 },
] as const;

interface Segment {
  name: string;
  fps: number;
  frameMsP95: number;
  frameMsP99: number;
  frameMsMax: number;
  longFrames: number;
  frames: number;
  triangles: number;
  drawCalls: number;
  terrainNodes: number;
}

for (const backend of BACKENDS) {
  test(`облёт мира M: ${backend}, ${QUALITY}`, async ({ page }) => {
    test.setTimeout(600_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`/?renderer=${backend}&autostart=1&seed=42&size=M&quality=${QUALITY}&debug=1`);
    await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 240_000 });
    expect(await page.evaluate(() => window.__wb!.backend)).toBe(backend);
    await page.getByTestId('speed-8').click();
    await page.keyboard.press('KeyH');
    await page.waitForTimeout(4000);
    const tick0 = await page.evaluate(() => window.__wb!.getTick());
    const started = Date.now();

    const segments: Segment[] = [];
    for (let k = 0; k < ROUTE.length - 1; k++) {
      const a = ROUTE[k]!;
      const b = ROUTE[k + 1]!;
      const seg = await page.evaluate(
        async ({ a, b, ms }) => {
          const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
          const times: number[] = [];
          const start = performance.now();
          let last = start;
          await new Promise<void>((resolve) => {
            const step = (now: number) => {
              times.push(now - last);
              last = now;
              const t = Math.min(1, (now - start) / ms);
              const e = t * t * (3 - 2 * t);
              // Дистанция — по логарифму, чтобы движение у земли и сверху было соразмерным.
              const d = Math.exp(lerp(Math.log(a.distance), Math.log(b.distance), e));
              window.__wb!.setView({
                mode: t < 0.5 ? a.mode : b.mode,
                target: [lerp(a.target[0], b.target[0], e), lerp(a.target[1], b.target[1], e), lerp(a.target[2], b.target[2], e)],
                yaw: lerp(a.yaw, b.yaw, e),
                pitch: lerp(a.pitch, b.pitch, e),
                distance: d,
              });
              if (t < 1) requestAnimationFrame(step);
              else resolve();
            };
            requestAnimationFrame(step);
          });
          const sorted = times.slice(2).sort((x, y) => x - y);
          const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
          const total = sorted.reduce((s, v) => s + v, 0);
          return { fps: (sorted.length * 1000) / total, frameMsP95: q(0.95), frameMsP99: q(0.99), frameMsMax: sorted[sorted.length - 1]!, longFrames: sorted.filter((v) => v > 100).length, frames: sorted.length };
        },
        { a, b, ms: SEGMENT_MS },
      );
      const r = ((await page.evaluate(() => window.__wb!.getStats())) as { render: { triangles: number; drawCalls: number; terrainNodes: number } }).render;
      segments.push({ name: `${a.name} → ${b.name}`, ...seg, triangles: r.triangles, drawCalls: r.drawCalls, terrainNodes: r.terrainNodes });
      await page.screenshot({ path: `${SHOTS}/flyover-${backend}-${QUALITY}-${k + 1}.png` });
    }
    const tick1 = await page.evaluate(() => window.__wb!.getTick());
    const seconds = (Date.now() - started) / 1000;
    const stats = (await page.evaluate(() => window.__wb!.getStats())) as { render: { resolution: string; triangles: number; drawCalls: number } };
    const gpu = await page.evaluate(() => window.__wb!.gpu);
    const all = segments.reduce((s, x) => s + x.frames, 0);
    const result = {
      backend,
      quality: QUALITY,
      gpu,
      viewport: page.viewportSize(),
      resolution: stats.render.resolution,
      fpsMean: +(segments.reduce((s, x) => s + x.fps * x.frames, 0) / all).toFixed(1),
      fpsMinSegment: +Math.min(...segments.map((s) => s.fps)).toFixed(1),
      longFrames: segments.reduce((s, x) => s + x.longFrames, 0),
      simTicksPerSecond: +((tick1 - tick0) / seconds).toFixed(1),
      segments: segments.map((s) => ({ ...s, fps: +s.fps.toFixed(1), frameMsP95: +s.frameMsP95.toFixed(1), frameMsP99: +s.frameMsP99.toFixed(1), frameMsMax: +s.frameMsMax.toFixed(1) })),
      errors,
    };
    writeFileSync(`${RESULTS}/phase2-flyover-${backend}-${QUALITY}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ backend, quality: QUALITY, fpsMean: result.fpsMean, fpsMinSegment: result.fpsMinSegment, longFrames: result.longFrames, tps: result.simTicksPerSecond }));
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
