// Стенды фазы 1: нагрузка симуляции (1D) в воркере браузера и нагрузка рендера (1B)
// на обоих графических путях и в двух разрешениях. Результаты — в docs/measurements.

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type {} from '../../prototypes/bench/simPage';
import type {} from '../../prototypes/bench/renderBench';

const RESULTS = 'docs/measurements';
const SHOTS = 'docs/screenshots';
mkdirSync(RESULTS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

test('1D: нагрузка симуляции в воркере браузера', async ({ page }) => {
  await page.goto('/prototypes/bench/sim.html');
  await page.waitForFunction(() => window.__simBench !== undefined, undefined, { timeout: 540_000 });
  const report = await page.evaluate(() => window.__simBench!);
  writeFileSync(`${RESULTS}/phase1d-browser.json`, JSON.stringify(report, null, 2));
  expect(report.agents.length).toBe(4);
});

const VARIANTS: { name: string; renderer: 'webgpu' | 'webgl2'; width: number; height: number; query: string }[] = [
  { name: 'webgpu-720p', renderer: 'webgpu', width: 1280, height: 720, query: '' },
  { name: 'webgl2-720p', renderer: 'webgl2', width: 1280, height: 720, query: '' },
  { name: 'webgpu-1080p', renderer: 'webgpu', width: 1920, height: 1080, query: '' },
  { name: 'webgl2-1080p', renderer: 'webgl2', width: 1920, height: 1080, query: '' },
  { name: 'webgpu-1080p-no-shadows', renderer: 'webgpu', width: 1920, height: 1080, query: '&shadows=0' },
  { name: 'webgpu-1080p-low', renderer: 'webgpu', width: 1920, height: 1080, query: '&shadows=0&grass=20000&trees=150000&creatures=1000' },
];

for (const variant of VARIANTS) {
  test(`1B: нагрузка рендера — ${variant.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.goto(`/prototypes/bench/render.html?renderer=${variant.renderer}${variant.query}`);
    await page.waitForFunction(() => window.__renderBench !== undefined, undefined, { timeout: 540_000 });
    const report = await page.evaluate(() => window.__renderBench!);
    writeFileSync(`${RESULTS}/phase1b-${variant.name}.json`, JSON.stringify(report, null, 2));
    await page.screenshot({ path: `${SHOTS}/phase1b-${variant.name}.png` });
    expect(report.backend).toBe(variant.renderer);
    expect(report.segments.length).toBe(3);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
