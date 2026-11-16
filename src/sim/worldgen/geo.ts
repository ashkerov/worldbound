// Статические данные мира, созданные генератором из seed. Не меняются во время игры
// (в фазе 3 рельеф станет редактируемым — тогда гидрология пересчитывается целиком).

import type { Terrain } from '../core/world';

export const WaterKind = {
  None: 0,
  River: 1,
  Lake: 2,
  Sea: 3,
} as const;
export type WaterKind = (typeof WaterKind)[keyof typeof WaterKind];

export const EdgeKind = {
  Sea: 0,
  Mountains: 1,
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

/** Края мира: север (z = 0), восток (x = max), юг (z = max), запад (x = 0). */
export type Edges = readonly [EdgeKind, EdgeKind, EdgeKind, EdgeKind];

export const DepositKind = {
  None: 0,
  Stone: 1,
  Clay: 2,
  Ore: 3,
  Sand: 4,
} as const;
export type DepositKind = (typeof DepositKind)[keyof typeof DepositKind];

export const DEPOSIT_NAMES = ['—', 'Выход камня', 'Глина', 'Рудная жила', 'Песок и гравий'] as const;

export interface Lake {
  id: number;
  level: number;
  cells: number;
  /** Ячейка, через которую озеро переливается (исток реки), −1 — нет. */
  outlet: number;
}

export interface Province {
  id: number;
  name: string;
  /** Тип местности, от которого образовано название. */
  kind: ProvinceKind;
  /** Центр масс, м. */
  x: number;
  z: number;
  cells: number;
  meanHeight: number;
  meanTemp: number;
  meanPrecip: number;
}

export type ProvinceKind = 'mountains' | 'highland' | 'hills' | 'valley' | 'coast' | 'lakeland' | 'plain';

export interface Geo {
  /** Ячеек по стороне. */
  readonly n: number;
  /** Размер ячейки, м. */
  readonly cellSize: number;
  readonly edges: Edges;
  /** Высота поверхности ячейки (дно — для воды), м. */
  readonly height: Float32Array;
  /** Уклон (м/м). */
  readonly slope: Float32Array;
  readonly waterKind: Uint8Array;
  /** Уровень воды для водных ячеек, м; для суши — высота поверхности. */
  readonly waterLevel: Float32Array;
  /** Расстояние до ближайшей воды, м (0 — вода). */
  readonly waterDist: Float32Array;
  /** Расстояние до моря, м. */
  readonly seaDist: Float32Array;
  /** Ячейка ниже по течению, −1 — море. */
  readonly receiver: Int32Array;
  /** Ячейки «от истоков к устьям»: каждая ячейка идёт раньше своего приёмника. */
  readonly upstreamOrder: Int32Array;
  /** Средний многолетний расход, м³/с игрового времени при длине года по умолчанию. */
  readonly meanDischarge: Float32Array;
  readonly lakeId: Int16Array;
  readonly lakes: readonly Lake[];
  /** Среднегодовая температура, °C. */
  readonly tMean: Float32Array;
  /** Полуамплитуда сезонного хода температуры, °C. */
  readonly tAmp: Float32Array;
  /** Годовая сумма осадков, мм. */
  readonly precip: Float32Array;
  readonly soil: Uint8Array;
  /** Плодородие 0..1 (база почвы с местными поправками). */
  readonly fertility: Float32Array;
  readonly deposit: Uint8Array;
  /** Богатство залежи 0..255. */
  readonly depositRichness: Uint8Array;
  readonly province: Uint16Array;
  readonly provinces: readonly Province[];
  /** Господствующий ветер — откуда дует (единичный вектор направления движения воздуха). */
  readonly windX: number;
  readonly windZ: number;
  /** Высоты 2 м для рельефа. */
  readonly terrain: Terrain;
  /** Окрестность за границей мира для горизонта: низкое разрешение, только для показа. */
  readonly horizon: Terrain & { readonly originX: number; readonly originZ: number };
}
