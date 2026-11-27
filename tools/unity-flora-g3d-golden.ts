// Эталон G3 D/E/F переноса флоры (Stage 2.5): колонизация, Genesis, Wildlands и подготовка — с настоящего TS
// `Simulation` (снимок 7b2fbabbc1). Сводки и выборки — те же, что в G3 C (tools/unity-flora-g3c-golden.ts), плюс
// колонисты (первое появление и масса по видам), водный баланс, состояние подготовки, хранилище древесных.
//  • D — Genesis без изоляции: тесты flora-worlds A (заселение извне, seed 1–3), D (непригодная территория, seed 1–3),
//    F (детерминизм колонизации: seed 1 и 101), «болото у реки» (seed 6); исходные тесты flora-dynamics о берёзе и сосне
//    (открытый Genesis);
//  • E — Wildlands S/42: 20 лет подготовки и 5 лет дальнейшего развития, хеш после каждой порции первых суток и каждые сутки;
//  • F — изолированный Wildlands S/42: 20 лет подготовки и 3 года после;
//  • Wildlands S/7 (холодный климат), S/1234 (тёплый), M/42 — 20 лет подготовки и год после;
//  • тесты flora-worlds H (Wildlands на участке, seed 1–3) и «Изолированный Wildlands» (32 × 32, seed 1–2).
// Использование: npx tsx tools/unity-flora-g3d-golden.ts [--quick] [--only имя,имя] [--out unity/WorldboundProto/Golden/flora-g3d.json]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { DEFAULT_CONFIG, type WorldConfig } from '../src/shared/worldConfig';
import { TICKS_PER_DAY } from '../src/shared/time';
import { BIOMES } from '../src/sim/flora/biomes';
import { NO_SPECIES, PLANTS, SPECIES, speciesIndex } from '../src/sim/flora/species';
import { Ledger, SLOTS, nutrientBudget, nutrientStock } from '../src/sim/flora/state';
import { biomeCounts } from '../src/sim/flora/biomeState';
import { woodyHeight } from '../src/sim/flora/system';
import { plotSimulation, type PlotOptions } from '../tests/support/plot';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/flora-g3d.json');
const QUICK = process.argv.includes('--quick');
const ONLY = process.argv.includes('--only') ? new Set(opt('only', '').split(',')) : null;
const YEAR = 20;
const YEAR_TICKS = YEAR * TICKS_PER_DAY;

const bits = (x: number): string => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString('hex');
};
function fnv(a: ArrayBufferView, length?: number): string {
  const per = (a as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
  const b = new Uint8Array(a.buffer, a.byteOffset, length === undefined ? a.byteLength : length * per);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}
const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, mean: s.reduce((a, v) => a + v, 0) / Math.max(1, s.length), p95: p(0.95), p99: p(0.99), max: s[s.length - 1] };
};

// ───────── Настройка (C# повторяет её дословно) ─────────

interface Cfg {
  scenario: 'genesis' | 'wild';
  isolated: boolean;
  seed: number;
  climate?: 'cold' | 'temperate' | 'warm';
}
type Setup =
  | { kind: 'plot'; plot: PlotOptions; config: Cfg; prepareYears?: number; plants?: [string, number, number, number, number, number][] }
  | { kind: 'world'; size: 'S' | 'M'; config: Cfg; prepareYears?: number };

function create(s: Setup): Simulation {
  if (s.kind === 'plot') {
    const sim = plotSimulation(s.plot, { ...s.config }, s.prepareYears);
    // Тела тестов flora-dynamics: растения ставятся spawn без счётчика ячейки и пересчёта полога.
    for (const [id, x, z, c, b, age] of s.plants ?? []) sim.world.flora.woody.spawn(speciesIndex(id), x, z, c, b, age);
    return sim;
  }
  const config: WorldConfig = { ...DEFAULT_CONFIG, size: s.size, ...s.config };
  return new Simulation({ config, testAgents: 0, prepareYears: s.prepareYears });
}

// ───────── Сводки ─────────

function compact(sim: Simulation, day: number) {
  const f = sim.world.flora;
  const w = f.woody;
  const stock = nutrientStock(f, sim.world.geo);
  const initial = f.ledger[Ledger.initialStock]!;
  return {
    day,
    tick: sim.world.tick,
    stateHash: sim.stateHash(),
    ledger: Array.from(f.ledger, bits),
    balanceError: bits(Math.abs(stock - initial - nutrientBudget(f)) / initial),
    store: [w.count, w.highWater, w.freeSlots().length],
    preparing: sim.preparation !== null,
    water: Array.from(sim.world.env.waterTotals, bits),
  };
}

