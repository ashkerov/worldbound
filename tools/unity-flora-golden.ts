// Эталоны G0 и G1 переноса флоры (docs/UNITY_MIGRATION_STAGE2_PLAN.md, раздел 6.1) — с настоящего кода TS:
//  G0 — каталоги: записи PLANTS (как их прочитал загрузчик со схемой), таблица SPECIES, правила BIOMES, SHA-256 JSON;
//  G1 — чистые функции: отклики (suitability.ts), высота и крона, свет на высоте и у земли, правила и классификатор
//       биомов (все режимы), makeId/idKind/idGeneration/idIndex, mix32/hash4/counterRandom/Rng/seedFromString,
//       трассы WoodyStore (выделение, освобождение, стек LIFO, поколения 255 → 0, заполнение, restore),
//       createFlora на мире S/42 и nutrientStock/nutrientBudget на детерминированно заполненном состоянии.
// Вещественные числа — точными битами IEEE-754 (hex). Входы векторов тоже выгружаются битами: C# считает на тех же входах.
// Исключение: herbCapacity и herbShade в TS не экспортированы (модульные функции system.ts) — для них формула
// продублирована здесь построчно из system.ts поверх экспортированных nutrientResponse и SPECIES; полную проверку
// они получат в этапе 2.3 сценарием трав (G3 B).
// Использование: npx tsx tools/unity-flora-golden.ts [--out unity/WorldboundProto/Golden/flora-g0g1.json]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PLANTS, SPECIES, type SpeciesTable } from '../src/sim/flora/species';
import { BIOMES, classifyBiome, confirmsChange, ruleMatches, type BiomeInput, type BiomeRule } from '../src/sim/flora/biomes';
import { lightResponse, moistureResponse, nutrientResponse, soilResponse, suitability, tempResponse, trapezoid } from '../src/sim/flora/suitability';
import { crownRadius, groundLight, lightAt, woodyHeight } from '../src/sim/flora/system';
import { WoodyStore } from '../src/sim/flora/woodyStore';
import { createFlora, nutrientBudget, nutrientStock, herbBiomass, woodyCapacity, SLOTS } from '../src/sim/flora/state';
import { EntityKind, idGeneration, idIndex, idKind, makeId, MAX_INDEX } from '../src/shared/ids';
import { Rng, counterRandom, hash4, mix32, seedFromString } from '../src/shared/rng';
import { SOILS } from '../src/sim/env/soils';
import { generateWorld } from '../src/sim/worldgen/generate';
import { DEFAULT_CONFIG } from '../src/shared/worldConfig';
import { WaterKind } from '../src/sim/worldgen/geo';
import type { World } from '../src/sim/core/world';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/flora-g0g1.json');

const bits = (x: number): string => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString('hex');
};
const fbits = (x: number): string => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(x);
  return b.toString('hex');
};
const bn = (x: number | undefined) => (x === undefined ? null : bits(x));
function fnv(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}
function sha(path: string): string {
  const text = readFileSync(path).toString('latin1').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex');
}
const R = (system: number, key: number) => counterRandom(2024, system, key, 0);
const t0 = performance.now();

