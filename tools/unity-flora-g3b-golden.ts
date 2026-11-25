// Эталон G3 B переноса флоры (Stage 2.3): травяной ярус с настоящего TS `Simulation` (снимок 7b2fbabbc1).
// Все участки — изолированные миры Genesis без древесных. Начальное состояние задаётся декларативно (заливки `fills`)
// и применяется одинаково в TS и C#: по ячейкам суши выбранных столбцов (z — внешний цикл, x — внутренний) — слоты
// трав, банк семян, запас питания; затем refreshCover(world, true), обнуление ведомости и точка отсчёта баланса — как
// в plantSourceStrip (tests/support/experiments.ts). Совпадение начальной настройки проверяется полным stateHash.
//  • B1 (WET) и B2 (DRY): plotGeo 48 × 48, опушка = plantSourceStrip без древесных (4 столбца: банк семян всех трав,
//    во второй половине — луг из всех трав по очереди, 40 г/м²), 20 лет; после каждой из 144 порций первых суток B1 —
//    полный stateHash; каждые сутки — stateHash, ведомость, запас, бюджет, ошибка баланса, биомы, сводки трав;
//  • малые опыты (32 × 32) для обязательных проверок: рост, конкуренция, предел питания, мороз, засуха/исчезновение,
//    расселение у реки, прорастание, старение банка;
//  • нагрузка: Genesis S/42 и M/42 с лугом и банком на всей суше — 2 суток (хеши) и время TS.
// Использование: npx tsx tools/unity-flora-g3b-golden.ts [--years 20] [--out unity/WorldboundProto/Golden/flora-g3b.json]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { DEFAULT_CONFIG, type WorldConfig } from '../src/shared/worldConfig';
import { TICKS_PER_DAY, yearFraction } from '../src/shared/time';
import { WaterKind } from '../src/sim/worldgen/geo';
import { NO_SPECIES, PLANTS, SPECIES } from '../src/sim/flora/species';
import { Ledger, SLOTS, nutrientBudget, nutrientStock } from '../src/sim/flora/state';
import { biomeCounts } from '../src/sim/flora/biomeState';
import { refreshCover } from '../src/sim/flora/system';
import { plotSimulation, type PlotOptions } from '../tests/support/plot';
import { DRY, WET } from '../tests/support/experiments';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/flora-g3b.json');
const YEARS = Number(opt('years', '20'));

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
  return { n: s.length, mean: s.reduce((a, v) => a + v, 0) / s.length, p95: p(0.95), p99: p(0.99), max: s[s.length - 1] };
};

/** Заливка начального состояния: столбцы [x0, x1), только суша. */
interface Fill {
  x0: number;
  x1: number;
  /** Слоты: [вид, г/м²] по порядку. */
  slots?: [string, number][];
  /** Луг: 4 слота по очереди из всех трав каталога (общий счётчик по всем заливкам), г/м². */
  cycle?: number;
  /** Банк семян: виды ('all' — все травы) и значение, г/м². */
  bank?: { species: string[] | 'all'; value: number };
  /** Запас доступного питания, г/м². */
  nutrient?: number;
}
interface Setup {
  name: string;
  /** Участок plotGeo или созданный мир (size). */
  plot?: PlotOptions;
  size?: 'S' | 'M';
  seed: number;
  days: number;
  fills: Fill[];
}

const speciesIndex = (id: string): number => {
  const i = PLANTS.findIndex((p) => p.id === id);
  if (i < 0 || SPECIES.woody[i] === 1) throw new Error(`не трава: ${id}`);
  return i;
};

function create(s: Setup): Simulation {
  if (s.plot) return plotSimulation(s.plot, { scenario: 'genesis', isolated: true, seed: s.seed });
  const config: WorldConfig = { ...DEFAULT_CONFIG, seed: s.seed, size: s.size!, scenario: 'genesis', isolated: true };
  return new Simulation({ config, testAgents: 0 });
}

