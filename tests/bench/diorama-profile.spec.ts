// Профилирование диорамы методом исключения: что именно стоит кадра на целевой машине.
// Запуск: npm run bench -- diorama-profile
// Переменные: WB_PROFILE="имя=запрос;имя=запрос", WB_BACKENDS="webgpu,webgl2", WB_QUALITY=medium
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from '@playwright/test';
import type {} from '../../prototypes/diorama/diorama';

const DEFAULT = 'base=;post=post=0;bloom=bloom=0;taps=taps=1;shadow=shadow=0;every1=every=1;pr06=pr=0.6;lights=lights=0;grass=grass=0';
const VARIANTS = (process.env.WB_PROFILE ?? DEFAULT).split(';').map((v) => {
  const i = v.indexOf('=');
  return { name: v.slice(0, i), query: v.slice(i + 1) };
});
const BACKENDS = (process.env.WB_BACKENDS ?? 'webgpu,webgl2').split(',');
const QUALITY = process.env.WB_QUALITY ?? 'medium';

test('профиль диорамы', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const rows: Record<string, unknown>[] = [];
  for (const backend of BACKENDS) {
    for (const variant of VARIANTS) {
      await page.goto(`/prototypes/diorama/index.html?renderer=${backend}&quality=${QUALITY}&ui=0&${variant.query}`);
      await page.waitForFunction(() => window.__diorama?.ready === true, undefined, { timeout: 240_000 });
      const row: Record<string, unknown> = { backend, variant: variant.name };
      for (const view of ['overview', 'house']) {
        await page.evaluate((name) => window.__diorama!.focus(name), view);
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.__diorama!.resetStats());
        await page.waitForTimeout(4000);
        const s = await page.evaluate(() => window.__diorama!.stats());
        row[view] = +s.fps.toFixed(1);
        row[`${view}P99`] = +s.frameMsP99.toFixed(0);
        row.triangles = s.triangles;
        row.resolution = s.resolution;
      }
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  mkdirSync('docs/measurements', { recursive: true });
  writeFileSync(`docs/measurements/phase1a-profile-${QUALITY}.json`, JSON.stringify(rows, null, 2));
});
