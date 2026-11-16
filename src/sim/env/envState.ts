// Динамическое состояние среды (ARCHITECTURE.md, разделы 8.2–8.4). Всё, что меняется во времени
// и сохраняется; статика мира (рельеф, климатические нормы, почвы) — в Geo.

import { CHUNK_SIZE } from '../../shared/worldConfig';
import type { Geo } from '../worldgen/geo';
import { WaterKind } from '../worldgen/geo';
import { SOILS } from './soils';

export const WEATHER_MAX_CELLS = 24;
/** Поля одной погодной ячейки: x, z, радиус (м), интенсивность, возраст (шаги), срок жизни (шаги). */
export const WEATHER_STRIDE = 6;

export interface WeatherState {
  /** Погодные ячейки; ячейка с нулевым сроком жизни свободна. */
  readonly cells: Float32Array;
  /** Чанков по стороне. */
  readonly chunks: number;
  /** Интенсивность осадков по чанкам на последнем шаге, мм/ч (до местной поправки ячейки). */
  readonly chunkRate: Float32Array;
  /** Облачность по чанкам 0..1. */
  readonly chunkCloud: Float32Array;
  /** Осадки, накопленные по чанкам с последнего часового шага, мм. */
  readonly chunkAccum: Float32Array;
  /**
   * Учёт для регулятора: [0] — норма осадков, которая должна была выпасть (средний слой по суше, мм),
   * [1] — фактически выпавшее. Регулятор рождает ячейки, когда факт отстаёт от нормы.
   */
  readonly balance: Float64Array;
}

export interface EnvState {
  /** Влага корнеобитаемого слоя, мм. */
  readonly moisture: Float32Array;
  /** Снег, мм водного эквивалента. */
  readonly snow: Float32Array;
  /** Индекс зелени 0..1: отклик покрова на тепло и влагу (до фазы 3 — вместо биомассы). */
  readonly greenness: Float32Array;
  /** Текущий расход воды, м³/с. */
  readonly discharge: Float32Array;
  /** Поверхностный и подземный сток ячейки за последний час, мм. */
  readonly runoff: Float32Array;
  /**
   * Накопленный водный баланс, мм·ячейка: [0] осадки, [1] испарение, [2] сток в море,
   * [3] сток из ячеек (всего). Нужен для теста сохранения массы и аналитики.
   */
  readonly waterTotals: Float64Array;
  readonly weather: WeatherState;
  /** Номер последнего выполненного часового шага среды (−1 — не было). */
  lastHourStep: number;
}

/** Множитель осадков ячейки относительно среднего по суше: даёт пространственный рисунок климата. */
export function precipFactor(geo: Geo): { factor: Float32Array; landMean: number; landCells: number } {
  const count = geo.n * geo.n;
  let sum = 0;
  let land = 0;
  for (let i = 0; i < count; i++) {
    if (geo.waterKind[i] === WaterKind.Sea) continue;
    sum += geo.precip[i]!;
    land++;
  }
  const mean = land > 0 ? sum / land : 1;
  const factor = new Float32Array(count);
  for (let i = 0; i < count; i++) factor[i] = geo.precip[i]! / mean;
  return { factor, landMean: mean, landCells: land };
}

export function createEnv(geo: Geo, worldSize: number): EnvState {
  const count = geo.n * geo.n;
  const moisture = new Float32Array(count);
  const greenness = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (geo.waterKind[i] !== WaterKind.None) continue;
    const cap = SOILS[geo.soil[i]!]!.fieldCapacityMm;
    // Начальное состояние — весна после таяния: почва влажная, покров ещё не набрал силу.
    const wet = 0.55 + 0.25 * Math.min(1, geo.precip[i]! / 1200);
    moisture[i] = cap * wet;
    greenness[i] = 0.25;
  }
  const chunks = worldSize / CHUNK_SIZE;
  return {
    moisture,
    snow: new Float32Array(count),
    greenness,
    discharge: new Float32Array(count),
    runoff: new Float32Array(count),
    waterTotals: new Float64Array(4),
    weather: {
      cells: new Float32Array(WEATHER_MAX_CELLS * WEATHER_STRIDE),
      chunks,
      chunkRate: new Float32Array(chunks * chunks),
      chunkCloud: new Float32Array(chunks * chunks),
      chunkAccum: new Float32Array(chunks * chunks),
      balance: new Float64Array(2),
    },
    lastHourStep: -1,
  };
}