function applyFills(sim: Simulation, fills: Fill[]): void {
  const f = sim.world.flora;
  const geo = sim.world.geo;
  const n = geo.n;
  const count = n * n;
  const herbs = SPECIES.herbs;
  let m = 0;
  for (const fill of fills) {
    for (let z = 0; z < n; z++) {
      for (let x = fill.x0; x < Math.min(fill.x1, n); x++) {
        const c = z * n + x;
        if (geo.waterKind[c] !== WaterKind.None) continue;
        if (fill.bank) {
          const ids = fill.bank.species === 'all' ? herbs : fill.bank.species.map(speciesIndex);
          for (const s of ids) f.seedBank[SPECIES.herbSlot[s]! * count + c] = fill.bank.value;
        }
        if (fill.cycle !== undefined) {
          for (let k = 0; k < SLOTS; k++) {
            f.slotSpecies[c * SLOTS + k] = herbs[m++ % herbs.length]!;
            f.slotBiomass[c * SLOTS + k] = fill.cycle;
          }
        }
        if (fill.slots) {
          fill.slots.forEach(([id, b], k) => {
            f.slotSpecies[c * SLOTS + k] = speciesIndex(id);
            f.slotBiomass[c * SLOTS + k] = b;
          });
        }
        if (fill.nutrient !== undefined) f.nutrient[c] = fill.nutrient;
      }
    }
  }
  refreshCover(sim.world, true);
  f.ledger.fill(0);
  f.ledger[Ledger.initialStock] = nutrientStock(f, geo);
}

/** Отпечаток статики участка: C# строит plotGeo сам и сверяет. */
function geoPrint(sim: Simulation): Record<string, unknown> {
  const g = sim.world.geo;
  return {
    n: g.n, cellSize: g.cellSize, edges: g.edges, windX: bits(g.windX), windZ: bits(g.windZ), worldSize: sim.world.worldSize,
    height: fnv(g.height), slope: fnv(g.slope), waterKind: fnv(g.waterKind), waterLevel: fnv(g.waterLevel), waterDist: fnv(g.waterDist), seaDist: fnv(g.seaDist),
    receiver: fnv(g.receiver), upstreamOrder: fnv(g.upstreamOrder), meanDischarge: fnv(g.meanDischarge), lakeId: fnv(g.lakeId), tMean: fnv(g.tMean), tAmp: fnv(g.tAmp),
    precip: fnv(g.precip), soil: fnv(g.soil), fertility: fnv(g.fertility), deposit: fnv(g.deposit), depositRichness: fnv(g.depositRichness), province: fnv(g.province),
    terrain: fnv(g.terrain.heights), terrainSamples: g.terrain.samples, horizon: fnv(g.horizon.heights), horizonSamples: g.horizon.samples, horizonSpacing: g.horizon.spacing,
    capacity: fnv(sim.world.derived.capacity), pFactor: fnv(sim.world.derived.pFactor), drainHour: fnv(sim.world.derived.drainHour),
  };
}

function arrays(sim: Simulation): Record<string, string> {
  const f = sim.world.flora;
  const e = sim.world.env;
  const b = f.biome;
  return {
    slotSpecies: fnv(f.slotSpecies), slotBiomass: fnv(f.slotBiomass), seedBank: fnv(f.seedBank), nutrient: fnv(f.nutrient), litterFast: fnv(f.litterFast),
    litterFastN: fnv(f.litterFastN), litterFastQ: fnv(f.litterFastQ), dayT: fnv(f.dayT), dayW: fnv(f.dayW), greenness: fnv(e.greenness), moisture: fnv(e.moisture),
    'biome.herb': fnv(b.herb), 'biome.steppe': fnv(b.steppe), 'biome.wet': fnv(b.wet), 'biome.pioneer': fnv(b.pioneer), 'biome.current': fnv(b.current),
  };
}