function full(sim: Simulation) {
  const f = sim.world.flora;
  const geo = sim.world.geo;
  const w = f.woody;
  const n = geo.n;
  const count = n * n;
  const H = SPECIES.herbs.length;
  const herbBio = new Array<number>(H).fill(0);
  const herbSlots = new Array<number>(H).fill(0);
  const bank = new Array<number>(H).fill(0);
  let occupied = 0;
  let green = 0;
  let litterFast = 0;
  let litterWood = 0;
  let nutrient = 0;
  let negatives = 0;
  const cover = [0, 0, 0, 0];
  let woodyCountSum = 0;
  let woodyCountMax = 0;
  for (let c = 0; c < count; c++) {
    let hb = 0;
    for (let k = 0; k < SLOTS; k++) {
      const s = f.slotSpecies[c * SLOTS + k]!;
      if (s === NO_SPECIES) continue;
      const b = f.slotBiomass[c * SLOTS + k]!;
      const h = SPECIES.herbSlot[s]!;
      herbBio[h] = herbBio[h]! + b;
      herbSlots[h] = herbSlots[h]! + 1;
      hb += b;
    }
    if (hb > 1) occupied++;
    green += sim.world.env.greenness[c]!;
    litterFast += f.litterFast[c]!;
    litterWood += f.litterWood[c]!;
    nutrient += f.nutrient[c]!;
    if (f.nutrient[c]! < 0 || f.litterFast[c]! < 0 || f.litterWood[c]! < 0) negatives++;
    cover[0] = cover[0]! + f.treeCover[c]!;
    cover[1] = cover[1]! + f.shrubCover[c]!;
    cover[2] = cover[2]! + f.coniferCover[c]!;
    cover[3] = cover[3]! + f.tallCover[c]!;
    woodyCountSum += f.woodyCount[c]!;
    if (f.woodyCount[c]! > woodyCountMax) woodyCountMax = f.woodyCount[c]!;
  }
  for (let h = 0; h < H; h++) for (let c = 0; c < count; c++) bank[h] = bank[h]! + f.seedBank[h * count + c]!;
  const S = SPECIES.count;
  const bySpecies = new Array<number>(S).fill(0);
  const bySpeciesBiomass = new Array<number>(S).fill(0);
  const stages = [0, 0, 0, 0];
  let maxAge = 0;
  let maxBiomass = 0;
  for (let i = 0; i < w.highWater; i++) {
    if (w.alive[i] !== 1) continue;
    const s = w.species[i]!;
    bySpecies[s] = bySpecies[s]! + 1;
    bySpeciesBiomass[s] = bySpeciesBiomass[s]! + w.biomass[i]!;
    stages[w.stage[i]!] = stages[w.stage[i]!]! + 1;
    if (w.age[i]! > maxAge) maxAge = w.age[i]!;
    if (w.biomass[i]! > maxBiomass) maxBiomass = w.biomass[i]!;
  }
  const hw = w.highWater;
  return {
    biomeCounts: biomeCounts(sim.world),
    herbs: { biomass: herbBio.map(bits), slots: herbSlots, bank: bank.map(bits), occupied, green: bits(green) },
    soil: { litterFast: bits(litterFast), litterWood: bits(litterWood), nutrient: bits(nutrient), negatives },
    woody: { bySpecies, bySpeciesBiomass: bySpeciesBiomass.map(bits), stages, cover: cover.map(bits), woodyCountSum, woodyCountMax, free: fnv(w.freeSlots()) },
    extra: { maxAge: bits(maxAge), maxBiomass: bits(maxBiomass), colonistFirst: Array.from(f.colonistFirst), colonistMass: Array.from(f.colonistMass, bits), preparedYears: f.preparedYears, regionalSeedRain: f.regionalSeedRain },
    arrays: {
      slotSpecies: fnv(f.slotSpecies), slotBiomass: fnv(f.slotBiomass), seedBank: fnv(f.seedBank), nutrient: fnv(f.nutrient), litterFast: fnv(f.litterFast),
      litterWood: fnv(f.litterWood), litterWoodN: fnv(f.litterWoodN), canopy: fnv(f.canopy), treeCover: fnv(f.treeCover), shrubCover: fnv(f.shrubCover),
      coniferCover: fnv(f.coniferCover), tallCover: fnv(f.tallCover), woodyCount: fnv(f.woodyCount), greenness: fnv(sim.world.env.greenness), 'biome.current': fnv(f.biome.current),
      'woody.x': fnv(w.x, hw), 'woody.z': fnv(w.z, hw), 'woody.species': fnv(w.species, hw), 'woody.age': fnv(w.age, hw), 'woody.biomass': fnv(w.biomass, hw),
      'woody.leaf': fnv(w.leaf, hw), 'woody.health': fnv(w.health, hw), 'woody.stage': fnv(w.stage, hw), 'woody.stressW': fnv(w.stressW, hw), 'woody.stressL': fnv(w.stressL, hw),
      'woody.cell': fnv(w.cell, hw), 'woody.alive': fnv(w.alive, hw), 'woody.generation': fnv(w.generation, hw),
    },
  };
}

