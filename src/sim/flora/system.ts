// Суточный шаг растительности (docs/PHASE3_PLAN.md, разделы 1–2), разнесённый по 24 часам:
// каждый игровой час обрабатывается 1/24 ячеек (строки z ≡ час mod 24) и 1/24 древесных (индекс ≡ час mod 24),
// поэтому каждая сущность обновляется ровно раз в сутки, а нагрузка не скапливается в одном такте.
// Полог пересчитывается в начале суток. Все темпы заданы «за игровой год» и умножаются на долю года.

import { clamp, smoothstep } from '../../shared/dmath';
import { counterRandom } from '../../shared/rng';
import { SEASONS_PER_YEAR, TICKS_PER_HOUR, yearFraction } from '../../shared/time';
import type { System } from '../core/scheduler';
import type { World } from '../core/world';
import { WaterKind } from '../worldgen/geo';
import { NO_SPECIES, SPECIES } from './species';
import { CANOPY_BOUNDS, CANOPY_LAYERS, Ledger, SLOTS } from './state';
import { lightResponse, moistureResponse, nutrientResponse, soilResponse, tempResponse } from './suitability';
import { Stage } from './woodyStore';

const SYS_WOODY_DEATH = 311;
/** Пропускание света одним сплошным ярусом полога. */
const LAYER_TRANSMISSION = 0.25;
/** Вклад голых ветвей лиственных зимой в затенение относительно облиственной кроны. */
const BARE_CROWN = 0.3;
/** Скорость разложения опада при оптимуме, год⁻¹: листья и травы, древесина. Разлагатели — константа (план фазы 3). */
const DECAY_FAST = 2.5;
const DECAY_WOOD = 0.18;
/** Оборот древесины (ветви, кора), год⁻¹. */
const WOOD_TURNOVER = 0.01;
/** Приход элемента питания из породы, г/м²·год: база + плодородие. */
const WEATHERING_BASE = 0.4;
const WEATHERING_FERTILITY = 1.6;
const PI = 3.141592653589793;

/** Высота древесного растения по аллометрии, м. */
export function woodyHeight(s: number, biomass: number): number {
  const half = SPECIES.halfBiomass[s]!;
  return SPECIES.maxHeight[s]! * (biomass / (biomass + half));
}

/** Радиус кроны, м. */
export function crownRadius(s: number, biomass: number): number {
  const half = SPECIES.halfBiomass[s]!;
  return SPECIES.maxCrown[s]! * Math.sqrt(biomass / (biomass + half));
}

function layerOf(height: number): number {
  return height < CANOPY_BOUNDS[0] ? 0 : height < CANOPY_BOUNDS[1] ? 1 : height < CANOPY_BOUNDS[2] ? 2 : 3;
}

/** Свет, доходящий до высоты h в ячейке: затеняют ярусы выше и частично свой. */
export function lightAt(world: World, cell: number, height: number): number {
  const canopy = world.flora.canopy;
  const layer = layerOf(height);
  let light = 1;
  for (let k = CANOPY_LAYERS - 1; k > layer; k--) light *= 1 - (1 - LAYER_TRANSMISSION) * canopy[cell * CANOPY_LAYERS + k]!;
  return light * (1 - 0.3 * canopy[cell * CANOPY_LAYERS + layer]!);
}

/** Свет у земли (для трав и всходов). */
export function groundLight(world: World, cell: number): number {
  const canopy = world.flora.canopy;
  let light = 1;
  for (let k = 0; k < CANOPY_LAYERS; k++) light *= 1 - (1 - LAYER_TRANSMISSION) * canopy[cell * CANOPY_LAYERS + k]!;
  return light;
}

/**
 * Полог по ячейкам из древесных: покрытие кронами по ярусам, деревьями, кустарниками, хвойными.
 * @param setGreenness пересчитать и покров для воды и рендера (при создании мира)
 */
