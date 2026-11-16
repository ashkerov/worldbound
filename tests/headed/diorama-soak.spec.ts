// Диорама в обычном видимом окне браузера: частота кадров, длинные кадры, стабильность
// и совместная работа с воркером симуляции. Отдельно WebGPU и WebGL 2.
// Запуск: npm run test:headed   (WB_SOAK_SECONDS задаёт длительность прогона на устойчивость)

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { DioramaStats } from '../../prototypes/diorama/diorama';

const RESULTS = 'docs/measurements';
const SHOTS = 'docs/screenshots/phase1';
mkdirSync(RESULTS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const SOAK_SECONDS = Number(process.env.WB_SOAK_SECONDS ?? 120);
const TAG = process.env.WB_TAG ? '-' + process.env.WB_TAG : '';
const BACKENDS = (process.env.WB_BACKENDS ?? 'webgpu,webgl2').split(',') as ('webgpu' | 'webgl2')[];
const VIEWS = ['overview', 'house', 'stag', 'waterfall', 'farmer', 'doe'];

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`/prototypes/diorama/index.html?${query}`);
  await page.waitForFunction(() => window.__diorama?.ready === true, undefined, { timeout: 240_000 });
  return errors;
}

/** Окно замера: сменить ракурс, дать камере доехать, сбросить счётчики, подождать. */
async function measure(page: Page, view: string, seconds: number): Promise<DioramaStats & { view: string }> {
  await page.evaluate((name) => window.__diorama!.focus(name), view);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__diorama!.resetStats());
  await page.waitForTimeout(seconds * 1000);
  return { view, ...(await page.evaluate(() => window.__diorama!.stats())) };
}

for (const backend of BACKENDS) {
  test(`видимое окно, ${backend}: кадры, длинные кадры, совместная работа с симуляцией`, async ({ page }) => {
    // 1. Только рендер, средний пресет.
    let errors = await open(page, `renderer=${backend}&quality=medium&ui=0`);
    const renderOnly = [];
    for (const view of VIEWS.slice(0, 4)) renderOnly.push(await measure(page, view, 8));
    expect(renderOnly[0]!.backend).toBe(backend);
    expect(errors, errors.join('\n')).toEqual([]);

    // 2. Рендер + воркер симуляции: 5000 агентов на скорости ×8 и сутки пищевой сети раз в 5 секунд.
    //    Ход времени включён, ракурс меняется — прогон на устойчивость.
    errors = await open(page, `renderer=${backend}&quality=medium&ui=0&auto=1&sim=5000&simSpeed=8`);
    const joint = [];
    const span = 10;
    for (let k = 0; k * (span + 1.2) < SOAK_SECONDS; k++) joint.push(await measure(page, VIEWS[k % VIEWS.length]!, span));
    await page.evaluate(() => window.__diorama!.hideUi(false));
    await page.screenshot({ path: `${SHOTS}/soak-${backend}${TAG}.png` });
    const last = joint[joint.length - 1]!;

    writeFileSync(`${RESULTS}/phase1-headed-${backend}${TAG}.json`, JSON.stringify({ backend, userAgent: await page.evaluate(() => navigator.userAgent), renderOnly, joint, errors }, null, 2));
    expect(last.contextLost).toBe(false);
    expect(last.sim).not.toBeNull();
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