/** Выборка зоны без округления (как zoneRaw G3 C), столбцы [from, to) и строки [z0, z1). */
function zoneRaw(sim: Simulation, from: number, to: number, z0 = 0, z1 = sim.world.geo.n) {
  const f = sim.world.flora;
  const geo = sim.world.geo;
  const n = geo.n;
  let cells = 0;
  let herbs = 0;
  let occupied = 0;
  let treeCover = 0;
  let shrubCover = 0;
  let bank = 0;
  let nutrient = 0;
  const herbBy = new Array<number>(SPECIES.herbs.length).fill(0);
  const biomes = new Array<number>(BIOMES.length).fill(0);
  for (let z = z0; z < z1; z++) {
    for (let x = from; x < to; x++) {
      const c = z * n + x;
      cells++;
      let hb = 0;
      for (let k = 0; k < SLOTS; k++) {
        const s = f.slotSpecies[c * SLOTS + k]!;
        if (s === NO_SPECIES) continue;
        const b = f.slotBiomass[c * SLOTS + k]!;
        hb += b;
        const h = SPECIES.herbSlot[s]!;
        herbBy[h] = herbBy[h]! + b;
      }
      herbs += hb;
      if (hb > 1) occupied++;
      treeCover += f.treeCover[c]!;
      nutrient += f.nutrient[c]!;
      shrubCover += f.shrubCover[c]!;
      for (let h = 0; h < SPECIES.herbs.length; h++) bank += f.seedBank[h * n * n + c]!;
      biomes[f.biome.current[c]!] = biomes[f.biome.current[c]!]! + 1;
    }
  }
  const w = f.woody;
  let shrubs = 0;
  let trees = 0;
  const treeStages = [0, 0, 0, 0];
  const woodyBy = new Array<number>(SPECIES.count).fill(0);
  const heights: number[] = [];
  for (let i = 0; i < w.highWater; i++) {
    if (w.alive[i] !== 1 || w.x[i]! < from * geo.cellSize || w.x[i]! >= to * geo.cellSize || w.z[i]! < z0 * geo.cellSize || w.z[i]! >= z1 * geo.cellSize) continue;
    const s = w.species[i]!;
    woodyBy[s] = woodyBy[s]! + 1;
    if (SPECIES.tree[s] === 1) {
      trees++;
      treeStages[w.stage[i]!] = treeStages[w.stage[i]!]! + 1;
      heights.push(woodyHeight(s, w.biomass[i]!));
    } else shrubs++;
  }
  heights.sort((a, b) => b - a);
  const top = heights.slice(0, 5);
  const initial = f.ledger[Ledger.initialStock]!;
  return {
    from,
    to,
    z0,
    z1,
    herbs: bits(herbs / cells),
    herbBySpecies: herbBy.map((v) => bits(v / cells)),
    herbOccupancy: bits(occupied / cells),
    shrubs,
    trees,
    treeStages,
    woodyBySpecies: woodyBy,
    treeCover: bits(treeCover / cells),
    shrubCover: bits(shrubCover / cells),
    topHeight: bits(top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0),
    biomes,
    seedBank: bits(bank / cells),
    nutrient: bits(nutrient / cells),
    balanceError: bits(Math.abs(nutrientStock(f, geo) - initial - nutrientBudget(f)) / initial),
  };
}

