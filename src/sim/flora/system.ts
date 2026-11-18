// Суточный шаг растительности (docs/PHASE3_PLAN.md, разделы 1–2), разнесённый на 144 порции в сутки
// (24 часа × 6 порций по 50 тактов, со сдвигом на полпорции от часового шага воды):
// ячейки — строки z ≡ час (mod 24), в каждой порции свой отрезок столбцов; древесные — индекс ≡ час + 24·порция
// (mod 144); край мира для колонизации — позиция ≡ час + 24·порция (mod 144). Каждая ячейка, растение и позиция
// края обновляются ровно раз в сутки, нагрузка не скапливается в одном такте.
// Полог пересчитывается в начале суток (порция 0). Все темпы заданы «за игровой год» и умножаются на долю года.
//
// Этап 3: размножение и расселение. Травы вкладывают часть биомассы в семена (сезон плодоношения),
// семена разносятся по ядру расселения вида в почвенный банк, банк стареет, весной семена прорастают
// там, где есть место и условия. Древесные после репродуктивной зрелости раз в год дают семена,
// семена разлетаются по ядру вида, приживание — как вероятность от условий, света у земли, травостоя
// и тесноты; всход проходит все стадии роста. Каждый грамм семян и всходов учтён в ведомости.
//
// Этап 4: колонизация извне (семена приходят через край мира, если мир не изолирован), семена региона
// при подготовке Wildlands и динамический биом (flora/biomeState.ts).

import { TWO_PI, clamp, dcos, dsin, smoothstep } from '../../shared/dmath';
import { counterRandom } from '../../shared/rng';
import { SEASONS_PER_YEAR, TICKS_PER_HOUR, yearFraction } from '../../shared/time';
import type { System } from '../core/scheduler';
import type { World } from '../core/world';
import { WaterKind } from '../worldgen/geo';
import { EdgeKind } from '../worldgen/geo';
import { climateMoisture } from '../env/envState';
import { updateBiome } from './biomeState';
import { NO_SPECIES, SPECIES } from './species';
import { CANOPY_BOUNDS, CANOPY_LAYERS, Ledger, MAX_WOODY_PER_CELL, SLOTS } from './state';
import { lightResponse, moistureResponse, nutrientResponse, soilResponse, suitability, tempResponse } from './suitability';
import { Stage } from './woodyStore';

const SYS_WOODY_DEATH = 311;
const SYS_HERB_SEED = 312;
const SYS_WOODY_SEED = 313;
const SYS_COLONIZE = 314;
const SYS_SEED_RAIN = 315;
/** Вклад голых ветвей лиственных зимой в затенение относительно облиственной кроны. */
const BARE_CROWN = 0.3;
/** Скорость разложения опада при оптимуме, год⁻¹: листья и травы (умножается на качество опада вида), древесина. */
const DECAY_FAST = 2.5;
const DECAY_WOOD = 0.18;
/** Оборот древесины (ветви, кора), год⁻¹. */
const WOOD_TURNOVER = 0.01;
/** Приход элемента питания из породы, г/м²·год: база + плодородие. */
const WEATHERING_BASE = 0.4;
const WEATHERING_FERTILITY = 1.6;
const PI = 3.141592653589793;

/** Сезоны размножения (доли года; год начинается весной): плодоношение трав, прорастание, рассев древесных. */
export const HERB_SEED_SEASON = [0.4, 0.66] as const;
export const GERMINATION_SEASON = [0.02, 0.4] as const;
export const WOODY_SEED_FRACTION = 0.62;
/** Рассев древесных растянут на столько суток. */
const SEED_DAYS_SPREAD = 4;
/** Ниже этой биомассы (г/м², уровень единичных всходов) локальная популяция вида считается исчезнувшей. */
const HERB_EXTINCTION = 0.02;
/** Добавочные потери травы при полной нехватке света, год⁻¹. */
const SHADE_LOSS = 2;
/** Зимующий запас многолетних трав (корневища) — доля предельной биомассы вида. */
const ROOT_RESERVE = 0.1;
/** Банк семян меньше этого (г/м²) не прорастает. */
const MIN_GERMINATING_BANK = 0.002;
/** Пакетов семян от одного дерева в год: ограничивает стоимость расчёта, не число семян. */
const SEED_PACKETS = 8;
/** Доля семян, дающих всход при установленной вероятности приживания вида и идеальных условиях. */
const SEED_RECRUITMENT = 0.05;
/** Начальная биомасса всхода, кг: масса семени плюс первый прирост (углерод из воздуха, питание из почвы ячейки). */
export const SEEDLING_BIOMASS = 0.002;
/** Добавочная смертность всходов ниже 0,5 м, год⁻¹. */
const SEEDLING_MORTALITY = 0.35;
/** Высота, с которой дерево входит в «высокий» полог (сложившийся лес), м. */
export const TALL_TREE = 6;

