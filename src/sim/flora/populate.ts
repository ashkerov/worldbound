// Начальное заселение мира растениями (этап после генерации, в geoHash не входит):
//  • genesis — голая земля: жизнь приходит только извне и от создателя;
//  • wild — [Предварительно] травяной покров и редкий подрост по пригодности условий; леса не рисуются,
//    а вырастают симуляцией (docs/PHASE3_PLAN.md, раздел 9, вопрос 1);
//  • миграция сохранения фазы 2 — травяной ярус из сохранённого индекса зелени, без древесных.

import { counterRandom } from '../../shared/rng';
import type { World } from '../core/world';
import { WaterKind } from '../worldgen/geo';
import { climateMoisture } from '../env/envState';
import { timeContext } from '../env/climate';
import { NO_SPECIES, SPECIES } from './species';
import { Ledger, SLOTS, nutrientStock } from './state';
import { suitability } from './suitability';

const SYS_POPULATE = 301;

/** Температура вегетационного сезона ячейки: середина между средней и летней нормой. */
export function seasonTemp(world: World, cell: number): number {
  return world.geo.tMean[cell]! + 0.6 * world.geo.tAmp[cell]!;
}

function bestHerbs(world: World, cell: number, moistureRel: number): { s: number; suit: number }[] {
  const t = SPECIES;
  const out: { s: number; suit: number }[] = [];
  for (let s = 0; s < t.count; s++) {
    if (t.woody[s] === 1) continue;
    const suit = suitability(t, s, seasonTemp(world, cell), moistureRel, 1, world.flora.nutrient[cell]!, world.geo.soil[cell]!);
    if (suit > 0.15) out.push({ s, suit });
  }
  // Ранжирование по возможной продуктивности: теневыносливый мох пригоден и на открытом лугу,
  // но проигрывает там травам, которые набирают больше биомассы.
  const score = (p: { s: number; suit: number }) => p.suit * t.maxBiomass[p.s]! * Math.sqrt(t.growth[p.s]!);
  out.sort((a, b) => score(b) - score(a) || a.s - b.s);
  return out.slice(0, 2);
}

function setHerbs(world: World, cell: number, picks: { s: number; suit: number }[], scale: number): void {
  const f = world.flora;
  for (let k = 0; k < SLOTS; k++) {
    f.slotSpecies[cell * SLOTS + k] = NO_SPECIES;
    f.slotBiomass[cell * SLOTS + k] = 0;
  }
  picks.forEach((p, k) => {
    const share = k === 0 ? 0.65 : 0.35;
    const b = scale * share * p.suit * SPECIES.maxBiomass[p.s]!;
    if (b < 1) return;
    f.slotSpecies[cell * SLOTS + k] = p.s;
    f.slotBiomass[cell * SLOTS + k] = b;
    // Сложившийся травостой имеет и почвенный банк своих семян.
    f.seedBank[SPECIES.herbSlot[p.s]! * world.geo.n * world.geo.n + cell] = 0.02 * b;
  });
}

function finish(world: World): void {
  // Суточные средние до первых суток — по климату момента старта и текущей влаге.
  const geo = world.geo;
  const ctx = timeContext(world.seed, world.tick, world.config.daysPerSeason);
  for (let i = 0; i < geo.n * geo.n; i++) {
    world.flora.dayT[i] = geo.tMean[i]! + geo.tAmp[i]! * ctx.seasonal + ctx.anomaly;
    world.flora.dayW[i] = world.env.moisture[i]! / world.derived.capacity[i]!;
  }
  world.flora.ledger.fill(0);
  world.flora.ledger[Ledger.initialStock] = nutrientStock(world.flora, world.geo);
}

export function populateGenesis(world: World): void {
  finish(world);
}

export function populateWild(world: World): void {
  const geo = world.geo;
  const f = world.flora;
  const t = SPECIES;
  const count = geo.n * geo.n;
  const woodySpecies: number[] = [];
  for (let s = 0; s < t.count; s++) if (t.woody[s] === 1) woodySpecies.push(s);
  for (let i = 0; i < count; i++) {
    if (geo.waterKind[i] !== WaterKind.None) continue;
    const moistureRel = climateMoisture(geo.precip[i]!);
    setHerbs(world, i, bestHerbs(world, i, moistureRel), 0.45);
    // Редкий подрост: вероятность пропорциональна лучшей пригодности древесного вида.
    let total = 0;
    let best = 0;
    const weights: number[] = [];
    for (const s of woodySpecies) {
      const suit = suitability(t, s, seasonTemp(world, i), moistureRel, 1, f.nutrient[i]!, geo.soil[i]!);
      const w = suit * t.colonist[s]!;
      weights.push(w);
      total += w;
      if (suit > best) best = suit;
    }
    if (total <= 0 || counterRandom(world.seed, SYS_POPULATE, i, 0) >= 0.03 * best) continue;
    let pick = counterRandom(world.seed, SYS_POPULATE, i, 1) * total;
    let k = 0;
    while (k < weights.length - 1 && pick >= weights[k]!) pick -= weights[k++]!;
    const s = woodySpecies[k]!;
    const x = ((i % geo.n) + counterRandom(world.seed, SYS_POPULATE, i, 2)) * geo.cellSize;
    const z = (Math.floor(i / geo.n) + counterRandom(world.seed, SYS_POPULATE, i, 3)) * geo.cellSize;
    const age = 1 + 5 * counterRandom(world.seed, SYS_POPULATE, i, 4);
    f.woody.spawn(s, x, z, i, 0.02 + 0.3 * age * age * 0.05, age);
    f.woodyCount[i] = f.woodyCount[i]! + 1;
  }
  finish(world);
}

/** Миграция сохранения фазы 2: индекс зелени (отклик покрова) превращается в травяной ярус подходящих видов. */
export function populateFromGreenness(world: World): void {
  const geo = world.geo;
  const count = geo.n * geo.n;
  for (let i = 0; i < count; i++) {
    if (geo.waterKind[i] !== WaterKind.None) continue;
    const moistureRel = world.env.moisture[i]! / world.derived.capacity[i]!;
    setHerbs(world, i, bestHerbs(world, i, moistureRel), Math.min(1, world.env.greenness[i]! * 0.9));
  }
  finish(world);
}
