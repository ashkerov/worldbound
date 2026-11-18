// Состояние растительности (docs/PHASE3_PLAN.md, раздел 2): травяной ярус как поле слотов видов,
// древесные как индивиды, опад и запас элемента питания по ячейкам, ведомость потоков вещества.

import type { Geo } from '../worldgen/geo';
import { WaterKind } from '../worldgen/geo';
import { NO_SPECIES, SPECIES } from './species';
import { WoodyStore } from './woodyStore';

/** Слотов видов травяного яруса на ячейку. */
export const SLOTS = 4;
/** Ярусы полога по высоте: < 2, 2–6, 6–15, > 15 м. */
export const CANOPY_LAYERS = 4;
export const CANOPY_BOUNDS = [2, 6, 15] as const;

/** Индексы ведомости потоков (Float64, накопительно с создания мира). Элемент питания — граммы; сухое вещество — кг. */
export const Ledger = {
  /** Приход элемента питания из почвообразующей породы. */
  weathering: 0,
  /** Фиксация бобовыми и ольхой. */
  fixation: 1,
  /** Вымывание со стоком. */
  leaching: 2,
  /** Внесено (+) или изъято (−) создателем. */
  creator: 3,
  /** Принесено семенами колонистов извне. */
  external: 4,
  /** Унесено семенами за пределы суши мира (за границу или в воду). */
  exported: 5,
  /** Сухое вещество: прирост фотосинтезом. */
  photosynthesis: 6,
  /** Сухое вещество: опад и отмирание. */
  litterfall: 7,
  /** Сухое вещество: потеря при разложении. */
  decomposition: 8,
  /** Запас элемента питания в момент создания состояния (точка отсчёта баланса). */
  initialStock: 9,
} as const;
export const LEDGER_SIZE = 10;

export interface FloraState {
  readonly slotSpecies: Uint8Array;
  /** Биомасса слота, г/м². */
  readonly slotBiomass: Float32Array;
  /** Опад листьев и трав, г/м², и элемент питания в нём, г/м². */
  readonly litterFast: Float32Array;
  readonly litterFastN: Float32Array;
  /** Σ (масса × качество опада вида) быстрого опада, г/м²: средняя скорость разложения = Q / масса. */
  readonly litterFastQ: Float32Array;
  /** Опад древесины, г/м², и элемент питания в нём. */
  readonly litterWood: Float32Array;
  readonly litterWoodN: Float32Array;
  /** Доступный растениям запас элемента питания, г/м². */
  readonly nutrient: Float32Array;
  /** Суточные накопители, пишет часовой шаг воды: Σ температуры, Σ относительной влаги, Σ стока (мм), минимум температуры, число часов. */
  readonly accT: Float32Array;
  readonly accW: Float32Array;
  readonly accRunoff: Float32Array;
  readonly accMinT: Float32Array;
  readonly accHours: Uint8Array;
  /** Средние за последние завершённые сутки ячейки: температура, °C, и относительная влага почвы. */
  readonly dayT: Float32Array;
  readonly dayW: Float32Array;
  /** Вода, поднятая в почву из рек и озёр капиллярной подпиткой, мм·ячейка (учёт баланса воды). */
  readonly capillary: Float64Array;
  readonly woody: WoodyStore;
  /** Почвенный банк семян трав: [вид травы × ячейка], г семян на м². Порядок видов — SPECIES.herbs. */
  readonly seedBank: Float32Array;
  /** Число живых древесных в ячейке (ограничение места для всходов). */
  readonly woodyCount: Uint8Array;
  /** Полог: покрытие кронами по ярусам, деревьями, кустарниками, хвойными. Пересчитывается в начале суток и сохраняется (между пересчётами растения растут). */
  readonly canopy: Float32Array;
  readonly treeCover: Float32Array;
  readonly shrubCover: Float32Array;
  readonly coniferCover: Float32Array;
  readonly ledger: Float64Array;
  /** Номер последней обработанной часовой части суток (абсолютный номер игрового часа), −1 — не было. */
  lastSliceHour: number;
}