// ───────── G0: каталоги ─────────
const plants = PLANTS.map((p) => ({
  id: p.id,
  name: p.name,
  form: p.form,
  leafHabit: p.leafHabit,
  community: p.community ?? null,
  temperature: [p.temperature.min, p.temperature.optMin, p.temperature.optMax, p.temperature.max].map(bits),
  frostKill: bits(p.frostKill),
  moisture: [p.moisture.min, p.moisture.optMin, p.moisture.optMax, p.moisture.max].map(bits),
  shadeTolerance: bits(p.shadeTolerance),
  nutrientDemand: bits(p.nutrientDemand),
  growthRate: bits(p.growthRate),
  maxBiomass: bits(p.maxBiomass),
  halfBiomass: bn(p.halfBiomass),
  maxHeight: bn(p.maxHeight),
  maxCrownRadius: bn(p.maxCrownRadius),
  nutrientContent: bits(p.nutrientContent),
  leafFraction: bn(p.leafFraction),
  canopyTransmission: bn(p.canopyTransmission),
  maturityYears: bn(p.maturityYears),
  lifespanYears: bn(p.lifespanYears),
  baseMortality: bits(p.baseMortality),
  seedMass: bits(p.seedMass),
  fecundity: bn(p.fecundity),
  dispersalMean: bn(p.dispersal?.mean),
  dispersalMax: bn(p.dispersal?.max),
  establishment: bits(p.establishment),
  seedAllocation: bn(p.seedAllocation),
  seedBankYears: bn(p.seedBankYears),
  fixesNutrient: bn(p.fixesNutrient),
  litterQuality: bits(p.litterQuality),
  colonistWeight: bits(p.colonistWeight),
  soilPreference: p.soilPreference ? SOILS.filter((s) => p.soilPreference![s.id] !== undefined).map((s) => [s.id, bits(p.soilPreference![s.id]!)]) : null,
}));

const table: Record<string, unknown> = { count: SPECIES.count, herbs: SPECIES.herbs };
for (const [k, v] of Object.entries(SPECIES as unknown as Record<string, unknown>)) {
  if (v instanceof Float64Array) table[k] = Array.from(v, bits);
  else if (v instanceof Uint8Array || v instanceof Int16Array) table[k] = Array.from(v);
}

const RULE_FIELDS: (keyof BiomeRule)[] = ['treeCoverMin', 'treeCoverMax', 'shrubCoverMin', 'tallShareMin', 'tallShareMax', 'herbBiomassMin', 'herbBiomassMax', 'coniferShareMin', 'coniferShareMax', 'tMeanMin', 'tMeanMax', 'moistureMin', 'moistureMax', 'steppeShareMin', 'steppeShareMax', 'wetShareMin', 'pioneerShareMin'];
const biomes = BIOMES.map((b) => ({
  id: b.id,
  name: b.name,
  color: b.color,
  water: b.rule.water ? b.rule.water.map((w) => ({ river: 1, lake: 2, sea: 3 })[w]) : null,
  rule: Object.fromEntries(RULE_FIELDS.map((f) => [f, bn(b.rule[f] as number | undefined)])),
}));

// ───────── G1: чистые функции ─────────
const S = SPECIES as SpeciesTable;
const vec: Record<string, unknown> = {};

// Трапеция: случайные упорядоченные a ≤ b ≤ c ≤ d и значения около них, плюс сами точки и вырожденные трапеции.
{
  const args: string[][] = [];
  const out: string[] = [];
  for (let k = 0; k < 600; k++) {
    const pts = [R(1, k * 4), R(1, k * 4 + 1), R(1, k * 4 + 2), R(1, k * 4 + 3)].map((u) => -40 + 90 * u).sort((x, y) => x - y);
    if (k % 50 === 0) pts[2] = pts[1]!; // вырожденный оптимум
    const pick = Math.floor(R(2, k) * 6);
    const v = pick < 4 ? pts[pick]! : -50 + 110 * R(3, k);
    args.push([v, ...pts].map(bits));
    out.push(bits(trapezoid(v, pts[0]!, pts[1]!, pts[2]!, pts[3]!)));
  }
  vec.trapezoid = { args, out };
}

