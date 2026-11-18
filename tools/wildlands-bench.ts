// Замер стоимости и результата подготовки миров (этап 4 фазы 3): Wildlands — предварительный прогон той же
// симуляции, Genesis — пустой мир. Для каждого мира: время генерации, время подготовки с отметками по годам,
// численность и стадии древесных, биомасса, биомы, память, затем скорость дальнейшей работы мира
// (по тактам: среднее, p95, p99, худший; по системам).
// Использование: npx tsx tools/wildlands-bench.ts --size S --seeds 1,2 --climates temperate --years 20 [--marks 5,10,20]
//                [--genesis] [--after 2] [--out docs/measurements/x.json]

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { BIOMES } from '../src/sim/flora/biomes';
import { biomeCounts } from '../src/sim/flora/biomeState';
import { PLANTS } from '../src/sim/flora/species';
import { Ledger, herbBiomass, nutrientBudget, nutrientStock } from '../src/sim/flora/state';
import { woodyHeight } from '../src/sim/flora/system';
import { STAGE_NAMES } from '../src/sim/flora/woodyStore';
import { SEASONS_PER_YEAR, TICKS_PER_DAY } from '../src/shared/time';
import { WaterKind } from '../src/sim/worldgen/geo';
import type { ClimateName, ScenarioName, WorldSizeName } from '../src/shared/worldConfig';
import { codeVersion } from './lib/commit';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}

const size = opt('size', 'S') as WorldSizeName;
const seeds = opt('seeds', '1').split(',').map(Number);
const climates = opt('climates', 'temperate').split(',') as ClimateName[];
const years = Number(opt('years', '20'));
const marks = opt('marks', '5,10,20').split(',').map(Number).filter((y) => y <= years);
const afterDays = Number(opt('after', '2'));
const scenario: ScenarioName = process.argv.includes('--genesis') ? 'genesis' : 'wild';
const out = opt('out', '');

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function snapshot(sim: Simulation) {
  const w = sim.world;
  const f = w.flora;
  const geo = w.geo;
  const count = geo.n * geo.n;
  const area = geo.cellSize * geo.cellSize;
  let land = 0;
  let herbKg = 0;
  let herbCells = 0;
  for (let c = 0; c < count; c++) {
    if (geo.waterKind[c] !== WaterKind.None) continue;
    land++;
    const b = herbBiomass(f, c);
    herbKg += (b * area) / 1000;
    if (b > 5) herbCells++;
  }
  const wd = f.woody;
  const stages = [0, 0, 0, 0];
  const species: Record<string, number> = {};
  let woodyKg = 0;
  let tallest = 0;
  let trees = 0;
  let shrubs = 0;
  for (let i = 0; i < wd.highWater; i++) {
    if (wd.alive[i] !== 1) continue;
    const s = wd.species[i]!;
    stages[wd.stage[i]!]!++;
    species[PLANTS[s]!.id] = (species[PLANTS[s]!.id] ?? 0) + 1;
    woodyKg += wd.biomass[i]!;
    tallest = Math.max(tallest, woodyHeight(s, wd.biomass[i]!));
    if (PLANTS[s]!.form === 'tree') trees++;
    else shrubs++;
  }
  let treeCover = 0;
  let shrubCover = 0;
  for (let c = 0; c < count; c++) {
    if (geo.waterKind[c] !== WaterKind.None) continue;
    treeCover += f.biome.tree[c]!;
    shrubCover += f.biome.shrub[c]!;
  }
  const bc = biomeCounts(w);
  const biomes: Record<string, number> = {};
  bc.forEach((k, i) => {
    if (k > 0 && geo.waterKind.length) biomes[BIOMES[i]!.id] = +(k / count).toFixed(4);
  });
  const landBiomes = bc.filter((k, i) => k > 0 && !['sea', 'lake', 'river'].includes(BIOMES[i]!.id)).length;
  const stock = nutrientStock(f, geo);
  const balanceError = Math.abs(stock - f.ledger[Ledger.initialStock]! - nutrientBudget(f)) / f.ledger[Ledger.initialStock]!;
  const mem = process.memoryUsage();
  return {
    landCells: land,
    herbCoveredShare: +(herbCells / land).toFixed(3),
    herbBiomassT: +(herbKg / 1000).toFixed(1),
    woodyBiomassT: +(woodyKg / 1000).toFixed(1),
    woody: wd.count,
    woodyPerLandCell: +(wd.count / land).toFixed(2),
    storeFill: +(wd.count / wd.capacity).toFixed(3),
    trees,
    shrubs,
    stages: Object.fromEntries(STAGE_NAMES.map((n, k) => [n, stages[k]])),
    species,
    tallestM: +tallest.toFixed(1),
    treeCoverLand: +(treeCover / land).toFixed(3),
    shrubCoverLand: +(shrubCover / land).toFixed(3),
    landBiomeKinds: landBiomes,
    biomes,
    colonizedSpecies: PLANTS.filter((_, s) => f.colonistFirst[s]! >= 0).length,
    externalN: +f.ledger[Ledger.external]!.toFixed(0),
    balanceError: +balanceError.toExponential(2),
    heapMb: Math.round(mem.heapUsed / 1048576),
    rssMb: Math.round(mem.rss / 1048576),
  };
}

