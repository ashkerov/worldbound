// Эталон G3 C переноса флоры (Stage 2.4): древесные вместе с травами — с настоящего TS `Simulation` (снимок 7b2fbabbc1).
// Все миры — Genesis с изоляцией (колонизация, семена региона и подготовка Wildlands — этап 2.5). Начальное состояние
// задаётся настоящими помощниками TS (plantLoadStand, plantSourceStrip, тела исходных тестов) и описывается декларативно
// (`setup`), чтобы C# построил то же самое; совпадение проверяется полным stateHash на такте 0.
//  • C1 — нагрузочный стенд: мир S/42, луг и банк семян на всей суше + plantLoadStand(10 000), 40 суток (два дня рассева),
//    stateHash после каждой из 144 порций первых суток;
//  • C2 — сукцессия runSuccession(WET, seed, 50) для seed 1, 2, 3: каждые сутки 50 лет; выборки середины лета каждого
//    года (поле и ближняя полоса, без округления); совпадение с самим runSuccession проверяется здесь же;
//  • исходные тесты TS о древесных: Опыт B (DRY, 40 лет), Опыт C (конкуренция за свет, runShade), Опыт E (детерминизм),
//    тест C flora-worlds (распространение в изолированном мире, seed 1–3), заполнение хранилища (flora-capacity);
//    тесты flora-dynamics (берёза, сосна, баланс 20 лет) — в изолированном варианте (исходные идут на открытом мире
//    или Wildlands — этап 2.5), критерии те же;
//  • нагрузка: S/42 с 75 тыс. и M/42 с 300 тыс. древесных и лугом — 14 суток (дни рассева), время TS.
// Использование: npx tsx tools/unity-flora-g3c-golden.ts [--quick] [--out unity/WorldboundProto/Golden/flora-g3c.json]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { DEFAULT_CONFIG, type WorldConfig } from '../src/shared/worldConfig';
import { TICKS_PER_DAY, yearFraction } from '../src/shared/time';
import { WaterKind } from '../src/sim/worldgen/geo';
import { BIOMES } from '../src/sim/flora/biomes';
import { NO_SPECIES, PLANTS, SPECIES, speciesIndex } from '../src/sim/flora/species';
import { Ledger, SLOTS, nutrientBudget, nutrientStock } from '../src/sim/flora/state';
import { biomeCounts } from '../src/sim/flora/biomeState';
import { refreshCover, woodyHeight } from '../src/sim/flora/system';
import { plantLoadStand } from '../src/sim/flora/loadStand';
import { plotSimulation, type PlotOptions } from '../tests/support/plot';
import { DRY, WET, plantSourceStrip, runSuccession } from '../tests/support/experiments';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/flora-g3c.json');
const QUICK = process.argv.includes('--quick');
const YEAR = 20;
const midsummer = (y: number) => ((y - 1) * YEAR + 7.5) * TICKS_PER_DAY;

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

// ───────── Декларативная настройка (C# повторяет её дословно) ─────────

type Setup =
  | { kind: 'loadStand'; size: 'S' | 'M'; seed: number; target: number }
  | { kind: 'sourceStrip'; plot: PlotOptions; seed: number; columns: number }
  | { kind: 'shade'; seed: number; shaded: boolean }
  | { kind: 'spawn'; plot: PlotOptions; seed: number; plants: [string, number, number, number, number, number][]; resetStock: boolean }
  | { kind: 'storeFill'; plot: PlotOptions; seed: number }
  | { kind: 'plantSource'; plot: PlotOptions; seed: number; width: number };

const genesis = (seed: number) => ({ scenario: 'genesis' as const, isolated: true, seed });