// Отклики по видам на сетках и на границах трапеций вида (± наименьший шаг).
const near = (x: number) => [x, x - 1e-12, x + 1e-12, x - 1e-6, x + 1e-6];
const temps: number[] = [];
for (let T = -40; T <= 50; T += 0.25) temps.push(T);
const moists: number[] = [];
for (let W = 0; W <= 2.2; W += 0.005) moists.push(W);
const lights: number[] = [];
for (let L = 0; L <= 1.0001; L += 0.005) lights.push(L);
const nutrients: number[] = [];
for (let N = 0; N <= 40; N += 0.125) nutrients.push(N);
const perSpecies: unknown[] = [];
for (let s = 0; s < S.count; s++) {
  const tIn = [...temps, ...[S.tMin[s]!, S.tOptMin[s]!, S.tOptMax[s]!, S.tMax[s]!, S.frostKill[s]!].flatMap(near)];
  const wIn = [...moists, ...[S.wMin[s]!, S.wOptMin[s]!, S.wOptMax[s]!, S.wMax[s]!, S.wMax[s]! + 1e-9].flatMap(near)];
  const lIn = [...lights, ...near(S.lightNeed[s]!)];
  const nIn = [...nutrients, ...near(S.nutrientHalf[s]!), 1e-300];
  const suit: string[][] = [];
  for (let k = 0; k < 300; k++) {
    const gt = -20 + 50 * R(10 + s, k * 6);
    const mr = 1.3 * R(10 + s, k * 6 + 1);
    const li = R(10 + s, k * 6 + 2);
    const nu = 25 * R(10 + s, k * 6 + 3);
    const so = Math.floor(R(10 + s, k * 6 + 4) * SOILS.length);
    suit.push([bits(gt), bits(mr), bits(li), bits(nu), String(so), bits(suitability(S, s, gt, mr, li, nu, so))]);
  }
  const woody = S.woody[s] === 1;
  const bIn = woody ? [0, 1e-9, 0.0005, 0.002, 0.01, 0.1, 1, 2, 10, 50, S.halfBiomass[s]!, S.maxBiomass[s]!, ...Array.from({ length: 120 }, (_, k) => S.maxBiomass[s]! * 1.2 * R(40 + s, k))] : [];
  // herbCapacity — формула system.ts (функция не экспортирована): maxBiomass · √(fit · (0,3 + 0,7 · nutrientResponse)).
  const cap: string[][] = [];
  if (!woody)
    for (let k = 0; k < 200; k++) {
      const fit = R(60 + s, k * 2);
      const nu = 30 * R(60 + s, k * 2 + 1);
      cap.push([bits(fit), bits(nu), bits(S.maxBiomass[s]! * Math.sqrt(fit * (0.3 + 0.7 * nutrientResponse(S, s, nu))))]);
    }
  perSpecies.push({
    s,
    temp: { in: tIn.map(bits), out: tIn.map((x) => bits(tempResponse(S, s, x))) },
    moisture: { in: wIn.map(bits), out: wIn.map((x) => bits(moistureResponse(S, s, x))) },
    light: { in: lIn.map(bits), out: lIn.map((x) => bits(lightResponse(S, s, x))) },
    nutrient: { in: nIn.map(bits), out: nIn.map((x) => bits(nutrientResponse(S, s, x))) },
    soil: SOILS.map((_, k) => bits(soilResponse(S, s, k))),
    suitability: suit,
    height: { in: bIn.map(bits), out: bIn.map((b) => bits(woodyHeight(s, b))) },
    crown: { in: bIn.map(bits), out: bIn.map((b) => bits(crownRadius(s, b))) },
    herbCapacity: cap,
  });
}
vec.species = perSpecies;

// Свет: полог из 4 ярусов (float32), высоты на границах ярусов и случайные.
{
  const heights = [0, 0.5, 1.999999, 2, 2.000001, 5.999999, 6, 6.000001, 14.999999, 15, 15.000001, 30];
  const cases: unknown[] = [];
  for (let k = 0; k < 400; k++) {
    const canopy = new Float32Array(4);
    for (let j = 0; j < 4; j++) canopy[j] = k % 7 === 0 && j === 1 ? 0 : 0.97 * R(80, k * 4 + j);
    const world = { flora: { canopy } } as unknown as World;
    const hs = [...heights, 40 * R(81, k)];
    cases.push({ canopy: Array.from(canopy, fbits), heights: hs.map(bits), lightAt: hs.map((h) => bits(lightAt(world, 0, h))), ground: bits(groundLight(world, 0)) });
  }
  vec.light = cases;
  // herbShade — формула system.ts (не экспортирована): 1 − 0,4 · min(1, травы / 400).
  const totals = [0, 1, 399.999, 400, 400.001, 1000, ...Array.from({ length: 100 }, (_, k) => 900 * R(82, k))];
  vec.herbShade = { in: totals.map(bits), out: totals.map((h) => bits(1 - 0.4 * Math.min(1, h / 400))) };
}