// Колонизация извне (docs/PHASE3_PLAN.md, раздел 14.3). За краем мира — такой же ландшафт, как у края внутри:
// вид встречается там тем обильнее, чем больше его вес колониста и пригодность места, куда падают семена.
// Семена летят через край по ядру расселения вида; дальше — те же банк семян, прорастание и приживание.
// Через морской край семена не приходят.
/** Семян трав за сезон плодоношения на 8 м края при весе колониста 1 и пригодности 1, г на м² ячейки-приёмника. */
export const COLONIST_HERB_SEEDS = 0.4;
/** Вероятность за год, что на 8 м края прилетит пакет семян древесного вида (вес 1, пригодность 1). */
export const COLONIST_WOODY_PACKET = 0.25;
/** Пакет колониста-древесного — семена с такой площади кроны региона, м²: число семян по плодовитости вида. */
const COLONIST_WOODY_CROWN = 2;
/** Пригодность места ниже этой — семена колонистов туда не приходят (вида нет в таком ландшафте за краем). */
const COLONIST_MIN_SUIT = 0.05;
// Подготовка Wildlands: семена приходят из окружающего региона на всю сушу (не только через край).
// Те же величины на ячейку за год, что и у края, но меньше: регион — фон, а не опушка.
export const RAIN_HERB_SEEDS = 0.15;
export const RAIN_WOODY_PACKET = 1.0;

/**
 * Высота древесного растения по аллометрии, м: H = Hmax·√(B/(B + B½)).
 * Корень даёт правдоподобные малые размеры: всход 2 г ≈ 8 см, саженец 2 кг ≈ 2,5 м (берёза).
 */
export function woodyHeight(s: number, biomass: number): number {
  const half = SPECIES.halfBiomass[s]!;
  return SPECIES.maxHeight[s]! * Math.sqrt(biomass / (biomass + half));
}

/** Радиус кроны, м. */
export function crownRadius(s: number, biomass: number): number {
  const half = SPECIES.halfBiomass[s]!;
  return SPECIES.maxCrown[s]! * Math.sqrt(biomass / (biomass + half));
}

function layerOf(height: number): number {
  return height < CANOPY_BOUNDS[0] ? 0 : height < CANOPY_BOUNDS[1] ? 1 : height < CANOPY_BOUNDS[2] ? 2 : 3;
}

// canopy[ячейка × ярус] хранит затенение яруса 0..1: Σ покрытие кроной × (1 − пропускание кроны вида).

/** Свет, доходящий до высоты h в ячейке: затеняют ярусы выше и частично свой. */
export function lightAt(world: World, cell: number, height: number): number {
  const canopy = world.flora.canopy;
  const layer = layerOf(height);
  let light = 1;
  for (let k = CANOPY_LAYERS - 1; k > layer; k--) light *= 1 - canopy[cell * CANOPY_LAYERS + k]!;
  return light * (1 - 0.3 * canopy[cell * CANOPY_LAYERS + layer]!);
}

/** Свет у земли (для трав и всходов). */
export function groundLight(world: World, cell: number): number {
  const canopy = world.flora.canopy;
  let light = 1;
  for (let k = 0; k < CANOPY_LAYERS; k++) light *= 1 - canopy[cell * CANOPY_LAYERS + k]!;
  return light;
}

/** Суммарная биомасса трав ячейки, г/м². */
function herbTotal(world: World, cell: number): number {
  let b = 0;
  for (let k = 0; k < SLOTS; k++) b += world.flora.slotBiomass[cell * SLOTS + k]!;
  return b;
}

/** Травостой затеняет низкие всходы древесных: доля света, проходящая сквозь траву. */
function herbShade(world: World, cell: number): number {
  return 1 - 0.4 * Math.min(1, herbTotal(world, cell) / 400);
}

/**
 * Полог по ячейкам из древесных: покрытие кронами по ярусам, деревьями, кустарниками, хвойными; число древесных.
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
  f.tallCover.fill(0);
  f.woodyCount.fill(0);
  for (let i = 0; i < w.highWater; i++) {
    if (w.alive[i] !== 1) continue;
    const s = w.species[i]!;
    const b = w.biomass[i]!;
    const r = crownRadius(s, b);
    const leafy = SPECIES.evergreen[s] === 1 ? 1 : BARE_CROWN + (1 - BARE_CROWN) * w.leaf[i]!;
    const cover = (PI * r * r * leafy) / area;
    const c = w.cell[i]!;
    if (f.woodyCount[c]! < 255) f.woodyCount[c] = f.woodyCount[c]! + 1;
    const h = woodyHeight(s, b);
    const k = c * CANOPY_LAYERS + layerOf(h);
    f.canopy[k] = Math.min(0.97, f.canopy[k]! + cover * (1 - SPECIES.transmission[s]!));
    if (SPECIES.tree[s] === 1) {
      f.treeCover[c] = Math.min(1, f.treeCover[c]! + cover);
      if (h >= TALL_TREE) f.tallCover[c] = Math.min(1, f.tallCover[c]! + cover);
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
  /** Номер суток внутри года. */
  dayOfYear: number;
  daysPerYear: number;
  day: number;
  cellArea: number;
  /** Сколько суток подряд новый биом должен держаться, чтобы сменить текущий (четверть года). */
  holdDays: number;
}

/** Опад в ячейку: масса г/м², элемент питания по виду, качество опада по виду. */
function addLitterFast(world: World, cell: number, perM2: number, s: number): void {
  const f = world.flora;
  f.litterFast[cell] = f.litterFast[cell]! + perM2;
  f.litterFastN[cell] = f.litterFastN[cell]! + perM2 * SPECIES.nutrient[s]!;
  f.litterFastQ[cell] = f.litterFastQ[cell]! + perM2 * SPECIES.litterQuality[s]!;
}