function plantProbe(sim: Simulation, i: number) {
  const w = sim.world.flora.woody;
  return { i, alive: w.alive[i], generation: w.generation[i], species: w.species[i], leaf: bits(w.leaf[i]!), biomass: bits(w.biomass[i]!), health: bits(w.health[i]!), stage: w.stage[i], age: bits(w.age[i]!) };
}

class Demography {
  alive: Uint8Array;
  gen: Uint8Array;
  species: Uint8Array;
  births = new Array<number>(SPECIES.count).fill(0);
  deaths = new Array<number>(SPECIES.count).fill(0);
  constructor(sim: Simulation) {
    const w = sim.world.flora.woody;
    this.alive = w.alive.slice();
    this.gen = w.generation.slice();
    this.species = w.species.slice();
  }
  update(sim: Simulation): void {
    const w = sim.world.flora.woody;
    for (let i = 0; i < w.highWater; i++) {
      const was = this.alive[i] === 1;
      const is = w.alive[i] === 1;
      const same = this.gen[i] === w.generation[i];
      if (was && !(is && same)) this.deaths[this.species[i]!]!++;
      if (is && !(was && same)) this.births[w.species[i]!]!++;
    }
    this.alive.set(w.alive);
    this.gen.set(w.generation);
    this.species.set(w.species);
  }
  take(): { births: number[]; deaths: number[] } {
    const r = { births: this.births, deaths: this.deaths };
    this.births = new Array<number>(SPECIES.count).fill(0);
    this.deaths = new Array<number>(SPECIES.count).fill(0);
    return r;
  }
}

type Zone = [number, number] | [number, number, number, number];
interface Probe {
  label: string;
  /** Такт выборки; отрицательный — смещение от конца подготовки (−1 = ровно конец подготовки). */
  tick: number;
  zones?: Zone[];
  plants?: number[];
}
interface Scenario {
  name: string;
  setup: Setup;
  /** Конец прогона: абсолютный такт или «конец подготовки + столько суток». */
  endTick?: number;
  afterDays?: number;
  probes: Probe[];
  fullEvery: number;
  portionHashes?: boolean;
}

function step(sim: Simulation): { ms: number; flora: boolean } {
  const flora = (sim.world.tick - 25) % 50 === 0;
  const t = performance.now();
  sim.step();
  return { ms: performance.now() - t, flora };
}

function run(sc: Scenario) {
  const t0 = performance.now();
  const sim = create(sc.setup);
  const start = sim.world.tick;
  const prep = sim.preparation ? { startTick: sim.preparation.startTick, targetTick: sim.preparation.targetTick, years: sim.preparation.years } : null;
  const prepEnd = prep ? prep.targetTick : start;
  const endTick = sc.endTick ?? prepEnd + (sc.afterDays ?? 0) * TICKS_PER_DAY;
  const demo = new Demography(sim);
  const initial = { ...compact(sim, 0), ...full(sim) };
  const days: unknown[] = [];
  const probes: unknown[] = [];
  const portions: string[] = [];
  const portionMs: number[] = [];
  const dayMs: number[] = [];
  let prepMs = 0;
  const pending = sc.probes.map((p) => ({ ...p, tick: p.tick < 0 ? prepEnd : p.tick })).sort((a, b) => a.tick - b.tick);
  const lastDay = Math.floor((endTick - start) / TICKS_PER_DAY);
  let d = 0;
  let acc = 0;
  const doProbe = () => {
    while (pending.length && pending[0]!.tick <= sim.world.tick) {
      const p = pending.shift()!;
      if (p.tick !== sim.world.tick) throw new Error(`выборка ${p.label} пропущена`);
      probes.push({ label: p.label, tick: p.tick, stateHash: sim.stateHash(), zones: (p.zones ?? []).map((z) => ({ ...zoneRaw(sim, z[0], z[1], z[2], z[3]) })), plants: (p.plants ?? []).map((i) => plantProbe(sim, i)) });
    }
  };
  doProbe();
  while (sim.world.tick < endTick) {
    const nextDay = start + (d + 1) * TICKS_PER_DAY;
    const target = Math.min(nextDay, pending.length ? pending[0]!.tick : Infinity, endTick);
    while (sim.world.tick < target) {
      const preparing = sim.preparation !== null;
      const r = step(sim);
      acc += r.ms;
      if (preparing) prepMs += r.ms;
      if (!r.flora) continue;
      portionMs.push(r.ms);
      if (sc.portionHashes && d === 0) portions.push(sim.stateHash());
    }
    if (sim.world.tick === nextDay) {
      d++;
      dayMs.push(acc);
      acc = 0;
      demo.update(sim);
      const isFull = d === 1 || d % sc.fullEvery === 0 || d === lastDay;
      days.push(isFull ? { ...compact(sim, d), ...full(sim), demography: demo.take() } : compact(sim, d));
      if (d % 100 === 0) console.log(`${sc.name}: сутки ${d}/${lastDay}, древесных ${sim.world.flora.woody.count}`);
    }
    doProbe();
  }
  const final = { tick: sim.world.tick, stateHash: sim.stateHash(), preparing: sim.preparation !== null };
  const ms = performance.now() - t0;
  console.log(`${sc.name}: ${d} сут. за ${(ms / 1000).toFixed(1)} с (подготовка ${(prepMs / 1000).toFixed(1)} с), порция ${stat(portionMs).mean.toFixed(3)} мс, древесных ${sim.world.flora.woody.count}`);
  return { name: sc.name, setup: sc.setup, geoHash: sim.world.geoHash, preparation: prep, endTick, fullEvery: sc.fullEvery, initial, portions: sc.portionHashes ? portions : undefined, days, probes, final, timing: { ms, prepMs, portionMs: stat(portionMs), dayMs: stat(dayMs) } };
}