// Биомы: случайные показатели и показатели на порогах каждого правила (± запас), все режимы.
{
  const inputs: BiomeInput[] = [];
  const rnd = (k: number): BiomeInput => ({
    water: R(90, k * 12) < 0.85 ? 0 : 1 + Math.floor(R(90, k * 12 + 1) * 3),
    treeCover: R(90, k * 12 + 2),
    shrubCover: R(90, k * 12 + 3),
    tallShare: R(90, k * 12 + 4),
    herbBiomass: 600 * R(90, k * 12 + 5),
    coniferShare: R(90, k * 12 + 6),
    tMean: -10 + 30 * R(90, k * 12 + 7),
    moisture: 1.3 * R(90, k * 12 + 8),
    steppeShare: R(90, k * 12 + 9),
    wetShare: R(90, k * 12 + 10),
    pioneerShare: R(90, k * 12 + 11),
  });
  for (let k = 0; k < 3000; k++) inputs.push(rnd(k));
  const keyOf: Record<string, keyof BiomeInput> = { treeCover: 'treeCover', shrubCover: 'shrubCover', tallShare: 'tallShare', herbBiomass: 'herbBiomass', coniferShare: 'coniferShare', tMean: 'tMean', moisture: 'moisture', steppeShare: 'steppeShare', wetShare: 'wetShare', pioneerShare: 'pioneerShare' };
  let k = 10000;
  for (const b of BIOMES)
    for (const f of RULE_FIELDS) {
      const t = b.rule[f] as number | undefined;
      if (t === undefined) continue;
      const field = keyOf[f.replace(/(Min|Max)$/, '')]!;
      const abs = field === 'herbBiomass' ? 2 : field === 'tMean' ? 0.5 : 0.02;
      const m = Math.max(0.1 * Math.abs(t), abs);
      for (const v of [t, t - m, t + m, t - m - 1e-9, t + m + 1e-9, t - 1e-12, t + 1e-12]) {
        const c = rnd(k++);
        c.water = b.rule.water ? 1 : 0;
        (c as unknown as Record<string, number>)[field] = v;
        inputs.push(c);
      }
    }
  const enc = (c: BiomeInput) => [String(c.water), ...[c.treeCover, c.shrubCover, c.tallShare, c.herbBiomass, c.coniferShare, c.tMean, c.moisture, c.steppeShare, c.wetShare, c.pioneerShare].map(bits)];
  vec.biomes = inputs.map((c, i) => {
    // Совпадения: по биому — три режима (−1, 0, +1) строкой из 0/1.
    const matches = BIOMES.map((b) => [-1, 0, 1].map((m) => (ruleMatches(b.rule, c, m as -1 | 0 | 1) ? '1' : '0')).join('')).join(',');
    const cur = Math.floor(R(91, i * 2) * BIOMES.length);
    const next = Math.floor(R(91, i * 2 + 1) * BIOMES.length);
    return { in: enc(c), cls: classifyBiome(c), matches, cur, next, confirms: confirmsChange(cur, next, c) ? 1 : 0 };
  });
}

// Идентификаторы: все виды, граничные поколения (255 → 0 по маске, отрицательные), граничные индексы.
{
  const ids: unknown[] = [];
  const kinds = [0, 1, 2, 3, 4, 7, 15, 16, -1];
  const gens = [0, 1, 127, 128, 254, 255, 256, 257, 511, -1, -256];
  const idx = [0, 1, 2, 524287, 524288, MAX_INDEX - 1, MAX_INDEX];
  for (const kd of kinds) for (const g of gens) for (const i of idx) ids.push([kd, g, i, makeId(kd as EntityKind, g, i)]);
  const parts: unknown[] = [];
  for (let k = 0; k < 300; k++) {
    const id = Math.floor(R(95, k) * 4294967296);
    parts.push([id, idKind(id), idGeneration(id), idIndex(id)]);
  }
  vec.ids = { make: ids, parts, tree: EntityKind.Tree };
}