/** Ядро расселения: дальность d = min(max, 3·mean·u²) (среднее ≈ mean), направление равномерно. */
function dispersalTarget(world: World, x: number, z: number, s: number, key: number, salt: number, day: number, system: number): { x: number; z: number } {
  const u = counterRandom(world.seed, system, key, day * 64 + salt * 2);
  const v = counterRandom(world.seed, system, key, day * 64 + salt * 2 + 1);
  const d = Math.min(SPECIES.dispersalMax[s]!, 3 * SPECIES.dispersalMean[s]! * u * u);
  const a = TWO_PI * v;
  return { x: x + d * dcos(a), z: z + d * dsin(a) };
}

/** Индекс суши для точки или −1 (за границей мира или на воде). */
function landCellAt(world: World, x: number, z: number): number {
  const size = world.worldSize;
  if (!(x >= 0 && z >= 0 && x < size && z < size)) return -1;
  const n = world.geo.n;
  const c = Math.floor(z / world.geo.cellSize) * n + Math.floor(x / world.geo.cellSize);
  return world.geo.waterKind[c] === WaterKind.None ? c : -1;
}

const grow = new Float64Array(SLOTS);
const lose = new Float64Array(SLOTS);
const fix = new Float64Array(SLOTS);
const fitOf = new Float64Array(SLOTS);
const capOf = new Float64Array(SLOTS);

/**
 * Вместимость ячейки для вида травяного яруса, г/м²: предельная биомасса при условиях и доступном питании
 * (с учётом потребности вида). Требовательные первопроходцы выигрывают на свежей богатой земле и уступают,
 * когда питание вовлечено в оборот.
 */
function herbCapacity(s: number, fit: number, nutrient: number): number {
  return SPECIES.maxBiomass[s]! * Math.sqrt(fit * (0.3 + 0.7 * nutrientResponse(SPECIES, s, nutrient)));
}

