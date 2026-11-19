// Стенд этапа 5 фазы 3: производительность рендера растительности в видимом браузере (WB_HEADED=1),
// WebGPU и WebGL 2, средний пресет. Сценарии на одном мире: стратегический обзор, свободная камера в лесу,
// облёт через разные биомы. Миры: Wildlands M (сотни тысяч древесных после подготовки) и мир M с 300 тыс.
// деревьев (стенд, как tools/flora-load.ts). Мир создаётся один раз и открывается вторым рендером из сохранения.
// Запуск: WB_HEADED=1 npx playwright test --config playwright.bench.config.ts tests/bench/flora.spec.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../src/app/debugHandle';
import { codeVersion } from '../../tools/lib/commit';

const RESULTS = 'docs/measurements';
const SHOTS = 'docs/screenshots/phase3-stage5';
mkdirSync(RESULTS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

interface Sample {
  fps: number;
  frameMsAvg: number;
  frameMsMax: number;
  longFrames: number;
  drawCalls: number;
  triangles: number;
  flora: { lod0: number; lod1: number; impostors: number; grass: number; meshes: number; rebuildMs: number; woodyTotal: number } | null;
}

async function waitReady(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout: timeoutMs, polling: 1000 });
}

/** Окна статистики рендера (по 0,5 с) за время ms. */
async function sample(page: Page, ms: number): Promise<Sample[]> {
  const out: Sample[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.waitForTimeout(500);
    const s = (await page.evaluate(() => (window.__wb!.getStats() as { render: Sample }).render)) as Sample;
    out.push({ fps: s.fps, frameMsAvg: s.frameMsAvg, frameMsMax: s.frameMsMax, longFrames: s.longFrames, drawCalls: s.drawCalls, triangles: s.triangles, flora: s.flora });
  }
  return out;
}

function summarize(samples: Sample[]) {
  const fps = samples.map((s) => s.fps).sort((a, b) => a - b);
  const frame = samples.map((s) => s.frameMsAvg);
  const pick = (p: number) => +fps[Math.min(fps.length - 1, Math.floor(p * fps.length))]!.toFixed(1);
  return {
    windows: samples.length,
    fpsMean: +(fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1),
    fpsP5: pick(0.05),
    fpsMin: +fps[0]!.toFixed(1),
    frameMsMean: +(frame.reduce((a, b) => a + b, 0) / frame.length).toFixed(1),
    frameMsMax: +Math.max(...samples.map((s) => s.frameMsMax)).toFixed(1),
    framesOver100ms: samples.reduce((a, s) => a + s.longFrames, 0),
    drawCallsMax: Math.max(...samples.map((s) => s.drawCalls)),
    trianglesMax: Math.max(...samples.map((s) => s.triangles)),
    lod0Max: Math.max(...samples.map((s) => s.flora?.lod0 ?? 0)),
    lod1Max: Math.max(...samples.map((s) => s.flora?.lod1 ?? 0)),
    impostorsMax: Math.max(...samples.map((s) => s.flora?.impostors ?? 0)),
    grassMax: Math.max(...samples.map((s) => s.flora?.grass ?? 0)),
    rebuildMsMax: +Math.max(...samples.map((s) => s.flora?.rebuildMs ?? 0)).toFixed(1),
    woodyTotal: samples.at(-1)?.flora?.woodyTotal ?? 0,
  };
}

/** Самое густое место леса (по данным растений в рендере) — для камеры «в лесу». */
async function densestForest(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const wb = window.__wb!;
    const size = wb.worldSize();
    const all = wb.flora.plantsNear(size / 2, size / 2, size);
    const cell = 64;
    const grid = new Map<string, number>();
    for (const p of all) if (p.height > 6) {
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
      grid.set(key, (grid.get(key) ?? 0) + p.crown * p.crown);
    }
    let best = '';
    let bestV = -1;
    for (const [k, v] of grid) if (v > bestV) [best, bestV] = [k, v];
    const [gx, gz] = best.split(',').map(Number);
    return [(gx! + 0.5) * cell, (gz! + 0.5) * cell] as [number, number];
  });
}