// Генераторы случайных чисел: mix32, hash4 (в т. ч. ключи > 2^31 и отрицательные), counterRandom на ключах флоры, sfc32, seed из строки.
{
  const u32 = (k: number) => Math.floor(R(100, k) * 4294967296);
  const mixes = Array.from({ length: 200 }, (_, k) => {
    const h = u32(k);
    return [h, mix32(h) >>> 0];
  });
  const h4: unknown[] = [];
  const special = [0, 1, -1, 2147483647, -2147483648, 2147483648, 4294967295, 0x1fffffff, 0x10000000];
  for (let k = 0; k < 400; k++) {
    const a = k < special.length ? special[k]! : u32(k * 4 + 1000);
    const b = 311 + (k % 6);
    const c = k % 3 === 0 ? makeId(EntityKind.Tree, k % 256, k * 2621 % (MAX_INDEX + 1)) : k % 3 === 1 ? (k * 7919 % 262144) * 32 + (k % 18) : u32(k * 4 + 2000) - 2147483648;
    const d = (k * 64 + (k % 8) * 2 + 1) % 2000000;
    h4.push([a, b, c, d, hash4(a, b, c, d) >>> 0, bits(counterRandom(a, b, c, d))]);
  }
  const rngs = [[42, 0], [42, 101], [0, 0], [4294967295, 7], [1234, 0x51ed + 80]].map(([seed, stream]) => {
    const r = new Rng(seed!, stream!);
    return { seed, stream, u32: Array.from({ length: 40 }, () => r.nextU32()), next: Array.from({ length: 10 }, () => bits(r.next())), int: Array.from({ length: 10 }, () => r.int(1000)) };
  });
  const seeds = ['Новый мир', 'worldbound', '', 'Ёжик в тумане 42'].map((t) => [t, seedFromString(t)]);
  vec.rng = { mix32: mixes, hash4: h4, rng: rngs, seedFromString: seeds };
}

// ───────── WoodyStore: трассы ─────────
{
  const traces: unknown = (() => {
    // A: ёмкость 16, 600 операций (выделение 60 %, иначе освобождение случайного индекса, в т. ч. уже свободного).
    const w = new WoodyStore(16);
    const ops: unknown[] = [];
    for (let k = 0; k < 600; k++) {
      if (R(120, k) < 0.6) {
        const i = w.spawn(k % 18, 100 * R(121, k), 100 * R(122, k), k, 50 * R(123, k), 30 * R(124, k));
        ops.push(['s', k % 18, bits(100 * R(121, k)), bits(100 * R(122, k)), k, bits(50 * R(123, k)), bits(30 * R(124, k)), i, w.highWater, w.count, Array.from(w.freeSlots()).join(' '), i >= 0 ? w.idOf(i) : -1]);
      } else {
        const i = Math.floor(R(125, k) * 16);
        w.remove(i);
        ops.push(['r', i, w.highWater, w.count, Array.from(w.freeSlots()).join(' '), w.idOf(i)]);
      }
    }
    const columns = { x: fnv(w.x), z: fnv(w.z), species: fnv(w.species), age: fnv(w.age), biomass: fnv(w.biomass), leaf: fnv(w.leaf), health: fnv(w.health), stage: fnv(w.stage), stressW: fnv(w.stressW), stressL: fnv(w.stressL), cell: fnv(w.cell), alive: fnv(w.alive), generation: fnv(w.generation) };
    // B: переполнение поколения: один слот, 300 циклов «освободить → выделить» (255 → 0).
    const g = new WoodyStore(4);
    g.spawn(1, 0, 0, 0, 1, 0);
    const gens: number[] = [];
    for (let k = 0; k < 300; k++) {
      g.remove(0);
      const i = g.spawn(1, 0, 0, 0, 1, 0);
      gens.push(i, g.generation[0]!, g.idOf(0));
    }
    // C: заполнение: ёмкость 8 — девятое выделение даёт −1; освобождение 3, 5, 1 — выдача обратно 1, 5, 3 (LIFO).
    const f = new WoodyStore(8);
    const fill: number[] = [];
    for (let k = 0; k < 9; k++) fill.push(f.spawn(2, k, k, k, 1, 0));
    for (const i of [3, 5, 1]) f.remove(i);
    for (let k = 0; k < 4; k++) fill.push(f.spawn(3, 0, 0, 0, 1, 0));
    // D: restore: стек свободных из сохранения и порядок выдачи после него.
    const r = new WoodyStore(10);
    for (let k = 0; k < 10; k++) r.spawn(4, 0, 0, 0, 1, 0);
    for (const i of [2, 7, 4]) r.remove(i);
    const free = r.freeSlots();
    const r2 = new WoodyStore(10);
    r2.restore(r.highWater, r.count, free);
    const restored = [r2.highWater, r2.count, ...Array.from({ length: 4 }, () => r2.spawn(5, 0, 0, 0, 1, 0))];
    let restoreError = '';
    try {
      r2.restore(11, 0, []);
    } catch (e) {
      restoreError = String((e as Error).message);
    }
    return { a: { ops, columns, highWater: w.highWater, count: w.count }, b: gens, c: fill, d: { free: Array.from(free), restored, restoreError } };
  })();
  vec.woodyStore = traces;
}