export function woodyCapacity(geo: Geo): number {
  // До 4 растений на ячейку 8 × 8 м — плотность густого леса; предел — адресуемость идентификатора.
  return Math.min(1 << 20, geo.n * geo.n * 4);
}

/** Начальный запас доступного элемента питания по плодородию почвы, г/м². */
export function initialNutrient(fertility: number): number {
  return 1.5 + 8 * fertility;
}

export function createFlora(geo: Geo): FloraState {
  const count = geo.n * geo.n;
  const nutrient = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (geo.waterKind[i] === WaterKind.None) nutrient[i] = initialNutrient(geo.fertility[i]!);
  }
  const minT = new Float32Array(count).fill(99);
  return {
    slotSpecies: new Uint8Array(count * SLOTS).fill(NO_SPECIES),
    slotBiomass: new Float32Array(count * SLOTS),
    litterFast: new Float32Array(count),
    litterFastN: new Float32Array(count),
    litterFastQ: new Float32Array(count),
    litterWood: new Float32Array(count),
    litterWoodN: new Float32Array(count),
    nutrient,
    accT: new Float32Array(count),
    accW: new Float32Array(count),
    accRunoff: new Float32Array(count),
    accMinT: minT,
    accHours: new Uint8Array(count),
    dayT: new Float32Array(count),
    dayW: new Float32Array(count),
    capillary: new Float64Array(1),
    woody: new WoodyStore(woodyCapacity(geo)),
    seedBank: new Float32Array(SPECIES.herbs.length * count),
    woodyCount: new Uint8Array(count),
    canopy: new Float32Array(count * CANOPY_LAYERS),
    treeCover: new Float32Array(count),
    shrubCover: new Float32Array(count),
    coniferCover: new Float32Array(count),
    ledger: new Float64Array(LEDGER_SIZE),
    lastSliceHour: -1,
  };
}

/** Полный запас элемента питания в мире, г: почва + опад + травы + древесные. */
export function nutrientStock(flora: FloraState, geo: Geo): number {
  const area = geo.cellSize * geo.cellSize;
  const count = geo.n * geo.n;
  let cells = 0;
  for (let i = 0; i < count; i++) cells += flora.nutrient[i]! + flora.litterFastN[i]! + flora.litterWoodN[i]!;
  let herbs = 0;
  for (let h = 0; h < SPECIES.herbs.length; h++) {
    const c = SPECIES.nutrient[SPECIES.herbs[h]!]!;
    for (let i = 0; i < count; i++) herbs += flora.seedBank[h * count + i]! * c;
  }
  for (let k = 0; k < count * SLOTS; k++) {
    const s = flora.slotSpecies[k]!;
    if (s !== NO_SPECIES) herbs += flora.slotBiomass[k]! * SPECIES.nutrient[s]!;
  }
  const w = flora.woody;
  let woody = 0;
  for (let i = 0; i < w.highWater; i++) {
    if (w.alive[i] === 1) woody += w.biomass[i]! * 1000 * SPECIES.nutrient[w.species[i]!]!;
  }
  return (cells + herbs) * area + woody;
}

/** Ожидаемое изменение запаса по ведомости: приходы минус расходы. */
export function nutrientBudget(flora: FloraState): number {
  const l = flora.ledger;
  return l[Ledger.weathering]! + l[Ledger.fixation]! + l[Ledger.creator]! + l[Ledger.external]! - l[Ledger.leaching]! - l[Ledger.exported]!;
}

/** Суммарная биомасса трав ячейки, г/м². */
export function herbBiomass(flora: FloraState, cell: number): number {
  let b = 0;
  for (let k = 0; k < SLOTS; k++) b += flora.slotBiomass[cell * SLOTS + k]!;
  return b;
}
