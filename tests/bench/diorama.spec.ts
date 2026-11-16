// Прототип 1A: скриншоты диорамы с разных ракурсов и замер частоты кадров
// на WebGPU и WebGL 2 для трёх пресетов качества. Запуск: npm run bench -- diorama
//   -g "снимки"  — только скриншоты;  -g "кадры" — только замеры.

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { DioramaStats } from '../../prototypes/diorama/diorama';

const SHOTS = 'docs/screenshots/phase1a';
const RESULTS = 'docs/measurements';
mkdirSync(SHOTS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`/prototypes/diorama/index.html?${query}`);
  await page
    .waitForFunction(() => window.__diorama?.ready === true || /Не удалось/.test(document.getElementById('loading')?.textContent ?? ''), undefined, { timeout: 240_000 })
    .catch(() => undefined);
  const failure = await page.evaluate(() => (window.__diorama?.ready ? '' : (document.getElementById('loading')?.textContent ?? 'нет ответа')));
  if (failure) throw new Error(`Диорама не построилась: ${failure}\n${errors.join('\n')}`);
  return errors;
}

type View = { name: string; hour: number; run: string; ui?: boolean };

const VIEWS: View[] = [
  { name: '01-obzor-den', hour: 10.5, run: `d.focus('overview')` },
  { name: '02-obzor-zakat', hour: 17.25, run: `d.setView({ target: [2, 3, 2], yaw: 1.05, pitch: 0.62, distance: 285 })` },
  { name: '03-obzor-noch', hour: 22.5, run: `d.setView({ target: [8, 3, -4], yaw: 0.45, pitch: 0.66, distance: 230 })` },
  { name: '04-dom-den', hour: 15.4, run: `d.focus('house')` },
  { name: '05-dom-noch', hour: 21.3, run: `d.focus('house')` },
  { name: '06-vodopad', hour: 9.5, run: `d.focus('waterfall')` },
  { name: '07-olen', hour: 16.8, run: `d.focus('stag')` },
  { name: '08-samka-i-olenenok', hour: 8.2, run: `d.focus('doe')` },
  { name: '09-zhitel', hour: 12.5, run: `d.focus('farmer')` },
  { name: '10-most-i-reka', hour: 16.9, run: `d.setMode('free'); d.setView({ target: [-6, 2.2, 6], yaw: 2.5, pitch: 0.2, distance: 24 })` },
  { name: '11-lug-cvety', hour: 14, run: `d.setMode('free'); d.setView({ target: [-30, 3.2, 40], yaw: -0.9, pitch: 0.12, distance: 13 })` },
  { name: '12-interfeys', hour: 15, run: `d.focus('overview')`, ui: true },
];

const SHOT_SETS: { backend: 'webgpu' | 'webgl2'; quality: string; views: string[] | null }[] = [
  { backend: 'webgpu', quality: 'high', views: null },
  { backend: 'webgl2', quality: 'medium', views: ['01-obzor-den', '04-dom-den', '05-dom-noch', '07-olen'] },
  { backend: 'webgpu', quality: 'low', views: ['01-obzor-den', '04-dom-den'] },
];

for (const set of SHOT_SETS) {
  test(`снимки: ${set.backend}, ${set.quality}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const errors = await open(page, `renderer=${set.backend}&quality=${set.quality}`);
    for (const view of VIEWS) {
      if (set.views && !set.views.includes(view.name)) continue;
      await page.evaluate(
        ({ hour, run, ui }) => {
          const d = window.__diorama!;
          d.hideUi(!ui);
          d.setHour(hour);
          new Function('d', run)(d);
        },
        { hour: view.hour, run: view.run, ui: view.ui ?? false },
      );
      // Существа должны успеть пройти несколько шагов, дым — подняться.
      await page.waitForTimeout(view.name.startsWith('0') && Number(view.name.slice(0, 2)) >= 7 ? 4500 : 2500);
      await page.screenshot({ path: `${SHOTS}/${view.name}-${set.backend}-${set.quality}.png` });
    }
    const stats = await page.evaluate(() => window.__diorama!.stats());
    expect(stats.backend).toBe(set.backend);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

const SEGMENTS: { name: string; run: string }[] = [
  { name: 'Стратегический обзор', run: `d.focus('overview')` },
  { name: 'Свободная камера у дома', run: `d.focus('house')` },
  { name: 'Свободная камера рядом с оленем', run: `d.focus('stag')` },
];

for (const backend of ['webgpu', 'webgl2'] as const) {
  for (const quality of ['low', 'medium', 'high'] as const) {
    test(`кадры: ${backend}, ${quality}`, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      const errors = await open(page, `renderer=${backend}&quality=${quality}&ui=0`);
      const results: (DioramaStats & { view: string })[] = [];
      for (const segment of SEGMENTS) {
        await page.evaluate((run) => new Function('d', run)(window.__diorama!), segment.run);
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.__diorama!.resetStats());
        await page.waitForTimeout(6000);
        results.push({ view: segment.name, ...(await page.evaluate(() => window.__diorama!.stats())) });
      }
      writeFileSync(`${RESULTS}/phase1a-fps-${backend}-${quality}.json`, JSON.stringify(results, null, 2));
      expect(results[0]!.backend).toBe(backend);
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }
}
