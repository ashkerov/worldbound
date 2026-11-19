// Стенд этапа 5 фазы 3: снимки растительности и проверки B, C, D, E, F, G в видимом браузере (WB_HEADED=1).
// Места находятся по данным растений (window.__wb.flora.findSpots), а не задаются вручную.
// Запуск: WB_HEADED=1 npx playwright test --config playwright.bench.config.ts tests/bench/showcase.spec.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../src/app/debugHandle';
import { codeVersion } from '../../tools/lib/commit';

const SHOTS = 'docs/screenshots/phase3-stage5';
const RESULTS = 'docs/measurements';
mkdirSync(SHOTS, { recursive: true });
const TICKS_PER_DAY = 7200;

async function ready(page: Page, timeout = 1_800_000): Promise<void> {
  await page.waitForFunction(() => window.__wb?.ready === true, undefined, { timeout, polling: 1000 });
  await page.waitForTimeout(3000);
}

async function view(page: Page, v: { mode: 'strategic' | 'free'; x: number; z: number; up: number; yaw: number; pitch: number; distance: number }, settle = 3500): Promise<void> {
  await page.evaluate((p) => window.__wb!.setView({ mode: p.mode, target: [p.x, window.__wb!.ground(p.x, p.z) + p.up, p.z], yaw: p.yaw, pitch: p.pitch, distance: p.distance }), v);
  await page.waitForTimeout(settle);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const clock = (page: Page) => page.evaluate(() => document.body.innerText.match(/Год[^\n]*/)?.[0] ?? '');

/** Время мира вперёд на ×8 до нужной доли года (сезон: 0 весна, 0,25 лето, 0,5 осень, 0,75 зима) и полудня. */
async function advanceTo(page: Page, yearFrac: number, daysPerYear = 20): Promise<void> {
  await page.getByTestId('speed-8').click();
  await page.waitForFunction(
    ([yf, dpy, tpd]) => {
      const tick = window.__wb!.getTick();
      const day = Math.floor(tick / tpd);
      const f = ((day % dpy) + (tick % tpd) / tpd) / dpy;
      // Мир начинается с середины весны: доля года считается от начала года мира.
      const yfNow = ((f + 1 - 0) % 1);
      const hour = ((tick % tpd) / tpd) * 24;
      return Math.abs(((yfNow - yf + 1.5) % 1) - 0.5) < 0.02 && hour > 11 && hour < 14;
    },
    [yearFrac, daysPerYear, TICKS_PER_DAY] as const,
    { timeout: 3_000_000, polling: 500 },
  );
  await page.getByTestId('speed-0').click();
  await page.waitForTimeout(2500);
}

test('Wildlands S (40 лет): леса, роща, луг, река, отдельное дерево, облёт; проверки B, E, F, G', async ({ page }) => {
  test.setTimeout(3_600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?renderer=webgpu&autostart=1&seed=42&size=S&debug=1&prepare=40');
  await ready(page);
  const result: Record<string, unknown> = { ...codeVersion(), world: 'Wildlands S, seed 42, подготовка 40 лет' };
  // Лето, полдень: полная листва и цветение.
  await advanceTo(page, 0.35);
  result.clock = await clock(page);
  const spots = await page.evaluate(() => window.__wb!.flora.findSpots());
  result.spots = spots;
  const size = await page.evaluate(() => window.__wb!.worldSize());
  const S = (k: string) => spots[k] ?? [size / 2, size / 2];
  await view(page, { mode: 'strategic', x: S('forest')[0], z: S('forest')[1], up: 0, yaw: 2.4, pitch: 0.34, distance: 520 });
  await shot(page, '01-wildlands-overview');
  await view(page, { mode: 'free', x: S('forest')[0], z: S('forest')[1], up: 2.5, yaw: 0.6, pitch: 0.08, distance: 10 });
  await shot(page, '02-dense-forest');
  await view(page, { mode: 'strategic', x: S('birch')[0], z: S('birch')[1], up: 0, yaw: 1.2, pitch: 0.22, distance: 70 });
  await shot(page, '03-birch-grove');
  await view(page, { mode: 'free', x: S('meadow')[0], z: S('meadow')[1], up: 1.2, yaw: 2.0, pitch: 0.05, distance: 8 });
  await shot(page, '04-flowering-meadow');
  await view(page, { mode: 'strategic', x: S('conifer')[0], z: S('conifer')[1], up: 0, yaw: 0.3, pitch: 0.2, distance: 75 });
  await shot(page, '05-conifer-forest');
  await view(page, { mode: 'strategic', x: S('river')[0], z: S('river')[1], up: 0, yaw: 1.8, pitch: 0.25, distance: 60 });
  await shot(page, '06-river-vegetation');
  // Отдельное дерево: самое высокое лиственное у рощи.
  const tree = await page.evaluate(([x, z]) => window.__wb!.flora.plantsNear(x!, z!, 90).filter((p) => ['birch', 'oak', 'linden'].includes(p.species)).sort((a, b) => b.height - a.height)[0], S('birch'));
  result.closeTree = tree;
  if (tree) {
    await view(page, { mode: 'free', x: tree.x, z: tree.z, up: tree.height * 0.45, yaw: 2.6, pitch: 0.12, distance: tree.height * 1.25 });
    await shot(page, '07-single-tree');
  }
  // Облёт: от дальней камеры к ближней над лесом (F — переход уровней детализации).
  const flight: unknown[] = [];
  const dists = [1400, 900, 520, 300, 170, 110, 70, 40, 22];
  for (let i = 0; i < dists.length; i++) {
    await view(page, { mode: 'strategic', x: S('forest')[0], z: S('forest')[1], up: 0, yaw: 2.1, pitch: Math.min(0.9, 0.18 + dists[i]! / 2500), distance: dists[i]! }, 2500);
    await shot(page, `09-flight-${String(i + 1).padStart(2, '0')}-${dists[i]}m`);
    flight.push({ distance: dists[i], flora: await page.evaluate(() => window.__wb!.flora.stats()) });
  }
  result.flight = flight;

  // B — модели соответствуют данным: в карточке ячейки (симуляция) столько же древесных, сколько растений рендера в ней.
  const cells: unknown[] = [];
  const near = await page.evaluate(([x, z]) => window.__wb!.flora.plantsNear(x!, z!, 40), S('forest'));
  const seen = new Set<string>();
  for (const p of near) {
    const key = `${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}`;
    if (seen.has(key) || seen.size >= 6) continue;
    seen.add(key);
    const cx = Math.floor(p.x / 8) * 8 + 4;
    const cz = Math.floor(p.z / 8) * 8 + 4;
    await page.evaluate(([x, z]) => window.__wb!.pick(x!, z!), [cx, cz]);
    await page.waitForTimeout(1200);
    const simCount = Number(((await page.getByTestId('cell-woody').textContent()) ?? '').match(/\d+/)?.[0] ?? -1);
    const renderCount = await page.evaluate(([x, z]) => window.__wb!.flora.plantsNear(x!, z!, 6).filter((q) => Math.floor(q.x / 8) === Math.floor(x! / 8) && Math.floor(q.z / 8) === Math.floor(z! / 8)).length, [cx, cz]);
    cells.push({ x: cx, z: cz, simCount, renderCount });
    expect(renderCount).toBe(simCount);
  }
  result.checkB = cells;

  // E — ветер растений из модели погоды.
  const wind = await page.evaluate(() => window.__wb!.flora.wind());
  result.checkE = wind;
  if (wind.flora && wind.weather) {
    const len = Math.hypot(wind.weather.x, wind.weather.z) || 1;
    expect(wind.flora.dirX).toBeCloseTo(wind.weather.x / len, 4);
    expect(wind.flora.dirZ).toBeCloseTo(wind.weather.z / len, 4);
    expect(wind.flora.strength).toBeCloseTo(Math.min(1.6, 0.08 + wind.weather.speed / 10), 4);
  }

  // G — наблюдатель не меняет мир: на паузе камера, уровни детализации, качество и выключение рендера растений не меняют хеш.
  const h0 = await page.evaluate(() => window.__wb!.stateHash());
  for (const step of ['camera', 'quality', 'flora-off', 'flora-on']) {
    if (step === 'camera') {
      await view(page, { mode: 'free', x: S('conifer')[0], z: S('conifer')[1], up: 2, yaw: 1, pitch: 0.1, distance: 6 }, 1500);
      await view(page, { mode: 'strategic', x: size / 2, z: size / 2, up: 0, yaw: 0.7, pitch: 0.95, distance: size * 0.95 }, 1500);
    }
    if (step === 'quality') {
      for (const q of ['low', 'high', 'medium'] as const) {
        await page.evaluate((n) => window.__wb!.setQuality(n), q);
        await page.waitForTimeout(1500);
      }
    }
    if (step === 'flora-off') await page.evaluate(() => window.__wb!.flora.setEnabled(false));
    if (step === 'flora-on') await page.evaluate(() => window.__wb!.flora.setEnabled(true));
    await page.waitForTimeout(1000);
    const h = await page.evaluate(() => window.__wb!.stateHash());
    expect(h.hash, step).toBe(h0.hash);
  }
  // Смена рендера: сохранить на паузе, открыть тот же мир в WebGL 2 — хеш тот же.
  await page.getByTestId('save-now').click();
  await page.waitForTimeout(3000);
  await page.goto('/?renderer=webgl2&debug=1&open=last');
  await ready(page, 120_000);
  const h1 = await page.evaluate(() => window.__wb!.stateHash());
  expect(h1.hash).toBe(h0.hash);
  result.checkG = { hash: h0.hash, tick: h0.tick, webgl2: { backend: await page.evaluate(() => window.__wb!.backend), hash: h1.hash } };
  await view(page, { mode: 'strategic', x: S('forest')[0], z: S('forest')[1], up: 0, yaw: 2.4, pitch: 0.34, distance: 520 });
  await shot(page, '01-wildlands-overview-webgl2');
  await view(page, { mode: 'strategic', x: S('birch')[0], z: S('birch')[1], up: 0, yaw: 1.2, pitch: 0.22, distance: 70 });
  await shot(page, '03-birch-grove-webgl2');
  writeFileSync(`${RESULTS}/phase3-stage5-showcase.json`, JSON.stringify(result, null, 1));
  expect(errors, errors.join('\n')).toEqual([]);
});

test('D — сезоны: одна и та же роща весной, летом, осенью и зимой (Wildlands S, 20 лет)', async ({ page }) => {
  test.setTimeout(3_600_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?renderer=webgpu&autostart=1&seed=42&size=S&debug=1');
  await ready(page);
  const spots = await page.evaluate(() => window.__wb!.flora.findSpots());
  const [x, z] = spots.birch ?? spots.forest!;
  const seasons: unknown[] = [];
  for (const [name, yf] of [['spring', 0.1], ['summer', 0.35], ['autumn', 0.62], ['winter', 0.85]] as const) {
    await advanceTo(page, yf);
    await view(page, { mode: 'strategic', x: x!, z: z!, up: 0, yaw: 1.2, pitch: 0.25, distance: 60 });
    await shot(page, `08-season-${name}`);
    const leaf = await page.evaluate(([px, pz]) => {
      const ps = window.__wb!.flora.plantsNear(px!, pz!, 60).filter((p) => p.species === 'birch');
      return ps.length ? ps.reduce((a, p) => a + p.leaf, 0) / ps.length : null;
    }, [x, z]);
    seasons.push({ season: name, clock: await clock(page), birchLeafMean: leaf, flora: await page.evaluate(() => window.__wb!.flora.stats()) });
  }
  writeFileSync(`${RESULTS}/phase3-stage5-seasons.json`, JSON.stringify({ ...codeVersion(), seasons }, null, 1));
});

test('C — Genesis: новые растения становятся видимыми по мере заселения (S, seed 42, ×8)', async ({ page }) => {
  test.setTimeout(3_600_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?renderer=webgpu&autostart=1&seed=42&size=S&debug=1&scenario=genesis');
  await ready(page, 120_000);
  const start = await page.evaluate(() => window.__wb!.flora.stats());
  expect((start as { woodyTotal: number } | null)?.woodyTotal).toBe(0);
  // До первого рассева древесных колонистов (≈ 0,62 года) — затем растения видны в рендере.
  await page.getByTestId('speed-8').click();
  await page.waitForFunction(() => ((window.__wb!.flora.stats() as { woodyTotal: number } | null)?.woodyTotal ?? 0) > 0, undefined, { timeout: 3_000_000, polling: 2000 });
  await page.getByTestId('speed-0').click();
  await page.waitForTimeout(3000);
  const plants = await page.evaluate(() => {
    const s = window.__wb!.worldSize();
    return window.__wb!.flora.plantsNear(s / 2, s / 2, s);
  });
  const p = plants[0]!;
  await view(page, { mode: 'free', x: p.x, z: p.z, up: 0.5, yaw: 1, pitch: 0.15, distance: 4 });
  const shown = await page.evaluate(() => window.__wb!.flora.stats());
  await shot(page, '10-genesis-first-colonists');
  writeFileSync(`${RESULTS}/phase3-stage5-genesis-visible.json`, JSON.stringify({ ...codeVersion(), start, clock: await clock(page), plants: plants.slice(0, 50), shown }, null, 1));
  expect((shown as { lod0: number; lod1: number }).lod0 + (shown as { lod0: number; lod1: number }).lod1).toBeGreaterThan(0);
});