async function scenarios(page: Page, tag: string, backend: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await page.getByTestId('speed-0').click();
  const size = await page.evaluate(() => window.__wb!.worldSize());
  // 1. Стратегический обзор всего мира.
  await page.evaluate((s) => window.__wb!.setView({ mode: 'strategic', target: [s / 2, 0, s / 2], yaw: 0.7, pitch: 0.95, distance: s * 0.95 }), size);
  await page.waitForTimeout(4000);
  out.strategic = summarize(await sample(page, 8000));
  await page.screenshot({ path: `${SHOTS}/${tag}-${backend}-strategic.png` });
  // 2. Обзор с высоты 300–400 м над лесом.
  const [fx, fz] = await densestForest(page);
  await page.evaluate(([x, z]) => window.__wb!.setView({ mode: 'strategic', target: [x!, window.__wb!.ground(x!, z!), z!], yaw: 0.9, pitch: 0.55, distance: 420 }), [fx, fz]);
  await page.waitForTimeout(4000);
  out.overForest = summarize(await sample(page, 8000));
  await page.screenshot({ path: `${SHOTS}/${tag}-${backend}-over-forest.png` });
  // 3. Свободная камера внутри леса.
  await page.evaluate(([x, z]) => window.__wb!.setView({ mode: 'free', target: [x!, window.__wb!.ground(x!, z!) + 2, z!], yaw: 0.4, pitch: 0.05, distance: 1 }), [fx, fz]);
  await page.waitForTimeout(4000);
  out.inForest = summarize(await sample(page, 8000));
  await page.screenshot({ path: `${SHOTS}/${tag}-${backend}-in-forest.png` });
  // 4. Облёт: низко над миром по прямой через разные биомы, 16 с.
  const flight: Sample[] = [];
  const steps = 32;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const x = size * (0.2 + 0.6 * t);
    const z = size * (0.3 + 0.4 * Math.sin(t * Math.PI));
    await page.evaluate(([px, pz]) => window.__wb!.setView({ mode: 'strategic', target: [px!, window.__wb!.ground(px!, pz!), pz!], yaw: 1.2, pitch: 0.42, distance: 160 }), [x, z]);
    flight.push(...(await sample(page, 500)));
  }
  out.flight = summarize(flight);
  return out;
}

async function openSaved(page: Page, renderer: string): Promise<void> {
  await page.goto(`/?renderer=${renderer}&debug=1`);
  await page.getByTestId('open-world').first().click();
  await waitReady(page, 300_000);
}

for (const kind of ['wildlands', 'trees300k'] as const) {
  test(`растительность: ${kind === 'wildlands' ? 'Wildlands M' : 'мир M с 300 тыс. деревьев'} — WebGPU и WebGL 2`, async ({ page }) => {
    test.setTimeout(3_600_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 720 });
    const create = kind === 'wildlands' ? '/?renderer=webgpu&autostart=1&seed=42&size=M&debug=1' : '/?renderer=webgpu&autostart=1&seed=42&size=M&debug=1&scenario=genesis&loadTrees=300000';
    const created = Date.now();
    await page.goto(create);
    await waitReady(page, 3_000_000);
    const createSeconds = (Date.now() - created) / 1000;
    const result: Record<string, unknown> = { ...codeVersion(), world: kind, size: 'M', seed: 42, quality: 'medium', viewport: '1280×720', headed: !!process.env.WB_HEADED, createSeconds };
    result.gpu = await page.evaluate(() => window.__wb!.gpu);
    const hashBefore = await page.evaluate(() => window.__wb!.stateHash());
    result.webgpu = await scenarios(page, kind, 'webgpu');
    result.workerMemory = await page.evaluate(() => (window.__wb!.getStats() as { sim: unknown }).sim);
    // Тот же мир — рендером WebGL 2 (из сохранения: мир не готовится заново).
    await page.evaluate(() => window.__wb!.setView({}));
    await openSaved(page, 'webgl2');
    const hashAfter = await page.evaluate(() => window.__wb!.stateHash());
    result.backendAfterReopen = await page.evaluate(() => window.__wb!.backend);
    result.webgl2 = await scenarios(page, kind, 'webgl2');
    result.stateHash = { before: hashBefore, afterReopenInWebGL2: hashAfter };
    writeFileSync(`${RESULTS}/phase3-stage5-flora-${kind}-M.json`, JSON.stringify(result, null, 1));
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
