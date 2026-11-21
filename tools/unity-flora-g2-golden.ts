// Эталон G2 переноса флоры (Stage 2.1, docs/UNITY_MIGRATION_STAGE2_PLAN.md, раздел 6.1): начальное состояние мира
// до первого такта — с настоящего конструктора TS `Simulation` (populateGenesis / populateWildlands → refreshCover(true)
// → initBiomes → метаданные подготовки Wildlands). Для каждого случая: полный stateHash на такте 0, FNV всех массивов
// FloraState, BiomeTrack, столбцов WoodyStore, банка семян и среды, ведомость, nutrientStock/nutrientBudget (биты),
// флаг семян региона, метаданные подготовки, сводки для независимых проверок C#.
// Дополнительно: стенд plantLoadStand (настоящие растения симуляции) — путь полога и покрова с древесными.
// Время TS: полное создание из готового рельефа и отдельные шаги (те же функции, тот же порядок).
// Использование: npx tsx tools/unity-flora-g2-golden.ts [--out unity/WorldboundProto/Golden/flora-g2.json]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { generateWorld } from '../src/sim/worldgen/generate';
import { DEFAULT_CONFIG, type ScenarioName, type WorldSizeName } from '../src/shared/worldConfig';
import { WaterKind } from '../src/sim/worldgen/geo';
import { nutrientBudget, nutrientStock, SLOTS, type FloraState } from '../src/sim/flora/state';
import { populateGenesis, populateWildlands } from '../src/sim/flora/populate';
import { refreshCover } from '../src/sim/flora/system';
import { biomeCounts, initBiomes } from '../src/sim/flora/biomeState';
import { plantLoadStand } from '../src/sim/flora/loadStand';
import { SPECIES } from '../src/sim/flora/species';
import type { World } from '../src/sim/core/world';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/flora-g2.json');

const bits = (x: number): string => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString('hex');
};
function fnv(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}
const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, mean: s.reduce((a, v) => a + v, 0) / s.length, p95: p(0.95), p99: p(0.99), min: s[0], max: s[s.length - 1] };
};

function floraArrays(f: FloraState): Record<string, string> {
  const b = f.biome;
  const w = f.woody;
  return {
    slotSpecies: fnv(f.slotSpecies), slotBiomass: fnv(f.slotBiomass), litterFast: fnv(f.litterFast), litterFastN: fnv(f.litterFastN), litterFastQ: fnv(f.litterFastQ),
    litterWood: fnv(f.litterWood), litterWoodN: fnv(f.litterWoodN), nutrient: fnv(f.nutrient), accT: fnv(f.accT), accW: fnv(f.accW), accRunoff: fnv(f.accRunoff),
    accMinT: fnv(f.accMinT), accHours: fnv(f.accHours), dayT: fnv(f.dayT), dayW: fnv(f.dayW), capillary: fnv(f.capillary), seedBank: fnv(f.seedBank),
    woodyCount: fnv(f.woodyCount), canopy: fnv(f.canopy), treeCover: fnv(f.treeCover), shrubCover: fnv(f.shrubCover), coniferCover: fnv(f.coniferCover),
    tallCover: fnv(f.tallCover), colonistMass: fnv(f.colonistMass), colonistFirst: fnv(f.colonistFirst), ledger: fnv(f.ledger),
    'biome.herb': fnv(b.herb), 'biome.steppe': fnv(b.steppe), 'biome.wet': fnv(b.wet), 'biome.pioneer': fnv(b.pioneer), 'biome.moisture': fnv(b.moisture),
    'biome.tree': fnv(b.tree), 'biome.shrub': fnv(b.shrub), 'biome.conifer': fnv(b.conifer), 'biome.tall': fnv(b.tall), 'biome.current': fnv(b.current),
    'biome.candidate': fnv(b.candidate), 'biome.days': fnv(b.days),
    'woody.x': fnv(w.x), 'woody.z': fnv(w.z), 'woody.species': fnv(w.species), 'woody.age': fnv(w.age), 'woody.biomass': fnv(w.biomass), 'woody.leaf': fnv(w.leaf),
    'woody.health': fnv(w.health), 'woody.stage': fnv(w.stage), 'woody.stressW': fnv(w.stressW), 'woody.stressL': fnv(w.stressL), 'woody.cell': fnv(w.cell),
    'woody.alive': fnv(w.alive), 'woody.generation': fnv(w.generation), 'woody.free': fnv(w.freeSlots()),
  };
}