/** Сводка трав (C# пересчитывает те же суммы в том же порядке и сверяет побитно). */
function herbs(sim: Simulation, sourceColumns: number) {
  const f = sim.world.flora;
  const geo = sim.world.geo;
  const n = geo.n;
  const count = n * n;
  const H = SPECIES.herbs.length;
  const biomass = new Array<number>(H).fill(0);
  const slots = new Array<number>(H).fill(0);
  const bank = new Array<number>(H).fill(0);
  let occupied = 0;
  let newCells = 0;
  let frontier = -1;
  let green = 0;
  let litter = 0;
  for (let c = 0; c < count; c++) {
    let hb = 0;
    for (let k = 0; k < SLOTS; k++) {
      const s = f.slotSpecies[c * SLOTS + k]!;
      if (s === NO_SPECIES) continue;
      const b = f.slotBiomass[c * SLOTS + k]!;
      const h = SPECIES.herbSlot[s]!;
      biomass[h] = biomass[h]! + b;
      slots[h] = slots[h]! + 1;
      hb += b;
    }
    green += sim.world.env.greenness[c]!;
    litter += f.litterFast[c]!;
    if (hb > 1) {
      occupied++;
      const x = c % n;
      if (x >= sourceColumns) newCells++;
      if (x > frontier) frontier = x;
    }
  }
  for (let h = 0; h < H; h++) for (let c = 0; c < count; c++) bank[h] = bank[h]! + f.seedBank[h * count + c]!;
  return { biomass: biomass.map(bits), slots, bank: bank.map(bits), occupied, newCells, frontier, green: bits(green), litter: bits(litter) };
}

function summary(sim: Simulation, sourceColumns: number) {
  const w = sim.world;
  const f = w.flora;
  const stock = nutrientStock(f, w.geo);
  const budget = nutrientBudget(f);
  const initial = f.ledger[Ledger.initialStock]!;
  return {
    tick: w.tick,
    yearFrac: bits(yearFraction(w.tick, w.config.daysPerSeason)),
    stateHash: sim.stateHash(),
    ledger: Array.from(f.ledger, bits),
    stock: bits(stock),
    budget: bits(budget),
    balanceError: bits(Math.abs(stock - initial - budget) / initial),
    biomeCounts: biomeCounts(w),
    herbs: herbs(sim, sourceColumns),
  };
}

function step(sim: Simulation): { ms: number; flora: boolean } {
  const flora = (sim.world.tick - 25) % 50 === 0;
  const t = performance.now();
  sim.step();
  return { ms: performance.now() - t, flora };
}

/** Прогон опыта: начальная сводка, (по запросу) хеш после каждой порции первых суток, сводки по суткам. */
function run(s: Setup, sourceColumns: number, portionHashes: boolean, arraysEvery: number) {
  const t0 = performance.now();
  const sim = create(s);
  applyFills(sim, s.fills);
  const initial = { ...summary(sim, sourceColumns), arrays: arrays(sim) };
  const start = sim.world.tick;
  const portions: string[] = [];
  const portionMs: number[] = [];
  const dayMs: number[] = [];
  const days: unknown[] = [];
  for (let d = 1; d <= s.days; d++) {
    let acc = 0;
    while (sim.world.tick < start + d * TICKS_PER_DAY) {
      const r = step(sim);
      acc += r.ms;
      if (!r.flora) continue;
      portionMs.push(r.ms);
      if (portionHashes && d === 1) portions.push(sim.stateHash());
    }
    dayMs.push(acc);
    const sum = summary(sim, sourceColumns);
    days.push({ day: d, ...sum, arrays: d === s.days || (arraysEvery > 0 && d % arraysEvery === 0) ? arrays(sim) : undefined });
    if (d % 100 === 0) console.log(`${s.name}: сутки ${d}/${s.days}, ${sum.stateHash}`);
  }
  const ms = performance.now() - t0;
  console.log(`${s.name}: ${s.days} сут. за ${(ms / 1000).toFixed(1)} с, порция ${stat(portionMs).mean.toFixed(3)} мс, сутки ${stat(dayMs).mean.toFixed(1)} мс`);
  return { setup: s, sourceColumns, geoHash: sim.world.geoHash, geo: s.plot ? geoPrint(sim) : undefined, initial, portions: portionHashes ? portions : undefined, days, timing: { ms, portionMs: stat(portionMs), dayMs: stat(dayMs) } };
}

const DAYS_YEAR = 20;
/** plantSourceStrip без древесных: банк всех трав во всех столбцах опушки, луг — во второй их половине. */
const strip = (columns: number): Fill[] => [
  { x0: 0, x1: columns, bank: { species: 'all', value: 1 } },
  { x0: columns >> 1, x1: columns, cycle: 40 },
];

