// Нагрузка симуляции флоры: мир M с заданным числом древесных (по умолчанию 300 тыс.), прогон 12 игровых суток,
// включающий дни рассева семян. Без браузера. Такты меряются по одному: среднее, p95, p99, худший, число > 40 мс.
// Использование: npm run flora:load -- [--trees 300000] [--out файл]
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { counterRandom } from '../src/shared/rng';
import { SPECIES } from '../src/sim/flora/species';
import { refreshCover } from '../src/sim/flora/system';
import { WaterKind } from '../src/sim/worldgen/geo';
import { codeVersion } from './lib/commit';

const i = process.argv.indexOf('--trees');
const target = i >= 0 ? Number(process.argv[i + 1]) : 300_000;
const o = process.argv.indexOf('--out');
const outFile = o >= 0 ? process.argv[o + 1]! : 'docs/measurements/phase3-stage3-flora-load-M.json';
// Genesis без изоляции: растения расставляет стенд, колонизация с краёв идёт как в игре.
const sim = new Simulation({ config: { seed: 42, size: 'M', scenario: 'genesis' }, testAgents: 0 }, () => performance.now());
const geo = sim.world.geo;
const f = sim.world.flora;
const w = f.woody;
const woody = Array.from({ length: SPECIES.count }, (_, s) => s).filter((s) => SPECIES.woody[s] === 1);
const land: number[] = [];
for (let c = 0; c < geo.n * geo.n; c++) if (geo.waterKind[c] === WaterKind.None) land.push(c);
let k = 0;
while (w.count < target) {
  const c = land[Math.floor(counterRandom(1, 1, k, 0) * land.length)]!;
  const s = woody[Math.floor(counterRandom(1, 2, k, 0) * woody.length)]!;
  const age = 1 + counterRandom(1, 3, k, 0) * 60;
  const b = Math.min(SPECIES.maxBiomass[s]!, 0.02 + 0.6 * age * age * 0.05);
  w.spawn(s, ((c % geo.n) + counterRandom(1, 4, k, 0)) * 8, (Math.floor(c / geo.n) + counterRandom(1, 5, k, 0)) * 8, c, b, age);
  k++;
}
refreshCover(sim.world, true);
const ticks = 12 * 7200;
const times = new Float64Array(ticks);
const start = performance.now();
for (let t = 0; t < ticks; t++) {
  const t0 = performance.now();
  sim.step();
  times[t] = performance.now() - t0;
}
const total = performance.now() - start;
const sorted = times.slice().sort();
const pct = (p: number) => +sorted[Math.min(ticks - 1, Math.floor(p * ticks))]!.toFixed(3);
let over40 = 0;
for (const t of times) if (t > 40) over40++;
const timing = sim.getTimings().filter((x) => x.runs > 0 && !x.name.startsWith('testAgents')).map((x) => ({ name: x.name, runs: x.runs, avgMs: +(x.totalMs / x.runs).toFixed(2), maxMs: +x.maxMs.toFixed(1) }));
const out = {
  tool: 'tools/flora-load.ts',
  ...codeVersion(),
  treesAtStart: target,
  treesAtEnd: w.count,
  gameDays: 12,
  totalMs: Math.round(total),
  msPerGameDay: Math.round(total / 12),
  tickMs: { mean: +(total / ticks).toFixed(4), p95: pct(0.95), p99: pct(0.99), p999: pct(0.999), max: +sorted[ticks - 1]!.toFixed(2) },
  ticksOver40ms: over40,
  rssMb: Math.round(process.memoryUsage().rss / 1048576),
  systems: timing,
};
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
