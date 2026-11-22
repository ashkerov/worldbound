// Эталон G3 переноса флоры (Stage 2.2): суточный цикл голой земли с настоящего TS `Simulation` (снимок 7b2fbabbc1).
// Сценарий A — Genesis, изолированный мир, S/42: растений, семян и притока нет; флора в расписании (период 50,
// фаза 25) ведёт суточные средние, сброс накопителей воды, почву (выветривание, вымывание, разложение), покров и биомы.
//  • первые 144 порции — после каждой: полный stateHash, FNV основных массивов, ведомость, число ячеек со сброшенными
//    накопителями;
//  • дальше — каждые сутки (каждые 144 порции) 20 игровых лет: stateHash, ведомость, запас, бюджет, ошибка баланса,
//    биомы, накопители, водный баланс;
//  • M/42 — 3 суток (хеш по суткам) и время;
//  • влияние покрова на испарение: тот же мир после 20 суток с флорой (покров суши 0) и без флоры (только погода и
//    вода, createEnv: покров 0,25) — водный баланс обоих.
// Использование: npx tsx tools/unity-flora-g3-golden.ts [--years 20] [--out unity/WorldboundProto/Golden/flora-g3.json]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { DEFAULT_CONFIG, type WorldConfig } from '../src/shared/worldConfig';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../src/shared/time';
import { WaterKind } from '../src/sim/worldgen/geo';
import { Ledger, nutrientBudget, nutrientStock } from '../src/sim/flora/state';
import { biomeCounts } from '../src/sim/flora/biomeState';
import { weatherSystem, WEATHER_PERIOD } from '../src/sim/env/weather';
import { waterSystem } from '../src/sim/env/water';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/flora-g3.json');
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

function arrays(sim: Simulation): Record<string, string> {
  const f = sim.world.flora;
  const e = sim.world.env;
  const b = f.biome;
  return {
    dayT: fnv(f.dayT), dayW: fnv(f.dayW), accT: fnv(f.accT), accW: fnv(f.accW), accRunoff: fnv(f.accRunoff), accMinT: fnv(f.accMinT), accHours: fnv(f.accHours),
    nutrient: fnv(f.nutrient), litterFast: fnv(f.litterFast), litterFastN: fnv(f.litterFastN), litterFastQ: fnv(f.litterFastQ), litterWood: fnv(f.litterWood),
    litterWoodN: fnv(f.litterWoodN), canopy: fnv(f.canopy), greenness: fnv(e.greenness), moisture: fnv(e.moisture), snow: fnv(e.snow), runoff: fnv(e.runoff),
    'biome.moisture': fnv(b.moisture), 'biome.current': fnv(b.current), 'biome.candidate': fnv(b.candidate), 'biome.days': fnv(b.days), 'biome.herb': fnv(b.herb),
  };
}

/** Сводки состояния, которые C# пересчитывает сам и сверяет. */
function summary(sim: Simulation) {
  const w = sim.world;
  const f = w.flora;
  const geo = w.geo;
  const count = geo.n * geo.n;
  let accZero = 0;
  let accHoursSum = 0;
  let greenNonZero = 0;
  for (let c = 0; c < count; c++) {
    if (geo.waterKind[c] !== WaterKind.None) continue;
    if (f.accHours[c] === 0) accZero++;
    accHoursSum += f.accHours[c]!;
    if (w.env.greenness[c] !== 0) greenNonZero++;
  }
  const stock = nutrientStock(f, geo);
  const budget = nutrientBudget(f);
  const initial = f.ledger[Ledger.initialStock]!;
  return {
    tick: w.tick,
    stateHash: sim.stateHash(),
    ledger: Array.from(f.ledger, bits),
    stock: bits(stock),
    budget: bits(budget),
    balanceError: bits(Math.abs(stock - initial - budget) / initial),
    biomeCounts: biomeCounts(w),
    landAccHoursZero: accZero,
    landAccHoursSum: accHoursSum,
    greennessLandNonZero: greenNonZero,
    lastSliceHour: f.lastSliceHour,
    waterTotals: Array.from(w.env.waterTotals, bits),
  };
}

const configOf = (seed: number, size: 'S' | 'M'): WorldConfig => ({ ...DEFAULT_CONFIG, seed, size, scenario: 'genesis', isolated: true });

/** Шаг такта с замером; возвращает длительность и была ли в такте порция флоры. */
function step(sim: Simulation): { ms: number; flora: boolean } {
  const flora = (sim.world.tick - 25) % 50 === 0;
  const t = performance.now();
  sim.step();
  return { ms: performance.now() - t, flora };
}