const b1 = run({ name: 'B1', plot: WET, seed: 7, days: YEARS * DAYS_YEAR, fills: strip(4) }, 4, true, 20);
const b2 = run({ name: 'B2', plot: DRY, seed: 7, days: YEARS * DAYS_YEAR, fills: strip(4) }, 4, false, 20);

const P32 = { ...WET, n: 32 };
const unit: Setup[] = [
  // 1. Рост: один вид с малой биомассой при хороших условиях.
  { name: 'growth', plot: P32, seed: 7, days: DAYS_YEAR, fills: [{ x0: 0, x1: 32, slots: [['meadow-grass', 5]] }] },
  // 2. Конкуренция: плотный луг из всех трав (4 вида в ячейке, по 150 г/м²) без банка семян.
  { name: 'competition', plot: P32, seed: 7, days: DAYS_YEAR, fills: [{ x0: 0, x1: 32, cycle: 150 }] },
  // 3. Предел питания: бедная почва и малый запас; контроль — тот же травостой на богатой почве.
  { name: 'nutrient-poor', plot: { ...P32, fertility: 0 }, seed: 7, days: DAYS_YEAR, fills: [{ x0: 0, x1: 32, slots: [['fireweed', 20], ['meadow-grass', 20]], nutrient: 0.3 }] },
  { name: 'nutrient-rich', plot: P32, seed: 7, days: DAYS_YEAR, fills: [{ x0: 0, x1: 32, slots: [['fireweed', 20], ['meadow-grass', 20]] }] },
  // 4. Мороз: холодный климат — зимнее отмирание надземной части, зимующий запас.
  { name: 'frost', plot: { n: 32, tMean: 0, tAmp: 16, precip: 600 }, seed: 7, days: DAYS_YEAR, fills: [{ x0: 0, x1: 32, slots: [['meadow-grass', 200], ['bilberry', 200], ['moss', 150]] }] },
  // 4–5. Засуха и исчезновение (8 лет): влаголюбивая осока на сухом песке исчезает в опад, ковыль держится.
  { name: 'drought', plot: { ...DRY, n: 32 }, seed: 7, days: 8 * DAYS_YEAR, fills: [{ x0: 0, x1: 32, slots: [['sedge', 100], ['feather-grass', 100]] }] },
  // 7. Расселение у реки: луг у восточного берега, семена не попадают в воду, вынос учитывается.
  { name: 'dispersal', plot: { ...P32, riverColumns: 3 }, seed: 7, days: DAYS_YEAR, fills: [{ x0: 3, x1: 7, cycle: 60 }] },
  // 8. Прорастание: голая земля с банком семян всех трав.
  { name: 'germination', plot: P32, seed: 7, days: DAYS_YEAR, fills: [{ x0: 0, x1: 32, bank: { species: 'all', value: 0.5 } }] },
  // 9. Старение банка: семена осоки на сухом песке не прорастают и уходят в опад.
  { name: 'aging', plot: { ...DRY, n: 32 }, seed: 7, days: DAYS_YEAR, fills: [{ x0: 0, x1: 32, bank: { species: ['sedge'], value: 2 } }] },
];
const unitRuns = unit.map((s) => run(s, 0, false, 0));

// Нагрузка: созданные миры с лугом и банком всех трав на всей суше.
const full = (size: 'S' | 'M'): Setup => ({ name: `full-${size}`, size, seed: 42, days: 2, fills: [{ x0: 0, x1: 1 << 16, bank: { species: 'all', value: 1 }, cycle: 40 }] });
const loadRuns = [run(full('S'), 0, false, 0), run(full('M'), 0, false, 0)];

const out = {
  tool: 'unity-flora-g3b-golden',
  node: process.version,
  reference: '7b2fbabbc1',
  herbs: SPECIES.herbs.map((h) => PLANTS[h]!.id),
  years: YEARS,
  B1: b1,
  B2: b2,
  unit: unitRuns,
  load: loadRuns,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`G3 B → ${OUT}`);