/** Луг (4 вида по очереди, 40 г/м²) и банк семян всех трав 1 г/м² на всей суше — как нагрузка G3 B. */
function herbsEverywhere(sim: Simulation): void {
  const f = sim.world.flora;
  const geo = sim.world.geo;
  const count = geo.n * geo.n;
  const herbs = SPECIES.herbs;
  let m = 0;
  for (let c = 0; c < count; c++) {
    if (geo.waterKind[c] !== WaterKind.None) continue;
    for (const s of herbs) f.seedBank[SPECIES.herbSlot[s]! * count + c] = 1;
    for (let k = 0; k < SLOTS; k++) {
      f.slotSpecies[c * SLOTS + k] = herbs[m++ % herbs.length]!;
      f.slotBiomass[c * SLOTS + k] = 40;
    }
  }
}

function resetLedger(sim: Simulation): void {
  const f = sim.world.flora;
  f.ledger.fill(0);
  f.ledger[Ledger.initialStock] = nutrientStock(f, sim.world.geo);
}

function create(s: Setup): Simulation {
  switch (s.kind) {
    case 'loadStand': {
      const config: WorldConfig = { ...DEFAULT_CONFIG, seed: s.seed, size: s.size, scenario: 'genesis', isolated: true };
      const sim = new Simulation({ config, testAgents: 0 });
      herbsEverywhere(sim);
      plantLoadStand(sim.world, s.target);
      resetLedger(sim);
      return sim;
    }
    case 'sourceStrip': {
      // Как runSuccession: plotSimulation(..., { scenario: 'genesis', isolated: true, seed }) + plantSourceStrip.
      const sim = plotSimulation(s.plot, genesis(s.seed));
      plantSourceStrip(sim, s.columns);
      return sim;
    }
    case 'shade': {
      // Тело make() из runShade (tests/support/experiments.ts).
      const sim = plotSimulation({ ...WET, n: 32 }, genesis(s.seed));
      const f = sim.world.flora;
      const n = 32;
      const spruce = PLANTS.findIndex((p) => p.id === 'spruce');
      const mix: [string, number][] = [
        ['meadow-grass', 120],
        ['clover', 40],
        ['bilberry', 30],
        ['moss', 20],
      ];
      for (let c = 0; c < n * n; c++) {
        for (const h of SPECIES.herbs) f.seedBank[SPECIES.herbSlot[h]! * n * n + c] = 1;
        mix.forEach(([id, b], k) => {
          f.slotSpecies[c * SLOTS + k] = PLANTS.findIndex((p) => p.id === id);
          f.slotBiomass[c * SLOTS + k] = b;
        });
        if (s.shaded) {
          const x = c % n;
          const z = Math.floor(c / n);
          for (const [dx, dz] of [
            [2, 2],
            [6, 6],
          ]) {
            f.woody.spawn(spruce, x * 8 + dx!, z * 8 + dz!, c, 900, 60);
            f.woodyCount[c] = f.woodyCount[c]! + 1;
          }
        }
      }
      refreshCover(sim.world, true);
      resetLedger(sim);
      return sim;
    }
    case 'spawn': {
      // Тела тестов flora-dynamics: растения ставятся spawn без счётчика ячейки и без пересчёта полога (как в тестах).
      const sim = plotSimulation(s.plot, genesis(s.seed));
      for (const [id, x, z, c, b, age] of s.plants) sim.world.flora.woody.spawn(speciesIndex(id), x, z, c, b, age);
      if (s.resetStock) sim.world.flora.ledger[Ledger.initialStock] = nutrientStock(sim.world.flora, sim.world.geo);
      return sim;
    }
    case 'storeFill': {
      // Тело теста «при заполненном хранилище семена уходят в опад» (flora-capacity.test.ts).
      const sim = plotSimulation(s.plot, genesis(s.seed));
      const w = sim.world;
      const f = w.flora;
      const store = f.woody;
      const birch = speciesIndex('birch');
      for (let k = 0; k < 64; k++) {
        const c = (4 + (k >> 3) * 3) * 32 + 4 + (k & 7) * 3;
        store.spawn(birch, ((c % 32) + 0.5) * 8, (Math.floor(c / 32) + 0.5) * 8, c, 300, 30);
      }
      let c = 0;
      while (store.spawn(birch, ((c % 32) + 0.5) * 8, (Math.floor(c / 32) + 0.5) * 8, c, 0.002, 0) >= 0) c = (c + 1) % (32 * 32);
      refreshCover(w, false);
      f.ledger[Ledger.initialStock] = nutrientStock(f, w.geo);
      return sim;
    }
    case 'plantSource': {
      // plantSource из flora-worlds.test.ts (тест C).
      const sim = plotSimulation(s.plot, genesis(s.seed));
      const w = sim.world;
      const f = w.flora;
      const n = w.geo.n;
      const count = n * n;
      for (let z = 0; z < n; z++) {
        for (let x = 0; x < s.width; x++) {
          const c = z * n + x;
          for (const id of ['meadow-grass', 'clover', 'fireweed']) f.seedBank[SPECIES.herbSlot[speciesIndex(id)]! * count + c] = 1;
          if ((x + z) % 2 === 0) {
            const sp = speciesIndex(z % 4 === 0 ? 'birch' : 'alder');
            f.woody.spawn(sp, (x + 0.5) * 8, (z + 0.5) * 8, c, 300, 30);
            f.woodyCount[c] = f.woodyCount[c]! + 1;
          }
        }
      }
      refreshCover(w, true);
      f.ledger[Ledger.initialStock] = nutrientStock(f, w.geo);
      return sim;
    }
  }
}

