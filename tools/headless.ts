// Headless-прогон ядра симуляции в Node — без браузера, воркера и рендера.
// Использование: npm run headless -- [--seed 42] [--size S|M] [--ticks 7200] [--agents 2000] [--scenario genesis|wild]
// (wild — мир Wildlands без подготовки: подготовку меряет tools/wildlands-bench.ts)

import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { TICKS_PER_DAY } from '../src/shared/time';
import { codeVersion } from './lib/commit';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

const seed = arg('seed', 42);
const ticks = arg('ticks', TICKS_PER_DAY);
const agents = arg('agents', 2000);

const size = process.argv.includes('--size') && process.argv[process.argv.indexOf('--size') + 1] === 'S' ? 'S' : 'M';
const genStart = performance.now();
const scenario = process.argv.includes('--scenario') && process.argv[process.argv.indexOf('--scenario') + 1] === 'wild' ? 'wild' : 'genesis';
const sim = new Simulation({ config: { seed, size, scenario }, testAgents: agents, prepareYears: 0 }, () => performance.now());
const generationMs = performance.now() - genStart;
const start = performance.now();
for (let i = 0; i < ticks; i++) sim.step();
const elapsed = performance.now() - start;

console.log(
  JSON.stringify(
    {
      tool: 'tools/headless.ts',
      ...codeVersion(),
      seed,
      size,
      generationMs: +generationMs.toFixed(0),
      geoHash: sim.world.geoHash,
      ticks,
      agents: sim.world.agents.count,
      gameDays: +(ticks / TICKS_PER_DAY).toFixed(3),
      totalMs: +elapsed.toFixed(1),
      msPerTick: +(elapsed / ticks).toFixed(4),
      woodyPlants: sim.world.flora.woody.count,
      heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(0),
      rssMb: +(process.memoryUsage().rss / 1048576).toFixed(0),
      stateHash: sim.stateHash(),
      systems: sim.getTimings().map((t) => ({ name: t.name, runs: t.runs, avgMs: +(t.totalMs / Math.max(1, t.runs)).toFixed(4), maxMs: +t.maxMs.toFixed(3) })),
    },
    null,
    2,
  ),
);