// ───────── Сценарий A: Genesis, изоляция, S/42 ─────────
const a0 = performance.now();
const sim = new Simulation({ config: configOf(42, 'S'), testAgents: 0 });
const initial = summary(sim);
const portions: unknown[] = [];
const portionMs: number[] = [];
const dayMs: number[] = [];
let done = 0;
let dayAcc = 0;
while (done < 144) {
  const r = step(sim);
  dayAcc += r.ms;
  if (!r.flora) continue;
  portionMs.push(r.ms);
  done++;
  const s = summary(sim);
  portions.push({ portion: done, tick: s.tick, stateHash: s.stateHash, arrays: arrays(sim), ledger: s.ledger, landAccHoursZero: s.landAccHoursZero, landAccHoursSum: s.landAccHoursSum, lastSliceHour: s.lastSliceHour });
}
// Дальше — сутки за сутками: каждые 144 порции (7200 тактов от старта).
const days: unknown[] = [];
const totalDays = Math.round(YEARS * DEFAULT_CONFIG.daysPerSeason * 4);
// Первые сутки уже пройдены (144 порции) — но граница суток считается по тактам от старта.
const startTick = initial.tick;
let evap20: unknown = null;
for (let d = 1; d <= totalDays; d++) {
  const target = startTick + d * TICKS_PER_DAY;
  while (sim.world.tick < target) {
    const r = step(sim);
    dayAcc += r.ms;
    if (r.flora && d > 1) portionMs.push(r.ms);
  }
  dayMs.push(dayAcc);
  dayAcc = 0;
  const s = summary(sim);
  days.push({ day: d, ...s, arrays: d <= 3 || d % 20 === 0 ? arrays(sim) : undefined });
  if (d === 20) evap20 = { waterTotals: s.waterTotals };
  if (d % 40 === 0) console.log(`A: сутки ${d}/${totalDays}, ${s.stateHash}, ошибка баланса ${Math.abs(nutrientStock(sim.world.flora, sim.world.geo) - sim.world.flora.ledger[Ledger.initialStock]! - nutrientBudget(sim.world.flora)) / sim.world.flora.ledger[Ledger.initialStock]!}`);
}
const aMs = performance.now() - a0;

// ───────── Влияние покрова на испарение: тот же мир без флоры (только погода и вода, покров createEnv = 0,25) ─────────
const bare = new Simulation({ config: configOf(42, 'S'), testAgents: 0, populate: false });
for (let t = 0; t < 20 * TICKS_PER_DAY; t++) {
  const tick = bare.world.tick;
  if (tick % WEATHER_PERIOD === 0) weatherSystem.run(bare.world, tick);
  if (tick % TICKS_PER_HOUR === 0) waterSystem.run(bare.world, tick);
  bare.world.tick++;
}
const noFlora = { waterTotals: Array.from(bare.world.env.waterTotals, bits), greennessLand: 0.25 };

// ───────── M/42: 3 суток ─────────
const simM = new Simulation({ config: configOf(42, 'M'), testAgents: 0 });
const initialM = summary(simM);
const daysM: unknown[] = [];
const portionMsM: number[] = [];
const dayMsM: number[] = [];
for (let d = 1; d <= 3; d++) {
  let acc = 0;
  while (simM.world.tick < initialM.tick + d * TICKS_PER_DAY) {
    const r = step(simM);
    acc += r.ms;
    if (r.flora) portionMsM.push(r.ms);
  }
  dayMsM.push(acc);
  daysM.push({ day: d, ...summary(simM), arrays: arrays(simM) });
}

const out = {
  tool: 'unity-flora-g3-golden',
  node: process.version,
  reference: '7b2fbabbc1',
  scenarioA: { seed: 42, size: 'S', scenario: 'genesis', isolated: true, daysPerSeason: DEFAULT_CONFIG.daysPerSeason, years: YEARS, initial, portions, days, evaporation: { withFlora20Days: evap20, withoutFlora20Days: noFlora } },
  scenarioM: { seed: 42, size: 'M', scenario: 'genesis', isolated: true, initial: initialM, days: daysM },
  tsTiming: { scenarioAms: aMs, portionMsS: stat(portionMs), dayMsS: stat(dayMs), portionMsM: stat(portionMsM), dayMsM: stat(dayMsM) },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`G3 → ${OUT}: A ${totalDays} сут. за ${(aMs / 1000).toFixed(1)} с; порция S ${stat(portionMs).mean.toFixed(3)} мс, сутки S ${stat(dayMs).mean.toFixed(1)} мс; сутки M ${stat(dayMsM).mean.toFixed(1)} мс`);