// ───────── FloraState: createFlora на мире S/42 и запас вещества на заполненном состоянии ─────────
const tGen = performance.now();
const { geo } = generateWorld({ ...DEFAULT_CONFIG, seed: 42, size: 'S' });
const genMs = performance.now() - tGen;
const tCreate = performance.now();
const flora = createFlora(geo);
const createMs = performance.now() - tCreate;
const arraysOf = (f: typeof flora) => ({
  slotSpecies: fnv(f.slotSpecies), slotBiomass: fnv(f.slotBiomass), litterFast: fnv(f.litterFast), litterFastN: fnv(f.litterFastN), litterFastQ: fnv(f.litterFastQ),
  litterWood: fnv(f.litterWood), litterWoodN: fnv(f.litterWoodN), nutrient: fnv(f.nutrient), accT: fnv(f.accT), accW: fnv(f.accW), accRunoff: fnv(f.accRunoff),
  accMinT: fnv(f.accMinT), accHours: fnv(f.accHours), dayT: fnv(f.dayT), dayW: fnv(f.dayW), capillary: fnv(f.capillary), seedBank: fnv(f.seedBank),
  woodyCount: fnv(f.woodyCount), canopy: fnv(f.canopy), treeCover: fnv(f.treeCover), shrubCover: fnv(f.shrubCover), coniferCover: fnv(f.coniferCover),
  tallCover: fnv(f.tallCover), colonistMass: fnv(f.colonistMass), colonistFirst: fnv(f.colonistFirst), ledger: fnv(f.ledger),
  biome: [f.biome.herb, f.biome.steppe, f.biome.wet, f.biome.pioneer, f.biome.moisture, f.biome.tree, f.biome.shrub, f.biome.conifer, f.biome.tall, f.biome.current, f.biome.candidate, f.biome.days].map(fnv),
  woody: [f.woody.x, f.woody.z, f.woody.species, f.woody.age, f.woody.biomass, f.woody.leaf, f.woody.health, f.woody.stage, f.woody.stressW, f.woody.stressL, f.woody.cell, f.woody.alive, f.woody.generation].map(fnv),
});
const created = { arrays: arraysOf(flora), capacity: woodyCapacity(geo), woodyCapacityField: flora.woody.capacity, lastSliceHour: flora.lastSliceHour, preparedYears: flora.preparedYears, regionalSeedRain: flora.regionalSeedRain, stock: bits(nutrientStock(flora, geo)), budget: bits(nutrientBudget(flora)) };

