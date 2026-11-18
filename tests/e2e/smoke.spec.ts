// Сквозные проверки игры на обоих графических путях (WebGPU и WebGL 2) в системном браузере:
// создание мира, время и скорости, слои, карточка ячейки, камера, сохранение и загрузка, детерминизм.

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../src/app/debugHandle';
import { Simulation } from '../../src/sim/core/simulation';

// Результаты сквозных тестов — отдельно от доказательств отчётов фаз: тесты не должны их перезаписывать.
const SHOTS = 'docs/screenshots/e2e';
const RESULTS = 'docs/measurements';
mkdirSync(SHOTS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function autostart(page: Page, renderer: 'webgpu' | 'webgl2', query = ''): Promise<string[]> {
  const errors = watchErrors(page);
  // Wildlands с подготовкой в 1 год: проверки рендера и интерфейса не ждут полный 20-летний прогон
  // (его время в браузере меряет tests/bench/wildlands.spec.ts).
  await page.goto(`/?renderer=${renderer}&autostart=1&seed=42&size=S&prepare=1&debug=1${query}`);
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 120_000 });
  await expect(page.getByTestId('time-panel')).toBeVisible();
  return errors;
}

const tick = (page: Page) => page.evaluate(() => window.__wb!.getTick());

for (const renderer of ['webgpu', 'webgl2'] as const) {
  test.describe(`Графический путь: ${renderer}`, () => {
    test('мир создаётся и рисуется, время идёт, агенты движутся', async ({ page }) => {
      const errors = await autostart(page, renderer, '&agents=300');
      expect(await page.evaluate(() => window.__wb!.backend)).toBe(renderer);
      await expect(page.getByTestId('backend')).toHaveText(renderer === 'webgpu' ? 'WebGPU' : 'WebGL 2');
      const gpu = await page.evaluate(() => window.__wb!.gpu);
      expect(gpu.software, `программная отрисовка: ${gpu.adapter}`).toBe(false);

      await page.waitForTimeout(1500);
      const t0 = await tick(page);
      await page.waitForTimeout(3000);
      const t1 = await tick(page);
      expect(t1 - t0).toBeGreaterThan(20);
      expect(t1 - t0).toBeLessThan(40);

      const p0 = await page.evaluate(() => window.__wb!.sampleAgents(20));
      await page.waitForTimeout(400);
      const p1 = await page.evaluate(() => window.__wb!.sampleAgents(20));
      expect(p0.length).toBe(40);
      expect(p0.some((value, i) => Math.abs(value - p1[i]!) > 0.05)).toBe(true);

      const stats = (await page.evaluate(() => window.__wb!.getStats())) as { render: { fps: number; triangles: number; terrainNodes: number } };
      expect(stats.render.fps).toBeGreaterThan(5);
      expect(stats.render.triangles).toBeGreaterThan(10_000);
      expect(stats.render.terrainNodes).toBeGreaterThan(3);
      await page.screenshot({ path: `${SHOTS}/e2e-${renderer}.png` });
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('пауза и скорости ×1–×8 работают', async ({ page }) => {
      await autostart(page, renderer);
      await page.getByTestId('speed-0').click();
      await page.waitForTimeout(1200);
      const paused = await tick(page);
      await page.waitForTimeout(1500);
      expect(await tick(page)).toBe(paused);
      const rates: Record<string, number> = {};
      for (const speed of [1, 2, 4, 8]) {
        await page.getByTestId(`speed-${speed}`).click();
        await page.waitForTimeout(1500);
        const a = await tick(page);
        await page.waitForTimeout(3000);
        const rate = ((await tick(page)) - a) / 3;
        rates[`x${speed}`] = +rate.toFixed(1);
        expect(rate, `скорость ×${speed}`).toBeGreaterThan(speed * 10 * 0.75);
        expect(rate, `скорость ×${speed}`).toBeLessThan(speed * 10 * 1.25);
      }
      writeFileSync(`${RESULTS}/e2e-speeds-${renderer}.json`, JSON.stringify(rates, null, 2));
    });

    test('слои, карточка ячейки, камера и скрытие интерфейса', async ({ page }) => {
      const errors = await autostart(page, renderer);
      for (const id of ['height', 'moisture', 'temperature', 'precipitation', 'snow', 'soil']) {
        await page.getByTestId(`layer-${id}`).click();
        await expect(page.getByTestId('legend')).toBeVisible();
        await expect(page.getByTestId('legend').locator('.wb-legend-row').first()).toBeVisible();
      }
      await page.getByTestId('layer-provinces').click();
      await page.screenshot({ path: `${SHOTS}/layer-provinces-${renderer}.png` });
      await page.getByTestId('layer-none').click();

      // Карточка: щелчок по середине мира.
      await page.evaluate(() => window.__wb!.pick(1024, 1024));
      const card = page.getByTestId('cell-card');
      await expect(card).toBeVisible();
      await expect(page.getByTestId('cell-temperature')).toContainText('°C');
      await expect(page.getByTestId('cell-height')).toContainText('м');
      // Настоящий щелчок мышью по экрану тоже выбирает ячейку.
      await page.mouse.click(640, 420);
      await expect(card).toBeVisible();

      await page.getByTestId('camera-mode').click();
      await expect(page.getByTestId('camera-mode')).toHaveText('Камера: свободная');
      expect(await page.evaluate(() => window.__wb!.getView().mode)).toBe('free');
      await page.keyboard.press('KeyH');
      await expect(page.getByTestId('hud-hidden')).toBeVisible();
      await page.keyboard.press('KeyH');
      await expect(page.getByTestId('time-panel')).toBeVisible();
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}

test('меню: создать мир → сохранить → выйти → открыть: состояние совпало; удалить', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?renderer=webgpu');
  await expect(page.getByTestId('main-menu')).toBeVisible();
  await page.getByTestId('new-world').click();
  await page.getByTestId('world-name').fill('Проверочная долина');
  await page.getByTestId('world-seed').fill('777');
  await page.getByTestId('size-S').click();
  await page.getByTestId('season-3').click();
  await page.getByTestId('climate-cold').click();
  await page.getByTestId('scenario-genesis').click();
  await page.getByTestId('world-isolated').check();
  await expect(page.getByTestId('scenario-note')).toContainText('Пустая земля');
  await page.getByTestId('create-submit').click();
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 120_000 });
  await page.getByTestId('speed-8').click();
  await page.waitForTimeout(2500);
  await page.getByTestId('speed-0').click();
  await page.waitForTimeout(800);
  await page.getByTestId('save-now').click();
  await expect(page.getByTestId('save-status')).toContainText('Сохранено');
  const saved = await page.evaluate(() => window.__wb!.stateHash());
  expect(saved.tick).toBeGreaterThan(0);

  await page.getByTestId('exit-menu').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
  const item = page.getByTestId('world-item').filter({ hasText: 'Проверочная долина' });
  await expect(item).toBeVisible();
  await item.getByTestId('open-world').click();
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 120_000 });
  const loaded = await page.evaluate(() => window.__wb!.stateHash());
  expect(loaded).toEqual(saved);

  await page.getByTestId('exit-menu').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
  const again = page.getByTestId('world-item').filter({ hasText: 'Проверочная долина' });
  await again.getByTestId('delete-world').click();
  await again.getByTestId('confirm-delete').click();
  await expect(page.getByTestId('world-item').filter({ hasText: 'Проверочная долина' })).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('мир в браузере побитно совпадает с эталоном Node при том же seed', async ({ page }, info) => {
  await page.goto('/?renderer=webgl2&autostart=1&seed=42&size=S&prepare=1');
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 120_000 });
  await page.getByTestId('speed-0').click();
  await page.waitForTimeout(1200);
  const browser = await page.evaluate(() => window.__wb!.stateHash());
  // Эталон проходит ту же подготовку Wildlands (1 год), что и мир в браузере.
  const reference = new Simulation({ config: { seed: 42, size: 'S', name: 'Проверка 42' }, testAgents: 0, prepareYears: 1 });
  expect(browser.geoHash).toBe(reference.world.geoHash);
  reference.enqueue({ type: 'setSpeed', speed: 0 });
  while (reference.world.tick < browser.tick) reference.step();
  reference.applyCommands();
  expect(browser.hash).toBe(reference.stateHash());
  const channel = String(info.project.use.channel ?? 'msedge');
  writeFileSync(`${RESULTS}/e2e-determinism-${channel}.json`, JSON.stringify({ browser: channel, geoHash: browser.geoHash, tick: browser.tick, hash: browser.hash, node: reference.stateHash() }, null, 2));
});

test('Wildlands: прогресс подготовки виден и честен, создание можно отменить', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?renderer=webgl2&autostart=1&seed=5&size=S&prepare=20');
  await expect(page.getByTestId('progress-stage')).toContainText('Природа развивается: год', { timeout: 60_000 });
  await expect(page.getByTestId('progress-detail')).toContainText('осталось около', { timeout: 30_000 });
  // Прогресс растёт, интерфейс отвечает.
  const first = await page.getByTestId('progress-detail').textContent();
  await page.waitForTimeout(3000);
  const second = await page.getByTestId('progress-detail').textContent();
  expect(second).not.toBe(first);
  await page.getByTestId('progress-cancel').click();
  await expect(page.getByTestId('main-menu')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('notice')).toContainText('отменено');
  // Неготовый мир не сохранился.
  await expect(page.getByTestId('world-item').filter({ hasText: 'Проверка 5' })).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Wildlands: подготовленный мир открывается, в карточке — биом и растения', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?renderer=webgl2&autostart=1&seed=42&size=S&prepare=3&debug=1');
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 120_000 });
  await page.getByTestId('speed-0').click();
  await page.getByTestId('layer-biomes').click();
  await expect(page.getByTestId('legend')).toContainText('Луг');
  await page.screenshot({ path: `${SHOTS}/wildlands-3y-biomes.png` });
  await page.evaluate(() => window.__wb!.pick(1024, 1024));
  await expect(page.getByTestId('cell-card')).toBeVisible();
  await expect(page.getByTestId('cell-biome')).not.toBeEmpty();
  await expect(page.getByTestId('cell-herbs')).toContainText('г/м²');
  await expect(page.getByTestId('cell-woody')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
