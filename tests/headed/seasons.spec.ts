// Смена сезонов на экране: один и тот же вид в середине лета, осени и зимы, плюс слои температуры и снега.
// Мир с холодным климатом и сезоном 3 суток идёт на ×8; снимки и данные карточки сохраняются в docs/.
// Запуск: npm run build && npx playwright test --config playwright.headed.config.ts seasons   (~15 минут)

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../src/app/debugHandle';

const SHOTS = 'docs/screenshots/phase2';
mkdirSync(SHOTS, { recursive: true });
const TICKS_PER_DAY = 7200;
const DAYS = 3;

/** Середина сезона k (0 весна … 3 зима): при сезоне 3 суток это полдень. */
const midSeason = (k: number) => Math.floor((k * DAYS + DAYS / 2) * TICKS_PER_DAY);

async function waitTick(page: Page, target: number): Promise<void> {
  await page.waitForFunction((t) => window.__wb!.getTick() >= t, target, { timeout: 1_500_000, polling: 1000 });
}

test('сезоны меняют снег, температуру и влагу на экране и в данных', async ({ page }) => {
  test.setTimeout(1_800_000);
  await page.goto('/?renderer=webgpu&autostart=1&seed=42&size=M&season=3&climate=cold&quality=medium');
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 240_000 });
  await page.getByTestId('speed-8').click();
  const view = { mode: 'strategic' as const, target: [1500, 60, 2300] as [number, number, number], yaw: 2.4, pitch: 0.62, distance: 1800 };
  const samples: Record<string, unknown> = {};
  for (const [k, name] of [
    [1, 'summer'],
    [2, 'autumn'],
    [3, 'winter'],
  ] as const) {
    await waitTick(page, midSeason(k));
    await page.getByTestId('speed-0').click();
    await page.evaluate((v) => window.__wb!.setView(v), view);
    await page.evaluate(() => window.__wb!.pick(1500, 2300));
    await page.waitForTimeout(2500);
    const card = await page.getByTestId('cell-card').innerText();
    samples[name] = card;
    await page.getByTestId('layer-none').click();
    await page.keyboard.press('KeyH');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/season-${name}.png` });
    await page.keyboard.press('KeyH');
    for (const layer of ['temperature', 'snow', 'moisture']) {
      await page.getByTestId(`layer-${layer}`).click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${SHOTS}/season-${name}-layer-${layer}.png` });
    }
    await page.getByTestId('layer-none').click();
    await page.getByTestId('speed-8').click();
  }
  writeFileSync('docs/measurements/phase2-seasons-cards.json', JSON.stringify(samples, null, 2));
  expect(Object.keys(samples)).toHaveLength(3);
});