/** Отклик вида на условия ячейки за сутки (без питания): температура × влага × свет × почва. */
function herbFit(world: World, s: number, c: number, light: number): number {
  const f = world.flora;
  return tempResponse(SPECIES, s, f.dayT[c]!) * moistureResponse(SPECIES, s, f.dayW[c]!) * lightResponse(SPECIES, s, light) * soilResponse(SPECIES, s, world.geo.soil[c]!);
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
  const snow = world.env.snow[c]!;
  const light = groundLight(world, c);
  const ledger = f.ledger;
  const cold = T < 2 || snow > 5;

  // ── Травяной ярус, проход 1: прирост и потери всех видов от одной и той же картины ячейки.
  let total = 0;
  for (let k = 0; k < SLOTS; k++) total += f.slotBiomass[c * SLOTS + k]!;
  const nutrient = f.nutrient[c]!;
  let sumGrow = 0;
  let sumLoss = 0;
  let needN = 0;
  let growCap = 0;
  for (let k = 0; k < SLOTS; k++) {
    grow[k] = 0;
    lose[k] = 0;
    fix[k] = 0;
    const slot = c * SLOTS + k;
    const s = f.slotSpecies[slot]!;
    if (s === NO_SPECIES) continue;
    const b = f.slotBiomass[slot]!;
    const fit = herbFit(world, s, c, light);
    const capacity = herbCapacity(s, fit, nutrient);
    fitOf[k] = fit;
    capOf[k] = capacity;
    const crowd = capacity > 0 ? 1 - total / capacity : -1;
    if (!cold && crowd > 0) {
      grow[k] = t.growth[s]! * dt * b * fit * nutrientResponse(t, s, nutrient) * crowd;
      if (capacity > growCap) growCap = capacity;
    }
    let loss = t.mortality[s]! * dt * b;
    // Зимой надземная часть отмирает, многолетник зимует корневищами (до 10 % предельной биомассы).
    const reserve = Math.min(b, ROOT_RESERVE * t.maxBiomass[s]!);
    if (cold && t.dieback[s] === 1) loss += Math.max(0, 0.35 * (b - reserve));
    // Листопадные кустарнички (черника) теряют на зиму только листья — стебли живут годами.
    else if (cold && t.evergreen[s] === 0) loss += Math.max(0, 0.02 * (b - reserve));
    if (fit < 0.05 && T > 5) loss += 0.08 * b;
    // Углеродный баланс в тени: виду, которому не хватает света, дыхание обходится дороже прироста —
    // светолюбивые угасают под пологом, теневыносливые держатся. Следует из потребности вида в свете.
    if (!cold) loss += SHADE_LOSS * (1 - lightResponse(t, s, light)) * dt * b;
    lose[k] = Math.min(b, loss);
    fix[k] = t.fixes[s]! * dt * Math.min(1, b / (0.5 * t.maxBiomass[s]!));
    sumGrow += grow[k]!;
    sumLoss += lose[k]!;
    needN += grow[k]! * t.nutrient[s]!;
  }
  // Проход 2: общие ограничения. Суммарный прирост не выводит ячейку за вместимость лучшего из растущих видов
  // (дискретный шаг логистического роста иначе перескакивает её), и на прирост уходит не больше половины запаса питания.
  let scale = 1;
  const room = growCap - (total - sumLoss);
  if (sumGrow > 0 && sumGrow > room) scale = room > 0 ? room / sumGrow : 0;
  if (needN * scale > 0.5 * nutrient) scale = needN > 0 ? Math.min(scale, (0.5 * nutrient) / needN) : 0;
  let pool = nutrient;
  for (let k = 0; k < SLOTS; k++) {
    const slot = c * SLOTS + k;
    const s = f.slotSpecies[slot]!;
    if (s === NO_SPECIES) continue;
    const g = grow[k]! * scale;
    const loss = lose[k]!;
    let b = f.slotBiomass[slot]! + g - loss;
    pool += fix[k]! - g * t.nutrient[s]!;
    addLitterFast(world, c, loss, s);
    ledger[Ledger.photosynthesis]! += (g * area) / 1000;
    ledger[Ledger.litterfall]! += (loss * area) / 1000;
    ledger[Ledger.fixation]! += fix[k]! * area;
    if (b < HERB_EXTINCTION) {
      // Локальная популяция исчезла: остаток уходит в опад.
      addLitterFast(world, c, b, s);
      ledger[Ledger.litterfall]! += (b * area) / 1000;
      b = 0;
      f.slotSpecies[slot] = NO_SPECIES;
    }
    f.slotBiomass[slot] = b;
  }
  f.nutrient[c] = pool;

  // ── Размножение трав: семена из биомассы в сезон плодоношения, разнос по ядру вида в банки семян.
  const yf = ctx.yearFrac;
  if (yf >= HERB_SEED_SEASON[0] && yf < HERB_SEED_SEASON[1] && !cold) {
    const seasonShare = dt / (HERB_SEED_SEASON[1] - HERB_SEED_SEASON[0]);
    for (let k = 0; k < SLOTS; k++) {
      const slot = c * SLOTS + k;
      const s = f.slotSpecies[slot]!;
      if (s === NO_SPECIES || fitOf[k]! < 0.2) continue;
      const b = f.slotBiomass[slot]!;
      if (b < 5) continue;
      const seeds = t.seedAlloc[s]! * seasonShare * b * fitOf[k]!;
      f.slotBiomass[slot] = b - seeds;
      disperseHerbSeeds(world, c, s, seeds, ctx);
    }
  }

  // ── Прорастание банка семян весной и в начале лета: там, где есть место (зазоры в травостое) и условия.
  if (yf >= GERMINATION_SEASON[0] && yf < GERMINATION_SEASON[1] && T > 6 && snow < 1) germinate(world, c, light, ctx);

  // ── Старение банка семян: невсхожие семена уходят в опад.
  const count = geo.n * geo.n;
  for (let h = 0; h < t.herbs.length; h++) {
    const o = h * count + c;
    const bank = f.seedBank[o]!;
    if (bank <= 0) continue;
    const s = t.herbs[h]!;
    const dead = bank * Math.min(1, dt / t.seedBankYears[s]!);
    f.seedBank[o] = bank - dead;
    addLitterFast(world, c, dead, s);
    ledger[Ledger.litterfall]! += (dead * area) / 1000;
  }

  // ── Почва: выветривание, вымывание, разложение опада (быстрый опад — со скоростью по качеству опада видов).
  const weathering = (WEATHERING_BASE + WEATHERING_FERTILITY * geo.fertility[c]!) * dt;
  let n = f.nutrient[c]! + weathering;
  ledger[Ledger.weathering]! += weathering * area;
  const capW = world.derived.capacity[c]!;
  const leach = n * Math.min(0.3, runoff / (capW * 3));
  n -= leach;
  ledger[Ledger.leaching]! += leach * area;
  const decomp = clamp((T + 3) / 18, 0, 1.4) * smoothstep(0.05, 0.35, W) * (1 - 0.5 * smoothstep(0.92, 1, W));
  const litterMass = f.litterFast[c]!;
  const quality = litterMass > 1e-6 ? clamp(f.litterFastQ[c]! / litterMass, 0.05, 5) : 1;
  const kFast = Math.min(0.9, DECAY_FAST * quality * decomp * dt);
  const kWood = Math.min(0.9, DECAY_WOOD * decomp * dt);
  const lf = litterMass * kFast;
  const lfN = f.litterFastN[c]! * kFast;
  const lw = f.litterWood[c]! * kWood;
  const lwN = f.litterWoodN[c]! * kWood;
  f.litterFast[c] = litterMass - lf;
  f.litterFastN[c] = f.litterFastN[c]! - lfN;
  f.litterFastQ[c] = f.litterFastQ[c]! * (1 - kFast);
  f.litterWood[c] = f.litterWood[c]! - lw;
  f.litterWoodN[c] = f.litterWoodN[c]! - lwN;
  n += lfN + lwN;
  ledger[Ledger.decomposition]! += ((lf + lw) * area) / 1000;
  f.nutrient[c] = n;
  if (f.regionalSeedRain) regionalSeedRain(world, c, cold, ctx);
  world.env.greenness[c] = greennessOf(world, c);
  updateBiome(world, c, dt, yf, ctx.holdDays);
}