// ───────── Сводки (C# пересчитывает те же суммы в том же порядке) ─────────

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
  for (let i = 0; i < w.highWater; i++) {
    if (w.alive[i] !== 1) continue;
    const s = w.species[i]!;
    bySpecies[s] = bySpecies[s]! + 1;
    bySpeciesBiomass[s] = bySpeciesBiomass[s]! + w.biomass[i]!;
    stages[w.stage[i]!] = stages[w.stage[i]!]! + 1;
  }
  const hw = w.highWater;
  return {
    biomeCounts: biomeCounts(sim.world),
    herbs: { biomass: herbBio.map(bits), slots: herbSlots, bank: bank.map(bits), occupied, green: bits(green) },
    soil: { litterFast: bits(litterFast), litterWood: bits(litterWood), nutrient: bits(nutrient), negatives },
    woody: {
      bySpecies,
      bySpeciesBiomass: bySpeciesBiomass.map(bits),
      stages,
      cover: cover.map(bits),
      woodyCountSum,
      woodyCountMax,
      free: fnv(w.freeSlots()),
    },
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

/** sampleZone без округления (те же формулы; C# считает то же самое). */
function zoneRaw(sim: Simulation, from: number, to: number) {
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
  for (let z = 0; z < n; z++) {
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
    if (w.alive[i] !== 1 || w.x[i]! < from * geo.cellSize || w.x[i]! >= to * geo.cellSize) continue;
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

/** Рождения и смерти по видам между снимками: по живости и поколению индекса (C# считает так же). */
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
    for (let i = 0; i < w.capacity; i++) {
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

interface Probe {
  label: string;
  tick: number;
  zones?: [number, number][];
  plants?: number[];
}

interface Scenario {
  name: string;
  setup: Setup;
  /** Сутки от начала (границы суток — от стартового такта), включительно до последней выборки. */
  endTick: number;
  probes: Probe[];
  /** Полная сводка каждые столько суток (и на первых и последних сутках). */
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
  const demo = new Demography(sim);
  const initial = { ...compact(sim, 0), ...full(sim) };
  const days: unknown[] = [];
  const probes: unknown[] = [];
  const portions: string[] = [];
  const portionMs: number[] = [];
  const dayMs: number[] = [];
  const pending = [...sc.probes].sort((a, b) => a.tick - b.tick);
  const lastDay = Math.floor((sc.endTick - start) / TICKS_PER_DAY);
  let d = 0;
  let acc = 0;
  const doProbe = () => {
    while (pending.length && pending[0]!.tick <= sim.world.tick) {
      const p = pending.shift()!;
      if (p.tick !== sim.world.tick) throw new Error(`выборка ${p.label} пропущена`);
      probes.push({ label: p.label, tick: p.tick, stateHash: sim.stateHash(), zones: (p.zones ?? []).map(([a, b]) => zoneRaw(sim, a, b)), plants: (p.plants ?? []).map((i) => plantProbe(sim, i)) });
    }
  };
  doProbe();
  while (sim.world.tick < sc.endTick) {
    const nextDay = start + (d + 1) * TICKS_PER_DAY;
    const target = Math.min(nextDay, pending.length ? pending[0]!.tick : Infinity, sc.endTick);
    while (sim.world.tick < target) {
      const r = step(sim);
      acc += r.ms;
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
      if (d % 200 === 0) console.log(`${sc.name}: сутки ${d}/${lastDay}`);
    }
    doProbe();
  }
  const final = { tick: sim.world.tick, stateHash: sim.stateHash() };
  const ms = performance.now() - t0;
  console.log(`${sc.name}: ${d} сут. за ${(ms / 1000).toFixed(1)} с, порция ${stat(portionMs).mean.toFixed(3)} мс, сутки ${stat(dayMs).mean.toFixed(1)} мс, древесных ${sim.world.flora.woody.count}`);
  return { name: sc.name, setup: sc.setup, geoHash: sim.world.geoHash, endTick: sc.endTick, fullEvery: sc.fullEvery, initial, portions: sc.portionHashes ? portions : undefined, days, probes, final, timing: { ms, portionMs: stat(portionMs), dayMs: stat(dayMs) } };
}

// ───────── Сценарии ─────────

const START = 16500; // startTick(5): середина весны, сутки 2 года
const yearly = (years: number, zones: [number, number][]) => Array.from({ length: years }, (_, k) => ({ label: `год ${k + 1}`, tick: midsummer(k + 1), zones }));
const C2_YEARS = QUICK ? 3 : 50;
const results: Record<string, unknown> = {};
const criteria: Record<string, unknown> = {};

// C1 — нагрузочный стенд: S/42, 10 000 древесных и луг.
results.C1 = run({ name: 'C1', setup: { kind: 'loadStand', size: 'S', seed: 42, target: 10000 }, endTick: START + (QUICK ? 3 : 40) * TICKS_PER_DAY, probes: [], fullEvery: 1, portionHashes: true });

// C2 — сукцессия WET, seed 1, 2, 3, 50 лет.
const zonesC2: [number, number][] = [
  [6, 48],
  [6, 16],
];
const forestCells = (b: Record<string, number>) => (b['woodland'] ?? 0) + (b['broadleaf-forest'] ?? 0) + (b['mixed-forest'] ?? 0) + (b['coniferous-forest'] ?? 0);
for (const seed of [1, 2, 3]) {
  const r = run({ name: `C2-${seed}`, setup: { kind: 'sourceStrip', plot: WET, seed, columns: 4 }, endTick: midsummer(C2_YEARS), probes: yearly(C2_YEARS, zonesC2), fullEvery: 20, portionHashes: seed === 1 });
  results[`C2-${seed}`] = r;
  // Тот же прогон через сам runSuccession: хеш и выборки (с округлением теста) обязаны совпасть.
  const ref = runSuccession(WET, seed, C2_YEARS);
  if (ref.stateHash !== r.final.stateHash) throw new Error(`C2 seed ${seed}: runSuccession ${ref.stateHash} ≠ прогон инструмента ${r.final.stateHash}`);
  if (!QUICK) {
    const at = (y: number) => ref.samples[y - 1]!;
    const near = (y: number) => ref.near[y - 1]!;
    const cells = 48 * 42;
    criteria[`C2-${seed}`] = {
      herbs12: [at(12).herbOccupancy, at(12).herbOccupancy > 0.8 && at(12).shrubCover < 0.01 && at(12).treeCover < 0.01],
      shrubs40vs15: [at(40).shrubs, at(15).shrubs, at(40).shrubs > 3 * at(15).shrubs],
      shrubCover50: [at(50).shrubCover, at(50).shrubCover > 0.03],
      matureTrees30: [at(30).treeStages[2], at(30).treeStages[2] > 0],
      treeCover50vs30: [at(50).treeCover, at(30).treeCover, at(50).treeCover > at(30).treeCover],
      nearTreeCover50: [near(50).treeCover, near(50).treeCover > 0.05],
      nearForest50: [forestCells(near(50).biomes), forestCells(near(50).biomes) > 0],
      nearTopHeight50: [near(50).topHeight, near(50).topHeight > 12],
      limits: ref.samples.every((s) => s.shrubs + s.trees <= cells * 12 && s.seedBank < 50 && s.herbs < 600 && s.balanceError < 1e-4),
      maxBalanceError: Math.max(...ref.samples.map((s) => s.balanceError)),
    };
  }
}

// Опыт B: сухой бедный участок остаётся степью (DRY, seed 1, 40 лет).
const B_YEARS = QUICK ? 2 : 40;
results.B = run({ name: 'B', setup: { kind: 'sourceStrip', plot: DRY, seed: 1, columns: 4 }, endTick: midsummer(B_YEARS), probes: yearly(B_YEARS, [[6, 48]]), fullEvery: 20 });
// Опыт E: детерминизм (WET, seed 5 и 6, 15 лет).
const E_YEARS = QUICK ? 2 : 15;
results.E5 = run({ name: 'E5', setup: { kind: 'sourceStrip', plot: WET, seed: 5, columns: 4 }, endTick: midsummer(E_YEARS), probes: yearly(E_YEARS, zonesC2), fullEvery: 20 });
results.E6 = run({ name: 'E6', setup: { kind: 'sourceStrip', plot: WET, seed: 6, columns: 4 }, endTick: midsummer(E_YEARS), probes: yearly(E_YEARS, zonesC2), fullEvery: 20 });
// Опыт C: конкуренция за свет (runShade(1, 20)): открытое место и ельник.
const SH_YEARS = QUICK ? 2 : 20;
results.shadeOpen = run({ name: 'shadeOpen', setup: { kind: 'shade', seed: 1, shaded: false }, endTick: midsummer(SH_YEARS), probes: [{ label: 'итог', tick: midsummer(SH_YEARS), zones: [[0, 32]] }], fullEvery: 20 });
results.shadeSpruce = run({ name: 'shadeSpruce', setup: { kind: 'shade', seed: 1, shaded: true }, endTick: midsummer(SH_YEARS), probes: [{ label: 'итог', tick: midsummer(SH_YEARS), zones: [[0, 32]] }], fullEvery: 20 });

// flora-dynamics (изолированный вариант): берёза — рост и листопад; сосна — хвоя зимой; баланс 20 лет.
const DYN_WET: PlotOptions = { precip: 900, soil: 'loam', fertility: 0.8 };
const DYN_DRY: PlotOptions = { precip: 260, soil: 'sand', fertility: 0.3, tMean: 11 };
const winter1 = midsummer(1) + 10 * TICKS_PER_DAY;
results.birch = run({
  name: 'birch',
  setup: { kind: 'spawn', plot: DYN_WET, seed: 7, plants: [['birch', 128, 128, 16 * 32 + 16, 0.5, 2]], resetStock: false },
  endTick: midsummer(4),
  probes: [
    { label: 'лето 1', tick: midsummer(1), plants: [0] },
    { label: 'зима 1', tick: winter1, plants: [0] },
    { label: 'лето 4', tick: midsummer(4), plants: [0] },
  ],
  fullEvery: 20,
});
results.pine = run({
  name: 'pine',
  setup: { kind: 'spawn', plot: DYN_DRY, seed: 7, plants: [['pine', 128, 128, 16 * 32 + 16, 0.5, 2]], resetStock: false },
  endTick: START + 15 * TICKS_PER_DAY,
  probes: [{ label: 'через 15 суток', tick: START + 15 * TICKS_PER_DAY, plants: [0] }],
  fullEvery: 5,
});
const balancePlants: [string, number, number, number, number, number][] = [];
for (let k = 0; k < 40; k++) balancePlants.push([k % 2 ? 'alder' : 'birch', (k % 8) * 30 + 10, Math.floor(k / 8) * 40 + 20, Math.floor((Math.floor(k / 8) * 40 + 20) / 8) * 32 + Math.floor(((k % 8) * 30 + 10) / 8), 40, 15]);
const BAL_DAYS = QUICK ? 20 : 20 * YEAR;
for (const [name, plot] of [
  ['balanceWet', DYN_WET],
  ['balanceDry', DYN_DRY],
] as const)
  results[name] = run({ name, setup: { kind: 'spawn', plot, seed: 7, plants: balancePlants, resetStock: true }, endTick: START + BAL_DAYS * TICKS_PER_DAY, probes: [], fullEvery: 20 });

// flora-capacity: заполненное хранилище.
results.storeFill = run({ name: 'storeFill', setup: { kind: 'storeFill', plot: { precip: 750, soil: 'loam', fertility: 0.9, n: 32 }, seed: 3 }, endTick: START + 20 * TICKS_PER_DAY, probes: [], fullEvery: 1 });

// flora-worlds, тест C: распространение в изолированном мире (seed 1–3): 3 года, затем ещё 7.
const WORLDS_WET: PlotOptions = { precip: 750, soil: 'loam', fertility: 0.8, n: 48 };
for (const seed of [1, 2, 3]) {
  const z: [number, number][] = [
    [6, 48],
    [6, 16],
    [36, 48],
  ];
  results[`spread-${seed}`] = run({
    name: `spread-${seed}`,
    setup: { kind: 'plantSource', plot: WORLDS_WET, seed, width: 4 },
    endTick: START + (QUICK ? 4 : 10) * YEAR * TICKS_PER_DAY,
    probes: [
      { label: 'начало', tick: START, zones: z },
      { label: '3 года', tick: START + 3 * YEAR * TICKS_PER_DAY, zones: z },
      { label: '10 лет', tick: START + (QUICK ? 4 : 10) * YEAR * TICKS_PER_DAY, zones: z },
    ],
    fullEvery: 20,
  });
}

// Нагрузка: луг и стенд древесных на созданных мирах (14 суток — с днями рассева).
const LOAD_DAYS = QUICK ? 2 : 14;
results['load-S'] = run({ name: 'load-S', setup: { kind: 'loadStand', size: 'S', seed: 42, target: 75000 }, endTick: START + LOAD_DAYS * TICKS_PER_DAY, probes: [], fullEvery: 7 });
results['load-M'] = run({ name: 'load-M', setup: { kind: 'loadStand', size: 'M', seed: 42, target: 300000 }, endTick: START + LOAD_DAYS * TICKS_PER_DAY, probes: [], fullEvery: 7 });

const out = {
  tool: 'unity-flora-g3c-golden',
  node: process.version,
  reference: '7b2fbabbc1',
  quick: QUICK,
  species: PLANTS.map((p) => p.id),
  biomes: BIOMES.map((b) => b.id),
  herbs: SPECIES.herbs.map((h) => PLANTS[h]!.id),
  yearFracStart: bits(yearFraction(START, 5)),
  criteriaTs: criteria,
  runs: results,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`G3 C → ${OUT}`);
