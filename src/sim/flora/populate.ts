// Начальное состояние растительности (этап после генерации, в geoHash не входит):
//  • genesis — голая земля без растений и семян: жизнь приходит только извне (если мир не изолирован)
//    и от создателя;
//  • wild (Wildlands) — голая земля с почвенным банком семян; дальше мир готовится предварительным прогоном
//    той же симуляции (Simulation, подготовка ≈ 20 лет), леса не расставляются, а вырастают;
//  • миграция сохранения фазы 2 — травяной ярус из сохранённого индекса зелени, без древесных.

import type { World } from '../core/world';
import { WaterKind } from '../worldgen/geo';
import { climateMoisture } from '../env/envState';
import { timeContext } from '../env/climate';
import { NO_SPECIES, SPECIES } from './species';
import { Ledger, SLOTS, nutrientStock } from './state';
import { suitability } from './suitability';

/** Почвенный банк семян трав в начале подготовки Wildlands при пригодности 1 и весе колониста 1, г/м². */
const WILD_SEED_BANK = 0.3;

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

/**
 * Wildlands, начало подготовки: голая земля с почвенным банком семян трав региона (по пригодности и весу
 * колониста вида). Ни одного растения не ставится: травы прорастут из банка весной, деревья и кустарники
 * придут семенами региона во время предварительного прогона (FloraState.regionalSeedRain) и вырастут сами.
 */
export function populateWildlands(world: World): void {
  const geo = world.geo;
  const f = world.flora;
  const t = SPECIES;
  const count = geo.n * geo.n;
  for (let i = 0; i < count; i++) {
    if (geo.waterKind[i] !== WaterKind.None) continue;
    const moistureRel = climateMoisture(geo.precip[i]!);
    for (const s of t.herbs) {
      const suit = suitability(t, s, seasonTemp(world, i), moistureRel, 1, f.nutrient[i]!, geo.soil[i]!);
      if (suit < 0.05) continue;
      f.seedBank[t.herbSlot[s]! * count + i] = WILD_SEED_BANK * suit * t.colonist[s]!;
    }
  }
  f.regionalSeedRain = true;
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