/** Семена трав: доля остаётся в своей ячейке, остальные — двумя «пакетами» по ядру расселения вида. */
function disperseHerbSeeds(world: World, c: number, s: number, seeds: number, ctx: DayContext): void {
  const f = world.flora;
  const n = world.geo.n;
  const count = n * n;
  const h = SPECIES.herbSlot[s]!;
  const area = ctx.cellArea;
  const local = seeds * 0.5;
  f.seedBank[h * count + c] = f.seedBank[h * count + c]! + local;
  const x = ((c % n) + 0.5) * world.geo.cellSize;
  const z = (Math.floor(c / n) + 0.5) * world.geo.cellSize;
  for (let p = 0; p < 2; p++) {
    const packet = (seeds - local) / 2;
    const target = dispersalTarget(world, x, z, s, c * 32 + s, p, ctx.day, SYS_HERB_SEED);
    const tc = landCellAt(world, target.x, target.z);
    if (tc < 0) {
      // Унесено за пределы суши мира (за край или в воду): элемент питания уходит из учёта как вынос.
      f.ledger[Ledger.exported]! += packet * area * SPECIES.nutrient[s]!;
      continue;
    }
    f.seedBank[h * count + tc] = f.seedBank[h * count + tc]! + packet;
  }
}

/** Прорастание: вид в ячейке есть — пополняет свой слот; нет — занимает свободный слот, если для него есть зазор. */
function germinate(world: World, c: number, light: number, ctx: DayContext): void {
  const f = world.flora;
  const t = SPECIES;
  const count = world.geo.n * world.geo.n;
  let total = herbTotal(world, c);
  for (let h = 0; h < t.herbs.length; h++) {
    const o = h * count + c;
    const bank = f.seedBank[o]!;
    if (bank < MIN_GERMINATING_BANK) continue;
    const s = t.herbs[h]!;
    const fit = herbFit(world, s, c, light);
    if (fit < 0.15) continue;
    const capacity = herbCapacity(s, fit, f.nutrient[c]!);
    // Место для всходов — зазор в травостое: чем плотнее покров, тем меньше всходов.
    const gap = 1 - total / capacity;
    if (gap <= 0) continue;
    // Подстилка мешает прорасти мелким семенам сильнее, чем крупным (запас семени пробивает слой).
    const litterHalf = 80 * (1 + 400 * t.seedMass[s]!);
    const litter = 1 / (1 + f.litterFast[c]! / litterHalf);
    const amount = bank * Math.min(1, t.establishment[s]! * fit * gap * litter * ctx.dt * 6);
    let slot = -1;
    let free = -1;
    for (let k = 0; k < SLOTS; k++) {
      const sk = f.slotSpecies[c * SLOTS + k]!;
      if (sk === s) slot = c * SLOTS + k;
      else if (sk === NO_SPECIES && free < 0) free = c * SLOTS + k;
    }
    if (slot < 0) {
      if (free < 0) continue;
      slot = free;
      f.slotSpecies[slot] = s;
      f.slotBiomass[slot] = 0;
    }
    f.seedBank[o] = bank - amount;
    f.slotBiomass[slot] = f.slotBiomass[slot]! + amount;
    total += amount;
  }
}

function deposit(world: World, cell: number, massKg: number, s: number, wood: boolean): void {
  const f = world.flora;
  const perM2 = (massKg * 1000) / (world.geo.cellSize * world.geo.cellSize);
  if (wood) {
    f.litterWood[cell] = f.litterWood[cell]! + perM2;
    f.litterWoodN[cell] = f.litterWoodN[cell]! + perM2 * SPECIES.nutrient[s]!;
  } else addLitterFast(world, cell, perM2, s);
  f.ledger[Ledger.litterfall]! += massKg;
}

/** Пригодность ячейки для приживания всхода древесного вида: климат сезона роста, влага, свет у земли сквозь траву, почва. */
function seedlingFit(world: World, s: number, c: number): number {
  const f = world.flora;
  const geo = world.geo;
  const light = groundLight(world, c) * herbShade(world, c);
  return tempResponse(SPECIES, s, geo.tMean[c]! + 0.6 * geo.tAmp[c]!) * moistureResponse(SPECIES, s, f.dayW[c]!) * lightResponse(SPECIES, s, light) * soilResponse(SPECIES, s, geo.soil[c]!);
}

/** Семена дерева или кустарника: масса берётся из растения, разлёт пакетами, приживание всходов. */
function produceWoodySeeds(world: World, i: number, ctx: DayContext): void {
  const f = world.flora;
  const w = f.woody;
  const t = SPECIES;
  const s = w.species[i]!;
  const b = w.biomass[i]!;
  const r = crownRadius(s, b);
  let seeds = t.fecundity[s]! * PI * r * r * w.health[i]!;
  if (seeds < 1) return;
  // Не больше 5 % биомассы растения уходит в семена.
  const massKg = Math.min(seeds * t.seedMass[s]! * 0.001, 0.05 * b);
  seeds = massKg / (t.seedMass[s]! * 0.001);
  w.biomass[i] = b - massKg;
  const packets = Math.min(SEED_PACKETS, Math.ceil(seeds));
  const perPacket = seeds / packets;
  const packetKg = massKg / packets;
  const id = w.idOf(i);
  for (let p = 0; p < packets; p++) {
    const target = dispersalTarget(world, w.x[i]!, w.z[i]!, s, id, p, ctx.day, SYS_WOODY_SEED);
    const tc = landCellAt(world, target.x, target.z);
    if (tc < 0) {
      f.ledger[Ledger.exported]! += packetKg * 1000 * t.nutrient[s]!;
      continue;
    }
    landWoodyPacket(world, s, target.x, target.z, tc, perPacket, packetKg, counterRandom(world.seed, SYS_WOODY_SEED, id, ctx.day * 64 + 32 + p), ctx);
  }
}