function snapshot(sim: Simulation) {
  const w = sim.world;
  const f = w.flora;
  const geo = w.geo;
  const count = geo.n * geo.n;
  let landCells = 0;
  let seedLand = 0;
  let seedWater = 0;
  let seedSum = 0;
  let greenLandNonZero = 0;
  let greenLandMax = 0;
  let herbSlots = 0;
  for (let c = 0; c < count; c++) {
    const land = geo.waterKind[c] === WaterKind.None;
    if (land) {
      landCells++;
      if (w.env.greenness[c]! !== 0) greenLandNonZero++;
      if (w.env.greenness[c]! > greenLandMax) greenLandMax = w.env.greenness[c]!;
    }
    let any = false;
    for (let h = 0; h < SPECIES.herbs.length; h++) {
      const v = f.seedBank[h * count + c]!;
      if (v > 0) any = true;
      seedSum += v;
    }
    if (any) {
      if (land) seedLand++;
      else seedWater++;
    }
  }
  for (let k = 0; k < count * SLOTS; k++) if (f.slotSpecies[k] !== 255) herbSlots++;
  const p = sim.preparation;
  return {
    tick: w.tick,
    stateHash: sim.stateHash(),
    arrays: floraArrays(f),
    env: { greenness: fnv(w.env.greenness), moisture: fnv(w.env.moisture), snow: fnv(w.env.snow) },
    ledger: Array.from(f.ledger, bits),
    stock: bits(nutrientStock(f, geo)),
    budget: bits(nutrientBudget(f)),
    regionalSeedRain: f.regionalSeedRain,
    preparedYears: bits(f.preparedYears),
    lastSliceHour: f.lastSliceHour,
    preparation: p ? { startTick: p.startTick, targetTick: p.targetTick, years: bits(p.years) } : null,
    preparationFraction: bits(sim.preparationFraction()),
    summary: {
      landCells, seedBankLandCells: seedLand, seedBankWaterCells: seedWater, seedBankSum: bits(seedSum), greennessLandNonZero: greenLandNonZero,
      greennessLandMax: bits(greenLandMax), herbSlotsUsed: herbSlots, woodyCount: f.woody.count, woodyHighWater: f.woody.highWater, biomeCounts: biomeCounts(w),
    },
  };
}

const CASES: { scenario: ScenarioName; seed: number; size: WorldSizeName }[] = [
  { scenario: 'genesis', seed: 42, size: 'S' },
  { scenario: 'genesis', seed: 7, size: 'S' },
  { scenario: 'genesis', seed: 1234, size: 'S' },
  { scenario: 'genesis', seed: 42, size: 'M' },
  { scenario: 'wild', seed: 42, size: 'S' },
  { scenario: 'wild', seed: 7, size: 'S' },
  { scenario: 'wild', seed: 1234, size: 'S' },
  { scenario: 'wild', seed: 42, size: 'M' },
];

const out: unknown[] = [];
for (const c of CASES) {
  const config = { ...DEFAULT_CONFIG, seed: c.seed, size: c.size, scenario: c.scenario };
  const g0 = performance.now();
  const gen = generateWorld(config);
  const genMs = performance.now() - g0;
  const sim = new Simulation({ config, testAgents: 0 }, undefined, gen);
  const snap = snapshot(sim);
  // Детерминизм в TS: второе создание из тех же входов.
  const again = new Simulation({ config, testAgents: 0 }, undefined, gen).stateHash();
  // Время: полное создание из готового рельефа и отдельные шаги (без заселения → те же функции в том же порядке).
  const reps = c.size === 'S' ? 12 : 4;
  const full: number[] = [];
  const pop: number[] = [];
  const cover: number[] = [];
  const biomes: number[] = [];
  let stepsHash = '';
  for (let r = 0; r < reps; r++) {
    let t = performance.now();
    new Simulation({ config, testAgents: 0 }, undefined, gen);
    full.push(performance.now() - t);
    const bare = new Simulation({ config, testAgents: 0, populate: false }, undefined, gen);
    const w = bare.world as World;
    t = performance.now();
    if (c.scenario === 'genesis') populateGenesis(w);
    else populateWildlands(w);
    pop.push(performance.now() - t);
    t = performance.now();
    refreshCover(w, true);
    cover.push(performance.now() - t);
    t = performance.now();
    initBiomes(w);
    biomes.push(performance.now() - t);
    stepsHash = bare.stateHash();
  }
  out.push({
    ...c,
    climate: config.climate,
    daysPerSeason: config.daysPerSeason,
    isolated: config.isolated,
    geoHash: gen.hash,
    ...snap,
    deterministicRepeat: again === snap.stateHash,
    // Без подготовки (populate: false + те же шаги вручную) хеш совпадает с полным созданием: подготовка в хеш не входит.
    stepsStateHash: stepsHash,
    tsTiming: { worldgenMs: genMs, fullInitMs: stat(full), populateMs: stat(pop), refreshCoverMs: stat(cover), initBiomesMs: stat(biomes) },
  });
  console.log(`${c.scenario} ${c.size}/${c.seed}: ${snap.stateHash} (повтор ${again === snap.stateHash ? 'тот же' : 'ДРУГОЙ'}); создание ${stat(full).mean.toFixed(1)} мс`);
}

// Стенд: Genesis S/42 + 20 000 древесных (plantLoadStand: полог, покров и биомы с настоящими растениями).
const standConfig = { ...DEFAULT_CONFIG, seed: 42, size: 'S' as const, scenario: 'genesis' as const };
const standSim = new Simulation({ config: standConfig, testAgents: 0 });
const t0 = performance.now();
const planted = plantLoadStand(standSim.world, 20000);
const standMs = performance.now() - t0;
const stand = { scenario: 'genesis', seed: 42, size: 'S', target: 20000, planted, ...snapshot(standSim), tsMs: standMs };
console.log(`стенд S/42: ${planted} древесных, ${stand.stateHash}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ tool: 'unity-flora-g2-golden', node: process.version, reference: '7b2fbabbc1', cases: out, stand }));
console.log(`→ ${OUT}`);