export function refreshCover(world: World, setGreenness: boolean): void {
  const f = world.flora;
  const w = f.woody;
  const area = world.geo.cellSize * world.geo.cellSize;
  f.canopy.fill(0);
  f.treeCover.fill(0);
  f.shrubCover.fill(0);
  f.coniferCover.fill(0);
  for (let i = 0; i < w.highWater; i++) {
    if (w.alive[i] !== 1) continue;
    const s = w.species[i]!;
    const b = w.biomass[i]!;
    const r = crownRadius(s, b);
    const leafy = SPECIES.evergreen[s] === 1 ? 1 : BARE_CROWN + (1 - BARE_CROWN) * w.leaf[i]!;
    const cover = (PI * r * r * leafy) / area;
    const c = w.cell[i]!;
    const k = c * CANOPY_LAYERS + layerOf(woodyHeight(s, b));
    f.canopy[k] = Math.min(1, f.canopy[k]! + cover);
    if (SPECIES.tree[s] === 1) {
      f.treeCover[c] = Math.min(1, f.treeCover[c]! + cover);
      if (SPECIES.conifer[s] === 1) f.coniferCover[c] = Math.min(1, f.coniferCover[c]! + cover);
    } else f.shrubCover[c] = Math.min(1, f.shrubCover[c]! + cover);
  }
  if (setGreenness) {
    const n = world.geo.n;
    for (let c = 0; c < n * n; c++) if (world.geo.waterKind[c] === WaterKind.None) world.env.greenness[c] = greennessOf(world, c);
  }
}

/**
 * Живой зелёный покров ячейки 0..1 (для испарения и цвета рельефа): травы в активном состоянии и полог.
 * В холод травы в покое — побуревшая ветошь не испаряет и не зеленеет, вечнозелёные (мох) — зеленеют.
 */
export function greennessOf(world: World, cell: number): number {
  const f = world.flora;
  const activity = smoothstep(1, 8, f.dayT[cell]!);
  let herbs = 0;
  for (let k = 0; k < SLOTS; k++) {
    const s = f.slotSpecies[cell * SLOTS + k]!;
    if (s === NO_SPECIES) continue;
    herbs += f.slotBiomass[cell * SLOTS + k]! * (SPECIES.evergreen[s] === 1 ? 1 : activity);
  }
  return clamp(herbs / 400 + 0.9 * f.treeCover[cell]! + 0.6 * f.shrubCover[cell]!, 0, 1);
}

interface DayContext {
  /** Доля игрового года, приходящаяся на одни сутки. */
  dt: number;
  yearFrac: number;
  day: number;
  cellArea: number;
}

function processCell(world: World, c: number, ctx: DayContext): void {
  const f = world.flora;
  const geo = world.geo;
  const t = SPECIES;
  const hours = f.accHours[c]!;
  if (hours > 0) {
    f.dayT[c] = f.accT[c]! / hours;
    f.dayW[c] = f.accW[c]! / hours;
  }
  const T = f.dayT[c]!;
  const W = f.dayW[c]!;
  const runoff = f.accRunoff[c]!;
  f.accT[c] = 0;
  f.accW[c] = 0;
  f.accRunoff[c] = 0;
  f.accMinT[c] = 99;
  f.accHours[c] = 0;
  const dt = ctx.dt;
  const area = ctx.cellArea;
  const soil = geo.soil[c]!;
  const snow = world.env.snow[c]!;
  const light = groundLight(world, c);
  const ledger = f.ledger;

  // Травяной ярус.
  let total = 0;
  for (let k = 0; k < SLOTS; k++) total += f.slotBiomass[c * SLOTS + k]!;
  let litter = 0;
  let litterN = 0;
  for (let k = 0; k < SLOTS; k++) {
    const slot = c * SLOTS + k;
    const s = f.slotSpecies[slot]!;
    if (s === NO_SPECIES) continue;
    let b = f.slotBiomass[slot]!;
    const fT = tempResponse(t, s, T);
    const fW = moistureResponse(t, s, W);
    const fL = lightResponse(t, s, light);
    const fit = fT * fW * fL * soilResponse(t, s, soil);
    const nutrient = f.nutrient[c]!;
    const capacity = t.maxBiomass[s]! * Math.sqrt(fit);
    const crowd = capacity > 0 ? 1 - total / capacity : -1;
    let growth = snow > 5 || crowd <= 0 ? 0 : t.growth[s]! * dt * b * fit * nutrientResponse(t, s, nutrient) * crowd;
    // Рост невозможен без элемента питания: не больше половины доступного запаса за сутки.
    const needN = growth * t.nutrient[s]!;
    if (needN > 0.5 * nutrient) growth *= (0.5 * nutrient) / needN;
    let loss = t.mortality[s]! * dt * b;
    const cold = T < 2 || snow > 5;
    if (cold && t.dieback[s] === 1) loss += 0.35 * b;
    else if (cold && t.evergreen[s] === 0) loss += 0.1 * b;
    if (fit < 0.05 && T > 5) loss += 0.08 * b;
    if (loss > b) loss = b;
    const fix = t.fixes[s]! * dt * Math.min(1, b / (0.5 * t.maxBiomass[s]!));
    b += growth - loss;
    f.nutrient[c] = nutrient - growth * t.nutrient[s]! + fix;
    litter += loss;
    litterN += loss * t.nutrient[s]!;
    ledger[Ledger.photosynthesis]! += (growth * area) / 1000;
    ledger[Ledger.litterfall]! += (loss * area) / 1000;
    ledger[Ledger.fixation]! += fix * area;
    if (b < 0.5) {
      // Вид исчез из ячейки: остаток уходит в опад.
      litter += b;
      litterN += b * t.nutrient[s]!;
      ledger[Ledger.litterfall]! += (b * area) / 1000;
      b = 0;
      f.slotSpecies[slot] = NO_SPECIES;
    }
    f.slotBiomass[slot] = b;
  }
  f.litterFast[c] = f.litterFast[c]! + litter;
  f.litterFastN[c] = f.litterFastN[c]! + litterN;

  // Почва: выветривание, вымывание, разложение опада.
  const weathering = (WEATHERING_BASE + WEATHERING_FERTILITY * geo.fertility[c]!) * dt;
  let n = f.nutrient[c]! + weathering;
  ledger[Ledger.weathering]! += weathering * area;
  const cap = world.derived.capacity[c]!;
  const leach = n * Math.min(0.3, runoff / (cap * 3));
  n -= leach;
  ledger[Ledger.leaching]! += leach * area;
  const decomp = clamp((T + 3) / 18, 0, 1.4) * smoothstep(0.05, 0.35, W) * (1 - 0.5 * smoothstep(0.92, 1, W));
  const kFast = Math.min(0.9, DECAY_FAST * decomp * dt);
  const kWood = Math.min(0.9, DECAY_WOOD * decomp * dt);
  const lf = f.litterFast[c]! * kFast;
  const lfN = f.litterFastN[c]! * kFast;
  const lw = f.litterWood[c]! * kWood;
  const lwN = f.litterWoodN[c]! * kWood;
  f.litterFast[c] = f.litterFast[c]! - lf;
  f.litterFastN[c] = f.litterFastN[c]! - lfN;
  f.litterWood[c] = f.litterWood[c]! - lw;
  f.litterWoodN[c] = f.litterWoodN[c]! - lwN;
  n += lfN + lwN;
  ledger[Ledger.decomposition]! += ((lf + lw) * area) / 1000;
  f.nutrient[c] = n;
  world.env.greenness[c] = greennessOf(world, c);
}