// ───────── Сценарии ─────────

const START = 16500;
const results: Record<string, unknown> = {};
const want = (name: string) => ONLY === null || ONLY.has(name);
const add = (sc: Scenario) => {
  if (want(sc.name)) results[sc.name] = run(sc);
};
const WET: PlotOptions = { precip: 750, soil: 'loam', fertility: 0.8, n: 48 };
const MIXED: PlotOptions = { n: 48, precip: 720, soil: 'loam', fertility: 0.75, riverColumns: 3, east: { soil: 'sand', precip: 300, fertility: 0.25 } };
const BOUNDARY: PlotOptions = { n: 48, precip: 750, soil: 'loam', fertility: 0.8, east: { soil: 'rock', precip: 120, fertility: 0.05 } };
const open = (seed: number): Cfg => ({ scenario: 'genesis', isolated: false, seed });
const wild = (seed: number, isolated = false, climate?: Cfg['climate']): Cfg => ({ scenario: 'wild', isolated, seed, ...(climate ? { climate } : {}) });
const after = (y: number) => START + y * YEAR_TICKS;

// D — Genesis без изоляции.
for (const seed of [1, 2, 3]) {
  // Тест A: год 1 — банк семян у сухопутного края против середины; затем каждые 2 года — доля занятых ячеек.
  add({
    name: `A-${seed}`,
    setup: { kind: 'plot', plot: WET, config: open(seed) },
    endTick: after(QUICK ? 1 : 9),
    probes: [
      { label: 'начало', tick: START, zones: [[0, 48]] },
      { label: 'год 1', tick: after(1), zones: [[45, 48], [18, 30, 18, 30], [0, 48]] },
      ...(QUICK ? [] : [3, 5, 7, 9].map((y) => ({ label: `год ${y}`, tick: after(y), zones: [[0, 48]] as Zone[] }))),
    ],
    fullEvery: 20,
    portionHashes: seed === 1,
  });
  // Тест D: восток — каменистая пустыня 120 мм.
  add({ name: `Dbound-${seed}`, setup: { kind: 'plot', plot: BOUNDARY, config: open(seed) }, endTick: after(QUICK ? 1 : 10), probes: [{ label: 'итог', tick: after(QUICK ? 1 : 10), zones: [[0, 24], [24, 48]] }], fullEvery: 20 });
}
// Тест F: детерминизм колонизации — seed 1 и 101 (C# повторяет seed 1).
for (const seed of [1, 101]) add({ name: `Fdet-${seed}`, setup: { kind: 'plot', plot: WET, config: open(seed) }, endTick: after(QUICK ? 1 : 3), probes: [], fullEvery: 20 });
// Болото у реки (seed 6, 10 лет).
add({ name: 'bog-6', setup: { kind: 'plot', plot: { n: 32, precip: 900, soil: 'clay', fertility: 0.6, riverColumns: 4 }, config: open(6) }, endTick: after(QUICK ? 1 : 10), probes: [{ label: 'итог', tick: after(QUICK ? 1 : 10), zones: [[0, 32]] }], fullEvery: 20 });
// flora-dynamics в исходном виде (открытый Genesis): берёза растёт и сбрасывает листву; сосна с хвоей зимой.
const midsummer = (y: number) => ((y - 1) * YEAR + 7.5) * TICKS_PER_DAY;
add({
  name: 'birchOpen',
  setup: { kind: 'plot', plot: { precip: 900, soil: 'loam', fertility: 0.8 }, config: { scenario: 'genesis', isolated: false, seed: 7 }, plants: [['birch', 128, 128, 16 * 32 + 16, 0.5, 2]] },
  endTick: midsummer(4),
  probes: [
    { label: 'лето 1', tick: midsummer(1), plants: [0] },
    { label: 'зима 1', tick: midsummer(1) + 10 * TICKS_PER_DAY, plants: [0] },
    { label: 'лето 4', tick: midsummer(4), plants: [0] },
  ],
  fullEvery: 20,
});
add({
  name: 'pineOpen',
  setup: { kind: 'plot', plot: { precip: 260, soil: 'sand', fertility: 0.3, tMean: 11 }, config: { scenario: 'genesis', isolated: false, seed: 7 }, plants: [['pine', 128, 128, 16 * 32 + 16, 0.5, 2]] },
  endTick: START + 15 * TICKS_PER_DAY,
  probes: [{ label: 'через 15 суток', tick: START + 15 * TICKS_PER_DAY, plants: [0] }],
  fullEvery: 5,
});