/**
 * Пакет семян древесного вида упал в ячейку суши tc: возможно, одно семя даёт всход, остальное — в опад.
 * Общий путь для семян растений мира и колонистов извне. Вещество пакета уже учтено вызывающим
 * (взято из растения или записано как приход извне).
 * @param roll равномерное случайное [0, 1) — от (seed, источник, сутки)
 */
function landWoodyPacket(world: World, s: number, x: number, z: number, tc: number, seeds: number, packetKg: number, roll: number, ctx: DayContext): void {
  const f = world.flora;
  const w = f.woody;
  const t = SPECIES;
  const area = ctx.cellArea;
  // Вероятность, что хоть одно семя пакета приживётся: 1 − (1 − p)^n ≈ min(1, n·p) при малых p.
  const space = Math.max(0, 1 - f.woodyCount[tc]! / MAX_WOODY_PER_CELL);
  // У предела ёмкости хранилища (последние 10 %) приживание плавно стихает: нет обрыва по порядку обработки.
  const fill = w.count / w.capacity;
  const storeRoom = fill < 0.9 ? 1 : Math.max(0, (1 - fill) * 10);
  const pOne = t.establishment[s]! * seedlingFit(world, s, tc) * space * storeRoom * SEED_RECRUITMENT;
  const pAny = Math.min(1, seeds * pOne);
  const seedKg = t.seedMass[s]! * 0.001;
  const grownKg = Math.max(0, SEEDLING_BIOMASS - seedKg);
  const needN = grownKg * 1000 * t.nutrient[s]!;
  if (roll < pAny && f.woodyCount[tc]! < MAX_WOODY_PER_CELL && f.nutrient[tc]! * area > needN) {
    const j = w.spawn(s, x, z, tc, Math.max(SEEDLING_BIOMASS, seedKg), 0);
    if (j >= 0) {
      // Семя стало всходом; разница до массы всхода — первый прирост: питание из почвы ячейки.
      f.nutrient[tc] = f.nutrient[tc]! - needN / area;
      f.ledger[Ledger.photosynthesis]! += grownKg;
      f.woodyCount[tc] = f.woodyCount[tc]! + 1;
      deposit(world, tc, Math.max(0, packetKg - seedKg), s, false);
      return;
    }
  }
  // Не прижились (или хранилище заполнено): семена пакета уходят в опад там, куда упали.
  deposit(world, tc, packetKg, s, false);
}

/** Пригодность места для прихода колонистов вида: климат сезона роста, климатическая влага, питание, почва. */
function colonistSuit(world: World, s: number, c: number): number {
  const geo = world.geo;
  return suitability(SPECIES, s, geo.tMean[c]! + 0.6 * geo.tAmp[c]!, climateMoisture(geo.precip[c]!), 1, world.flora.nutrient[c]!, geo.soil[c]!);
}

function noteColonist(world: World, s: number, grams: number): void {
  const f = world.flora;
  f.colonistMass[s]! += grams;
  if (f.colonistFirst[s]! < 0) f.colonistFirst[s] = world.tick;
}

/** Семена трав пришли в банк ячейки извне: приход вещества — в ведомость. */
function addColonistHerbSeeds(world: World, c: number, s: number, perM2: number, ctx: DayContext): void {
  const f = world.flora;
  const count = world.geo.n * world.geo.n;
  const o = SPECIES.herbSlot[s]! * count + c;
  f.seedBank[o] = f.seedBank[o]! + perM2;
  f.ledger[Ledger.external]! += perM2 * ctx.cellArea * SPECIES.nutrient[s]!;
  noteColonist(world, s, perM2 * ctx.cellArea);
}

/** Пакет семян древесного вида пришёл извне в ячейку tc: приход — в ведомость, дальше обычное приживание. */
function addColonistWoodyPacket(world: World, s: number, x: number, z: number, tc: number, seeds: number, roll: number, ctx: DayContext): void {
  const packetKg = seeds * SPECIES.seedMass[s]! * 0.001;
  world.flora.ledger[Ledger.external]! += packetKg * 1000 * SPECIES.nutrient[s]!;
  noteColonist(world, s, packetKg * 1000);
  landWoodyPacket(world, s, x, z, tc, seeds, packetKg, roll, ctx);
}

/** День прихода древесных колонистов вида: тот же сезон рассева, что у растений мира, со сдвигом. */
function woodySeedDay(ctx: DayContext, k: number): number {
  return (Math.floor(WOODY_SEED_FRACTION * ctx.daysPerYear) + (k % SEED_DAYS_SPREAD)) % ctx.daysPerYear;
}

/**
 * Колонизация через одну позицию края мира (8 м края): для каждого вида — семена по ядру расселения вглубь мира.
 * @param k номер позиции: сторона × n + номер ячейки вдоль стороны (стороны: север, восток, юг, запад)
 */