function deposit(world: World, cell: number, massKg: number, s: number, wood: boolean): void {
  const f = world.flora;
  const perM2 = (massKg * 1000) / (world.geo.cellSize * world.geo.cellSize);
  const nutrient = perM2 * SPECIES.nutrient[s]!;
  if (wood) {
    f.litterWood[cell] = f.litterWood[cell]! + perM2;
    f.litterWoodN[cell] = f.litterWoodN[cell]! + nutrient;
  } else {
    f.litterFast[cell] = f.litterFast[cell]! + perM2;
    f.litterFastN[cell] = f.litterFastN[cell]! + nutrient;
  }
  f.ledger[Ledger.litterfall]! += massKg;
}

function processWoody(world: World, i: number, ctx: DayContext): void {
  const f = world.flora;
  const w = f.woody;
  const t = SPECIES;
  const s = w.species[i]!;
  const c = w.cell[i]!;
  const T = f.dayT[c]!;
  const W = f.dayW[c]!;
  const dt = ctx.dt;
  let b = w.biomass[i]!;
  const height = woodyHeight(s, b);

  // Фенология: лиственные распускаются в тепле весной и летом, сбрасывают листву осенью и в холод.
  let leaf = w.leaf[i]!;
  if (t.evergreen[s] === 1) leaf = 1;
  else {
    const autumn = ctx.yearFrac > 0.68;
    const target = !autumn && T > 6 ? 1 : autumn || T < 3 ? 0 : leaf;
    const next = leaf + clamp(target - leaf, -0.35, 0.35);
    if (next < leaf) {
      const dropped = t.leafFraction[s]! * b * (leaf - next);
      b -= dropped;
      deposit(world, c, dropped, s, false);
    }
    leaf = next;
  }

  const fT = tempResponse(t, s, T);
  const fW = moistureResponse(t, s, W);
  const fL = lightResponse(t, s, lightAt(world, c, height));
  const growing = leaf > 0.5 && T > 3;
  const vigor = fT * fW * fL * soilResponse(t, s, world.geo.soil[c]!);
  let growth = 0;
  if (growing) {
    // b^0,75 через корни: точные операции IEEE, одинаковые в любом движке.
    const rootB = Math.sqrt(b);
    growth = t.growth[s]! * rootB * Math.sqrt(rootB) * vigor * nutrientResponse(t, s, f.nutrient[c]!) * leaf * Math.max(0, 1 - b / t.maxBiomass[s]!) * dt;
    const area = ctx.cellArea;
    const needN = growth * 1000 * t.nutrient[s]!;
    const available = f.nutrient[c]! * area;
    if (needN > 0.3 * available) growth *= needN > 0 ? (0.3 * available) / needN : 0;
    f.nutrient[c] = f.nutrient[c]! - (growth * 1000 * t.nutrient[s]!) / area;
    f.ledger[Ledger.photosynthesis]! += growth;
    // Фиксация элемента питания (ольха): пропорционально кроне.
    const fix = t.fixes[s]! * dt * Math.min(1, b / t.halfBiomass[s]!);
    f.nutrient[c] = f.nutrient[c]! + fix;
    f.ledger[Ledger.fixation]! += fix * area;
  }
  // Оборот: хвоя у вечнозелёных обновляется за ~3 года, ветви и кора — понемногу.
  const turnover = WOOD_TURNOVER * b * dt;
  const needles = t.evergreen[s] === 1 ? (t.leafFraction[s]! * b * dt) / 3 : 0;
  b += growth - turnover - needles;
  deposit(world, c, turnover, s, true);
  if (needles > 0) deposit(world, c, needles, s, false);

  // Здоровье: в сезон роста тянется к бодрости; мороз ниже порога повреждает даже в покое.
  let health = w.health[i]!;
  if (growing) health += (vigor - 0.35) * 2.5 * dt;
  if (T < t.frostKill[s]!) health -= 0.3;
  health = clamp(health, 0, 1);
  w.stressW[i] = 0.9 * w.stressW[i]! + 0.1 * (1 - fW);
  w.stressL[i] = 0.9 * w.stressL[i]! + 0.1 * (1 - fL);
  const age = w.age[i]! + dt;
  w.age[i] = age;
  w.leaf[i] = leaf;
  w.health[i] = health;
  w.biomass[i] = b;
  const life = t.lifespanYears[s]!;
  w.stage[i] = woodyHeight(s, b) < 0.5 ? Stage.Seedling : age < t.maturityYears[s]! ? Stage.Sapling : age > 0.8 * life ? Stage.Old : Stage.Mature;

  // Смертность: фоновая, от плохого здоровья, от старости; случайность — от (seed, растение, сутки).
  const senescence = age > 0.8 * life ? (age / life - 0.8) * 2 : 0;
  const p = (t.mortality[s]! + 1.5 * (1 - health) * (1 - health) + senescence) * dt;
  if (b <= 0.001 || counterRandom(world.seed, SYS_WOODY_DEATH, w.idOf(i), ctx.day) < p) {
    // Погибшее растение целиком уходит в опад: листва — в быстрый, остальное — в древесный.
    const leafMass = t.leafFraction[s]! * leaf * Math.max(0, b);
    if (b > 0) {
      deposit(world, c, leafMass, s, false);
      deposit(world, c, b - leafMass, s, true);
    }
    w.remove(i);
  }
}

const ctx: DayContext = { dt: 0, yearFrac: 0, day: 0, cellArea: 64 };

export const floraSystem: System<World> = {
  name: 'flora.day',
  period: TICKS_PER_HOUR,
  run(world, tick) {
    const hour = Math.floor(tick / TICKS_PER_HOUR);
    const slice = hour % 24;
    const geo = world.geo;
    const f = world.flora;
    ctx.dt = 1 / (world.config.daysPerSeason * SEASONS_PER_YEAR);
    ctx.yearFrac = yearFraction(tick, world.config.daysPerSeason);
    ctx.day = Math.floor(hour / 24);
    ctx.cellArea = geo.cellSize * geo.cellSize;
    if (slice === 0) refreshCover(world, false);
    const n = geo.n;
    for (let z = slice; z < n; z += 24) {
      for (let x = 0; x < n; x++) {
        const c = z * n + x;
        if (geo.waterKind[c] === WaterKind.None) processCell(world, c, ctx);
      }
    }
    const w = f.woody;
    for (let i = slice; i < w.highWater; i += 24) if (w.alive[i] === 1) processWoody(world, i, ctx);
    f.lastSliceHour = hour;
  },
};