// E, F и другие миры Wildlands.
const PREP = QUICK ? 1 : 20;
const endProbe = (n: number): Probe => ({ label: 'подготовка завершена', tick: -1, zones: [[0, n]] });
add({ name: 'E-S42', setup: { kind: 'world', size: 'S', config: wild(42), prepareYears: PREP }, afterDays: (QUICK ? 1 : 5) * YEAR, probes: [endProbe(256)], fullEvery: 20, portionHashes: true });
add({ name: 'F-S42', setup: { kind: 'world', size: 'S', config: wild(42, true), prepareYears: PREP }, afterDays: (QUICK ? 1 : 3) * YEAR, probes: [endProbe(256)], fullEvery: 20 });
add({ name: 'W-S7-cold', setup: { kind: 'world', size: 'S', config: wild(7, false, 'cold'), prepareYears: PREP }, afterDays: YEAR, probes: [endProbe(256)], fullEvery: 20 });
add({ name: 'W-S1234-warm', setup: { kind: 'world', size: 'S', config: wild(1234, false, 'warm'), prepareYears: PREP }, afterDays: YEAR, probes: [endProbe(256)], fullEvery: 20 });
if (!process.argv.includes('--no-m')) add({ name: 'W-M42', setup: { kind: 'world', size: 'M', config: wild(42), prepareYears: PREP }, afterDays: YEAR, probes: [endProbe(512)], fullEvery: 20 });

// flora-worlds H: Wildlands на разнообразном участке, 20 лет.
for (const seed of [1, 2, 3]) add({ name: `H-${seed}`, setup: { kind: 'plot', plot: MIXED, config: wild(seed), prepareYears: QUICK ? 1 : 20 }, afterDays: 0, probes: [endProbe(48)], fullEvery: 20 });
// «Изолированный Wildlands»: подготовка у изолированного и открытого мира одинакова; после подготовки притока нет.
const M32: PlotOptions = { ...MIXED, n: 32 };
for (const seed of [1, 2]) {
  add({ name: `isoW-${seed}`, setup: { kind: 'plot', plot: M32, config: wild(seed, true), prepareYears: 2 }, afterDays: 0, probes: [], fullEvery: 20 });
  add({ name: `openW-${seed}`, setup: { kind: 'plot', plot: M32, config: wild(seed, false), prepareYears: 2 }, afterDays: 0, probes: [], fullEvery: 20 });
  add({ name: `isoW6-${seed}`, setup: { kind: 'plot', plot: M32, config: wild(seed, true), prepareYears: 6 }, afterDays: 3 * YEAR, probes: [{ label: 'подготовка завершена', tick: -1 }], fullEvery: 20 });
}

const out = {
  tool: 'unity-flora-g3d-golden',
  node: process.version,
  reference: '7b2fbabbc1',
  quick: QUICK,
  species: PLANTS.map((p) => p.id),
  biomes: BIOMES.map((b) => b.id),
  herbs: SPECIES.herbs.map((h) => PLANTS[h]!.id),
  runs: results,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`G3 D–F → ${OUT}`);