function colonizeEdge(world: World, k: number, ctx: DayContext): void {
  const geo = world.geo;
  const n = geo.n;
  const side = Math.floor(k / n);
  if (geo.edges[side] === EdgeKind.Sea) return;
  const j = k - side * n;
  const cs = geo.cellSize;
  const size = world.worldSize;
  // Точка на краю и направление внутрь мира.
  const along = (j + 0.5) * cs;
  const ex = side === 1 ? size : side === 3 ? 0 : along;
  const ez = side === 0 ? 0 : side === 2 ? size : along;
  const nx = side === 1 ? -1 : side === 3 ? 1 : 0;
  const nz = side === 0 ? 1 : side === 2 ? -1 : 0;
  const t = SPECIES;
  const yf = ctx.yearFrac;
  const herbSeason = yf >= HERB_SEED_SEASON[0] && yf < HERB_SEED_SEASON[1];
  const seasonShare = ctx.dt / (HERB_SEED_SEASON[1] - HERB_SEED_SEASON[0]);
  for (let s = 0; s < t.count; s++) {
    const woody = t.woody[s] === 1;
    if (!woody && !herbSeason) continue;
    if (woody && ctx.dayOfYear !== woodySeedDay(ctx, k + s)) continue;
    const weight = t.colonist[s]!;
    if (weight <= 0) continue;
    const key = k * 32 + s;
    const u = counterRandom(world.seed, SYS_COLONIZE, key, ctx.day * 8);
    const v = counterRandom(world.seed, SYS_COLONIZE, key, ctx.day * 8 + 1);
    const d = Math.min(t.dispersalMax[s]!, 3 * t.dispersalMean[s]! * u * u) + 0.5;
    const lateral = (v - 0.5) * cs;
    const x = ex + nx * d + (nx === 0 ? lateral : 0);
    const z = ez + nz * d + (nz === 0 ? lateral : 0);
    const tc = landCellAt(world, x, z);
    if (tc < 0) continue;
    const suit = colonistSuit(world, s, tc);
    if (suit < COLONIST_MIN_SUIT) continue;
    if (!woody) {
      // В холод семена в регионе не созревают.
      if (world.flora.dayT[tc]! < 2) continue;
      addColonistHerbSeeds(world, tc, s, COLONIST_HERB_SEEDS * weight * suit * seasonShare, ctx);
    } else {
      if (counterRandom(world.seed, SYS_COLONIZE, key, ctx.day * 8 + 2) >= COLONIST_WOODY_PACKET * weight * suit) continue;
      addColonistWoodyPacket(world, s, x, z, tc, COLONIST_WOODY_CROWN * t.fecundity[s]!, counterRandom(world.seed, SYS_COLONIZE, key, ctx.day * 8 + 3), ctx);
    }
  }
}

/** Подготовка Wildlands: семена из окружающего региона падают на ячейку суши c (те же механизмы приживания). */
function regionalSeedRain(world: World, c: number, cold: boolean, ctx: DayContext): void {
  const t = SPECIES;
  const yf = ctx.yearFrac;
  const herbSeason = !cold && yf >= HERB_SEED_SEASON[0] && yf < HERB_SEED_SEASON[1];
  const seasonShare = ctx.dt / (HERB_SEED_SEASON[1] - HERB_SEED_SEASON[0]);
  const n = world.geo.n;
  const cs = world.geo.cellSize;
  for (let s = 0; s < t.count; s++) {
    const woody = t.woody[s] === 1;
    if (!woody && !herbSeason) continue;
    if (woody && ctx.dayOfYear !== woodySeedDay(ctx, c + s)) continue;
    const weight = t.colonist[s]!;
    if (weight <= 0) continue;
    const suit = colonistSuit(world, s, c);
    if (suit < COLONIST_MIN_SUIT) continue;
    if (!woody) {
      addColonistHerbSeeds(world, c, s, RAIN_HERB_SEEDS * weight * suit * seasonShare, ctx);
      continue;
    }
    const key = c * 32 + s;
    if (counterRandom(world.seed, SYS_SEED_RAIN, key, ctx.day * 4) >= RAIN_WOODY_PACKET * weight * suit) continue;
    const x = ((c % n) + counterRandom(world.seed, SYS_SEED_RAIN, key, ctx.day * 4 + 1)) * cs;
    const z = (Math.floor(c / n) + counterRandom(world.seed, SYS_SEED_RAIN, key, ctx.day * 4 + 2)) * cs;
    addColonistWoodyPacket(world, s, x, z, c, COLONIST_WOODY_CROWN * t.fecundity[s]!, counterRandom(world.seed, SYS_SEED_RAIN, key, ctx.day * 4 + 3), ctx);
  }
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

  // Свет: полог выше; низкие всходы ещё и в тени травостоя.
  let light = lightAt(world, c, height);
  if (height < 0.8) light *= herbShade(world, c);
  const fT = tempResponse(t, s, T);
  const fW = moistureResponse(t, s, W);
  const fL = lightResponse(t, s, light);
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
    const fixN = t.fixes[s]! * dt * Math.min(1, b / t.halfBiomass[s]!);
    f.nutrient[c] = f.nutrient[c]! + fixN;
    f.ledger[Ledger.fixation]! += fixN * area;
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
  const h = woodyHeight(s, b);
  w.stage[i] = h < 0.5 ? Stage.Seedling : age < t.maturityYears[s]! ? Stage.Sapling : age > 0.8 * life ? Stage.Old : Stage.Mature;

  // Размножение: раз в год, в день рассева, у зрелых и здоровых растений.
  // День рассева у каждого растения свой (сдвиг по индексу на 0–3 суток): рассев не скапливается в одном такте.
  const seedDay = Math.floor(WOODY_SEED_FRACTION * ctx.daysPerYear) + (i % SEED_DAYS_SPREAD);
  if (ctx.dayOfYear === seedDay % ctx.daysPerYear && age >= t.maturityYears[s]! && health > 0.4 && h >= 0.5) produceWoodySeeds(world, i, ctx);
  b = w.biomass[i]!;

  // Смертность: фоновая, всходов, от плохого здоровья, от старости; случайность — от (seed, растение, сутки).
  const senescence = age > 0.8 * life ? (age / life - 0.8) * 2 : 0;
  // Всходы гибнут чаще; запас крупного семени (жёлудь) повышает их выживание: деление на 1 + √(масса семени, г).
  const juvenile = h < 0.5 ? (SEEDLING_MORTALITY * (1 - h / 0.5)) / (1 + Math.sqrt(t.seedMass[s]!)) : 0;
  const p = (t.mortality[s]! + juvenile + 1.5 * (1 - health) * (1 - health) + senescence) * dt;
  if (b <= 0.0005 || counterRandom(world.seed, SYS_WOODY_DEATH, w.idOf(i), ctx.day) < p) killWoody(world, i);
}