// Детерминированное заполнение (тот же алгоритм повторён в C#-проверке): травы, банк семян, опад, питание, древесные, ведомость.
const tFill = performance.now();
{
  const n = geo.n;
  const count = n * n;
  const F = (sys: number, k: number) => counterRandom(77, sys, k, 0);
  const herbs = SPECIES.herbs;
  const land: number[] = [];
  for (let c = 0; c < count; c++) {
    if (geo.waterKind[c] !== WaterKind.None) continue;
    land.push(c);
    for (let k = 0; k < SLOTS; k++) {
      if (F(1, c * 4 + k) < 0.45) {
        flora.slotSpecies[c * SLOTS + k] = herbs[Math.floor(F(2, c * 4 + k) * herbs.length)]!;
        flora.slotBiomass[c * SLOTS + k] = F(3, c * 4 + k) * 500;
      }
    }
    flora.litterFastN[c] = F(4, c) * 3;
    flora.litterWoodN[c] = F(5, c) * 2;
    flora.nutrient[c] = flora.nutrient[c]! + F(6, c);
    for (let h = 0; h < herbs.length; h++) if (F(7, c * 8 + h) < 0.2) flora.seedBank[h * count + c] = F(8, c * 8 + h) * 0.4;
  }
  const woodyList: number[] = [];
  for (let s = 0; s < SPECIES.count; s++) if (SPECIES.woody[s] === 1) woodyList.push(s);
  const w = flora.woody;
  for (let k = 0; k < 20000; k++) {
    const c = land[Math.floor(F(9, k) * land.length)]!;
    const s = woodyList[Math.floor(F(10, k) * woodyList.length)]!;
    const i = w.spawn(s, ((c % n) + F(11, k)) * geo.cellSize, (Math.floor(c / n) + F(12, k)) * geo.cellSize, c, F(13, k) * 300, F(14, k) * 80);
    if (F(15, k) < 0.1) w.remove(i);
  }
  for (let j = 0; j < 10; j++) flora.ledger[j] = F(16, j) * 1000;
}
const fillMs = performance.now() - tFill;
const tStock = performance.now();
const stock = nutrientStock(flora, geo);
const stockMs = performance.now() - tStock;
const herbSamples = [0, 1000, 33000, 65535].map((c) => bits(herbBiomass(flora, c)));
const filled = { arrays: arraysOf(flora), stock: bits(stock), budget: bits(nutrientBudget(flora)), herbBiomass: herbSamples, woodyCount: flora.woody.count, woodyHighWater: flora.woody.highWater, free: fnv(flora.woody.freeSlots()) };

// Микрозамер той же нагрузки, что в C#-проверке (FloraGolden.cs): 2 млн вызовов suitability и lightAt + woodyHeight.
const micro = (() => {
  const N = 2_000_000;
  let acc = 0;
  let t = performance.now();
  for (let k = 0; k < N; k++) acc += suitability(S, k % S.count, (k % 97) * 0.4 - 5, (k % 53) * 0.02, (k % 11) * 0.1, (k % 29) * 0.5, k % 6);
  const suitNs = ((performance.now() - t) * 1e6) / N;
  const world = { flora: { canopy: new Float32Array([0.1, 0.2, 0.3, 0.4]) } } as unknown as World;
  t = performance.now();
  for (let k = 0; k < N; k++) acc += lightAt(world, 0, (k % 40) * 0.5) + woodyHeight(12 + (k % 6), k % 500);
  const lightNs = ((performance.now() - t) * 1e6) / N;
  return { suitabilityNs: suitNs, lightAtPlusHeightNs: lightNs, checksum: acc };
})();

const out = {
  tool: 'unity-flora-golden',
  node: process.version,
  catalog: { plantsSha256: sha('content/plants/plants.json'), biomesSha256: sha('content/biomes/biomes.json'), plants, table, biomes, soils: SOILS.map((s) => s.id) },
  vectors: vec,
  floraState: { world: 'S:42:temperate', geoN: geo.n, created, filled },
  tsTiming: { totalMs: Math.round(performance.now() - t0), worldgenMs: Math.round(genMs), createFloraMs: createMs, fillMs, nutrientStockMs: stockMs, ...micro },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`G0/G1 → ${OUT}; видов ${SPECIES.count}, биомов ${BIOMES.length}, createFlora S ${createMs.toFixed(2)} мс, nutrientStock ${stockMs.toFixed(2)} мс`);
