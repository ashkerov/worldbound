// Сквозная проверка запуска на обоих графических путях: WebGPU и WebGL 2.
// Запускается в установленном системном браузере на реальном графическом стеке машины.

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../src/app/debugHandle';

const SHOTS = 'docs/screenshots';
const RESULTS = 'docs/measurements';
mkdirSync(SHOTS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

interface Stats {
  sim: { tick: number; ticksPerSecond: number; tickMsAvg: number; tickMsMax: number; droppedTicks: number; agents: number } | null;
  render: { backend: string; fps: number; frameMsAvg: number; frameMsMax: number; drawCalls: number; triangles: number } | null;
}

async function open(page: Page, renderer: 'webgpu' | 'webgl2', agents = 300): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`/?renderer=${renderer}&agents=${agents}&seed=worldbound`);
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 60_000 });
  await expect(page.getByTestId('time-panel')).toBeVisible();
  return errors;
}

const tick = (page: Page) => page.evaluate(() => window.__wb!.getTick());
const stats = (page: Page) => page.evaluate(() => window.__wb!.getStats() as unknown) as Promise<Stats>;

for (const renderer of ['webgpu', 'webgl2'] as const) {
  test.describe(`Графический путь: ${renderer}`, () => {
    test('приложение запускается, мир рисуется, симуляция идёт', async ({ page }) => {
      const errors = await open(page, renderer);

      // Запрошенный графический путь действительно используется.
      const backend = await page.evaluate(() => window.__wb!.backend);
      expect(backend, 'если здесь webgl2 при запросе webgpu — WebGPU недоступен в этом браузере').toBe(renderer);
      await expect(page.getByTestId('backend')).toHaveText(renderer === 'webgpu' ? 'WebGPU' : 'WebGL 2');

      // Такты идут примерно с частотой 10/с на ×1.
      await page.waitForTimeout(1500);
      const t0 = await tick(page);
      await page.waitForTimeout(3000);
      const t1 = await tick(page);
      expect(t1 - t0).toBeGreaterThan(20);
      expect(t1 - t0).toBeLessThan(40);

      // Агенты на экране движутся между кадрами (интерполяция работает).
      const p0 = await page.evaluate(() => window.__wb!.sampleAgents(20));
      await page.waitForTimeout(400);
      const p1 = await page.evaluate(() => window.__wb!.sampleAgents(20));
      expect(p0.length).toBe(40);
      expect(p0.some((value, i) => Math.abs(value - p1[i]!) > 0.05)).toBe(true);

      // Замеры имеют смысл только на аппаратной отрисовке.
      const gpu = await page.evaluate(() => window.__wb!.gpu);
      writeFileSync(`${RESULTS}/phase0-gpu-${renderer}.json`, JSON.stringify(gpu, null, 2));
      expect(gpu.software, `программная отрисовка: ${gpu.adapter}`).toBe(false);

      await page.waitForTimeout(1500);
      const s = await stats(page);
      expect(s.render!.fps).toBeGreaterThan(5);
      expect(s.render!.triangles).toBeGreaterThan(1000);
      expect(s.sim!.agents).toBe(300);

      await page.screenshot({ path: `${SHOTS}/phase0-${renderer}.png` });
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('пауза и скорости ×1–×8 работают', async ({ page }) => {
      await open(page, renderer);

      await page.getByTestId('speed-0').click();
      await page.waitForTimeout(1200);
      const paused0 = await tick(page);
      await page.waitForTimeout(1500);
      expect(await tick(page)).toBe(paused0);
      await expect(page.getByTestId('speed-0')).toHaveAttribute('aria-pressed', 'true');

      const rates: Record<string, number> = {};
      for (const speed of [1, 2, 4, 8]) {
        await page.getByTestId(`speed-${speed}`).click();
        await page.waitForTimeout(1500);
        const a = await tick(page);
        await page.waitForTimeout(3000);
        const b = await tick(page);
        const rate = (b - a) / 3;
        rates[`x${speed}`] = +rate.toFixed(1);
        expect(rate, `скорость ×${speed}`).toBeGreaterThan(speed * 10 * 0.75);
        expect(rate, `скорость ×${speed}`).toBeLessThan(speed * 10 * 1.25);
      }
      writeFileSync(`${RESULTS}/phase0-speeds-${renderer}.json`, JSON.stringify(rates, null, 2));
    });

    test('команды создателя доходят до симуляции, хранилище OPFS работает', async ({ page }) => {
      await open(page, renderer);

      await page.getByTestId('spawn').click();
      await expect(page.getByTestId('agents')).toHaveText('1300', { timeout: 5000 });
      await page.getByTestId('clear').click();
      await expect(page.getByTestId('agents')).toHaveText('0', { timeout: 5000 });

      await page.getByTestId('storage-check').click();
      await expect(page.getByTestId('storage-result')).toContainText('opfs: исправно', { timeout: 15_000 });
    });

    test('нагрузка: 8000 агентов на ×1 и ×8', async ({ page }) => {
      await open(page, renderer, 8000);
      await page.waitForTimeout(4000);
      const x1 = await stats(page);
      await page.screenshot({ path: `${SHOTS}/phase0-${renderer}-8000-agents.png` });
      await page.getByTestId('speed-8').click();
      await page.waitForTimeout(5000);
      const x8 = await stats(page);
      writeFileSync(`${RESULTS}/phase0-load-${renderer}.json`, JSON.stringify({ agents: 8000, x1, x8 }, null, 2));
      expect(x1.sim!.agents).toBe(8000);
      expect(x1.render!.fps).toBeGreaterThan(5);
    });
  });
}

test('состояние симуляции в браузере совпадает с эталоном Node при том же seed', async ({ page }) => {
  // Тот же seed и ноль агентов: состояние определяется только генерацией рельефа,
  // которая обязана быть побитно одинаковой в любом движке.
  await page.goto('/?renderer=webgl2&agents=0&seed=42');
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: 60_000 });
  await page.getByTestId('speed-0').click();
  await page.waitForTimeout(1200);
  const { tick: atTick, hash } = await page.evaluate(() => window.__wb!.stateHash());
  const { Simulation } = await import('../../src/sim/core/simulation');
  const reference = new Simulation({ seed: 42, worldSize: 512, testAgents: 0 });
  reference.enqueue({ type: 'setSpeed', speed: 0 });
  for (let i = 0; i < atTick; i++) reference.step();
  reference.applyCommands();
  expect(hash).toBe(reference.stateHash());
});
