// Стенд этапа 4 фазы 3: время создания мира Wildlands (20 игровых лет подготовки) в воркере браузера —
// так, как его ждёт игрок: от нажатия «Создать» до открытого мира. Прогресс снимается раз в секунду.
// Запуск: npx playwright test --config playwright.bench.config.ts tests/bench/wildlands.spec.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type {} from '../../src/app/debugHandle';
import { codeVersion } from '../../tools/lib/commit';

const RESULTS = 'docs/measurements';
const SHOTS = 'docs/screenshots/phase3-stage4';
mkdirSync(RESULTS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

for (const size of ['S', 'M'] as const) {
  test(`Wildlands ${size}: создание мира в браузере`, async ({ page }) => {
    test.setTimeout(1_500_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 720 });
    const start = Date.now();
    await page.goto(`/?renderer=webgpu&autostart=1&seed=42&size=${size}&debug=1`);
    const samples: { s: number; stage: string; detail: string }[] = [];
    let screenshotTaken = false;
    while (!(await page.evaluate(() => window.__wb?.ready === true))) {
      const stage = (await page.getByTestId('progress-stage').textContent().catch(() => '')) ?? '';
      const detail = (await page.getByTestId('progress-detail').textContent().catch(() => '')) ?? '';
      samples.push({ s: +((Date.now() - start) / 1000).toFixed(1), stage, detail });
      if (!screenshotTaken && stage.includes('год 10')) {
        await page.screenshot({ path: `${SHOTS}/wildlands-${size}-progress.png` });
        screenshotTaken = true;
      }
      await page.waitForTimeout(1000);
    }
    const totalS = (Date.now() - start) / 1000;
    const prep = samples.filter((x) => x.stage.startsWith('Природа развивается'));
    await page.getByTestId('speed-0').click();
    await page.getByTestId('layer-biomes').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/wildlands-${size}-biomes.png` });
    await page.getByTestId('layer-none').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/wildlands-${size}-world.png` });
    const hash = await page.evaluate(() => window.__wb!.stateHash());
    writeFileSync(
      `${RESULTS}/phase3-stage4-wildlands-browser-${size}.json`,
      JSON.stringify(
        {
          ...codeVersion(),
          size,
          seed: 42,
          years: 20,
          totalSeconds: +totalS.toFixed(1),
          preparationSeconds: prep.length ? +(prep.at(-1)!.s - prep[0]!.s).toFixed(1) : null,
          tick: hash.tick,
          stateHash: hash.hash,
          progressSamples: samples.filter((_, k) => k % 5 === 0 || k === samples.length - 1),
        },
        null,
        1,
      ),
    );
    expect(prep.length).toBeGreaterThan(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

// Genesis для сравнения: тот же seed и размер — пустая земля без подготовки; снимки слоя биомов и мира.
test('Genesis S: пустой мир (снимки)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?renderer=webgpu&autostart=1&seed=42&size=S&scenario=genesis&debug=1');
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 120_000 });
  await page.getByTestId('speed-0').click();
  await page.getByTestId('layer-biomes').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/genesis-S-biomes.png` });
  await page.getByTestId('layer-none').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/genesis-S-world.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});