/**
 * Гибель древесного растения (старость, болезнь, вырубка): всё вещество уходит в опад ячейки —
 * листва в быстрый, остальное в древесный; растение удаляется, счётчик ячейки уменьшается.
 */
export function killWoody(world: World, i: number): void {
  const f = world.flora;
  const w = f.woody;
  if (w.alive[i] !== 1) return;
  const s = w.species[i]!;
  const c = w.cell[i]!;
  const b = w.biomass[i]!;
  const leafMass = SPECIES.leafFraction[s]! * w.leaf[i]! * Math.max(0, b);
  if (b > 0) {
    deposit(world, c, leafMass, s, false);
    deposit(world, c, b - leafMass, s, true);
  }
  w.remove(i);
  if (f.woodyCount[c]! > 0) f.woodyCount[c] = f.woodyCount[c]! - 1;
}

const ctx: DayContext = { dt: 0, yearFrac: 0, dayOfYear: 0, daysPerYear: 20, day: 0, cellArea: 64, holdDays: 5 };

/** Частей в игровом часе: доля суток каждого часа обрабатывается ещё 6 порциями по 50 тактов. */
const SUBSTEPS = 6;
const SUBSTEP_TICKS = TICKS_PER_HOUR / SUBSTEPS;

export const floraSystem: System<World> = {
  name: 'flora.day',
  period: SUBSTEP_TICKS,
  // Сдвиг на полпорции: шаг флоры не совпадает в одном такте с часовым шагом воды.
  phase: SUBSTEP_TICKS / 2,
  run(world, tick) {
    const hour = Math.floor(tick / TICKS_PER_HOUR);
    const sub = Math.floor((tick - hour * TICKS_PER_HOUR) / SUBSTEP_TICKS);
    const slice = hour % 24;
    const geo = world.geo;
    const f = world.flora;
    ctx.daysPerYear = world.config.daysPerSeason * SEASONS_PER_YEAR;
    ctx.dt = 1 / ctx.daysPerYear;
    ctx.yearFrac = yearFraction(tick, world.config.daysPerSeason);
    ctx.day = Math.floor(hour / 24);
    ctx.dayOfYear = ctx.day % ctx.daysPerYear;
    ctx.cellArea = geo.cellSize * geo.cellSize;
    ctx.holdDays = Math.max(2, Math.round(ctx.daysPerYear / 4));
    if (slice === 0 && sub === 0) refreshCover(world, false);
    const n = geo.n;
    // Ячейки: строки z ≡ час (mod 24), в каждой порции — свой отрезок столбцов.
    const x0 = Math.floor((sub * n) / SUBSTEPS);
    const x1 = Math.floor(((sub + 1) * n) / SUBSTEPS);
    for (let z = slice; z < n; z += 24) {
      for (let x = x0; x < x1; x++) {
        const c = z * n + x;
        if (geo.waterKind[c] === WaterKind.None) processCell(world, c, ctx);
      }
    }
    // Древесные: индекс ≡ час (mod 24), в каждой порции — каждый шестой из них.
    const w = f.woody;
    const high = w.highWater;
    const stride = 24 * SUBSTEPS;
    for (let i = slice + 24 * sub; i < high; i += stride) if (w.alive[i] === 1) processWoody(world, i, ctx);
    // Край мира: колонизация извне, если мир не изолирован.
    if (!world.config.isolated) {
      const edge = 4 * n;
      for (let k = slice + 24 * sub; k < edge; k += stride) colonizeEdge(world, k, ctx);
    }
    if (sub === SUBSTEPS - 1) f.lastSliceHour = hour;
  },
};