const results: unknown[] = [];
for (const climate of climates) {
  for (const seed of seeds) {
    const genStart = performance.now();
    const sim = new Simulation({ config: { seed, size, climate, scenario }, testAgents: 0, prepareYears: years }, () => performance.now());
    const generationMs = performance.now() - genStart;
    const daysPerYear = sim.world.config.daysPerSeason * SEASONS_PER_YEAR;
    const markResults: unknown[] = [];
    const prepStart = performance.now();
    let dayWorst = 0;
    for (const mark of marks) {
      const target = (sim.preparation?.startTick ?? sim.world.tick) + mark * daysPerYear * TICKS_PER_DAY;
      while (sim.world.tick < target && (scenario === 'genesis' || sim.preparation)) {
        const t0 = performance.now();
        if (scenario === 'wild') sim.advancePreparation(TICKS_PER_DAY);
        else for (let k = 0; k < TICKS_PER_DAY; k++) sim.step();
        dayWorst = Math.max(dayWorst, performance.now() - t0);
      }
      const elapsed = performance.now() - prepStart;
      markResults.push({ years: mark, prepMs: Math.round(elapsed), msPerGameDay: +(elapsed / (mark * daysPerYear)).toFixed(1), ...snapshot(sim) });
      console.log(`${size} ${climate} seed ${seed}: ${mark} лет — ${(elapsed / 1000).toFixed(1)} с`, JSON.stringify((markResults.at(-1) as { biomes: unknown }).biomes));
    }
    // Скорость дальнейшей работы готового мира: каждый такт отдельно.
    const ticks = afterDays * TICKS_PER_DAY;
    const times = new Float64Array(ticks);
    const runStart = performance.now();
    for (let k = 0; k < ticks; k++) {
      const t0 = performance.now();
      sim.step();
      times[k] = performance.now() - t0;
    }
    const runMs = performance.now() - runStart;
    const sorted = times.slice().sort();
    let slow = 0;
    for (const t of times) if (t > 40) slow++;
    results.push({
      size,
      climate,
      seed,
      scenario,
      generationMs: Math.round(generationMs),
      worstPrepDayMs: Math.round(dayWorst),
      marks: markResults,
      after: {
        gameDays: afterDays,
        msPerGameDay: +(runMs / afterDays).toFixed(1),
        tickMs: { mean: +(runMs / ticks).toFixed(4), p95: +percentile(sorted, 0.95).toFixed(3), p99: +percentile(sorted, 0.99).toFixed(3), max: +sorted[sorted.length - 1]!.toFixed(2) },
        ticksOver40ms: slow,
        systems: sim.getTimings().map((t) => ({ name: t.name, avgMs: +(t.totalMs / Math.max(1, t.runs)).toFixed(3), maxMs: +t.maxMs.toFixed(2) })),
      },
      stateHash: sim.stateHash(),
    });
  }
}

const report = { tool: 'tools/wildlands-bench.ts', ...codeVersion(), node: process.version, args: process.argv.slice(2), results };
if (out) writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(results.map((r) => (r as { after: unknown }).after)));
