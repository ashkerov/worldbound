// Длительные опыты этапа 3 фазы 3 без браузера: ряды в JSON и графики в SVG.
// Использование: npm run flora:experiments -- [--years 80] [--seeds 1,2,3]
// Результаты: docs/measurements/phase3-stage3-experiments.json, docs/charts/phase3-stage3/*.svg

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DRY, WET, runBoundary, runShade, runSuccession, type SuccessionRun } from '../tests/support/experiments';
import { plotSimulation, runDays } from '../tests/support/plot';
import { PLANTS, SPECIES } from '../src/sim/flora/species';
import { woodyHeight } from '../src/sim/flora/system';
import { writeCharts, type ExperimentData } from './flora-charts';
import { codeVersion } from './lib/commit';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const YEARS = Number(arg('years', '80'));
const SEEDS = arg('seeds', '1,2,3').split(',').map(Number);
mkdirSync('docs/measurements', { recursive: true });

const now = () => performance.now();
const result: Record<string, unknown> = { tool: 'tools/flora-experiments.ts', ...codeVersion(), years: YEARS, seeds: SEEDS };

// ── A и B: зарастание влажного и сухого участков на нескольких seed.
const runs: Record<'wet' | 'dry', SuccessionRun[]> = { wet: [], dry: [] };
for (const [key, plot] of [
  ['wet', WET],
  ['dry', DRY],
] as const) {
  for (const seed of SEEDS) {
    const r = runSuccession(plot, seed, YEARS, {}, 4, now);
    runs[key].push(r);
    console.log(`${key} seed ${seed}: ${(r.ms / 1000).toFixed(1)} с; год ${YEARS}: травы ${r.samples.at(-1)!.herbs} г/м², кустарников ${r.samples.at(-1)!.shrubs}, деревьев ${r.samples.at(-1)!.trees}`);
  }
}
result.succession = Object.fromEntries(
  (['wet', 'dry'] as const).map((k) => [
    k,
    runs[k].map((r) => ({ seed: r.seed, ms: Math.round(r.ms), stateHash: r.stateHash, field: r.samples, near: r.near })),
  ]),
);

// ── C: свет. Тенденция за 40 лет.
const shade: { year: number; open: Record<string, number>; shaded: Record<string, number>; shadedTreeCover: number }[] = [];
for (const y of [2, 5, 10, 15, 20, 30, 40]) {
  const r = runShade(1, y);
  shade.push({ year: y, open: r.open.herbBySpecies, shaded: r.shaded.herbBySpecies, shadedTreeCover: r.shaded.treeCover });
}
result.shade = shade;
// ── D: граница пригодности.
const boundary = runBoundary(1, 20);
result.boundary = { west: boundary.west, east: boundary.east, eastNearBoundary: boundary.eastNearBoundary };

// ── Рост одиночных древесных на открытом месте: зрелость (каталог) против времени до 50 % и 75 % предельной высоты
// (измерено). Потомство и самосев каждый год убираются — растения растут без соседей.
const woody = PLANTS.map((p, i) => [p, i] as const).filter(([p]) => p.form !== 'herb');
const n = 96;
const sim = plotSimulation({ precip: 700, soil: 'loam', fertility: 0.8, n }, { scenario: 'genesis', isolated: true, seed: 11 });
const w = sim.world.flora.woody;
const R = 8;
const ids = woody.map(([, s], k) =>
  Array.from({ length: R }, (_, r) => {
    const cx = k * 9 + 4;
    const cz = r * 11 + 5;
    sim.world.flora.woodyCount[cz * n + cx] = 1;
    return w.idOf(w.spawn(s, cx * 8 + 4, cz * 8 + 4, cz * n + cx, 0.002, 0));
  }),
);
const reached: Record<string, { h50?: number; h75?: number; at20?: number; at40?: number; at80?: number; survivors?: number }> = {};
const tracked = new Set(ids.flat());
const heights: Record<string, [number, number][]> = {};
for (let y = 1; y <= 120; y++) {
  runDays(sim, 20);
  for (let i = 0; i < w.highWater; i++) if (w.alive[i] === 1 && !tracked.has(w.idOf(i))) w.remove(i);
  woody.forEach(([p, s], k) => {
    const alive = ids[k]!.filter((id) => w.alive[id & 0xfffff] === 1 && w.idOf(id & 0xfffff) === id).map((id) => id & 0xfffff);
    const h = alive.length ? alive.map((i) => woodyHeight(s, w.biomass[i]!)).reduce((a, b) => a + b, 0) / alive.length : 0;
    (heights[p.id] ??= []).push([y, h]);
    const e = (reached[p.id] ??= {});
    if (e.h50 === undefined && h >= 0.5 * SPECIES.maxHeight[s]!) e.h50 = y;
    if (e.h75 === undefined && h >= 0.75 * SPECIES.maxHeight[s]!) e.h75 = y;
    if (y === 20) e.at20 = +h.toFixed(1);
    if (y === 40) e.at40 = +h.toFixed(1);
    if (y === 80) e.at80 = +h.toFixed(1);
    e.survivors = alive.length;
  });
}
result.growth = woody.map(([p]) => ({ heights: heights[p.id], id: p.id, name: p.name, maturityYears: p.maturityYears, lifespanYears: p.lifespanYears, maxHeight: p.maxHeight, yearsTo50pctHeight: reached[p.id]!.h50 ?? null, yearsTo75pctHeight: reached[p.id]!.h75 ?? null, heightAt20: reached[p.id]!.at20, heightAt40: reached[p.id]!.at40, heightAt80: reached[p.id]!.at80, survivorsOf8At120: reached[p.id]!.survivors }));
writeFileSync('docs/measurements/phase3-stage3-experiments.json', JSON.stringify(result, null, 1));
writeCharts(result as unknown as ExperimentData);
console.log('Графики — docs/charts/phase3-stage3/');
