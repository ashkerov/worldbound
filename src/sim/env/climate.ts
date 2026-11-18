// Температура и свет не хранятся, а вычисляются (ARCHITECTURE.md, раздел 8.2):
// норма ячейки (широта, высота, близость моря) + сезонный ход + суточный ход + погодная аномалия.

import { TWO_PI, dcos, smoothstep } from '../../shared/dmath';
import { hash4 } from '../../shared/rng';
import { seasonalSwing, sunDirection, type SunState } from '../../shared/sun';
import { TICKS_PER_DAY, dayFraction, yearFraction } from '../../shared/time';
import type { Geo } from '../worldgen/geo';
import type { WeatherState } from './envState';

const SYS_ANOMALY = 41;
const INV_2_32 = 1 / 4294967296;

/** Гладкий одномерный шум во времени, [−1, 1]: значения в узлах из хеша, между ними — ступень Эрмита. */
export function timeNoise(seed: number, system: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash4(seed, system, i, 0) * INV_2_32 * 2 - 1;
  const b = hash4(seed, system, i + 1, 0) * INV_2_32 * 2 - 1;
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** Региональная погодная аномалия температуры, °C: волны тепла и похолодания длиной в несколько суток. */
export function temperatureAnomaly(seed: number, tick: number): number {
  const days = tick / TICKS_PER_DAY;
  return 2.6 * timeNoise(seed, SYS_ANOMALY, days * 0.6) + 1.1 * timeNoise(seed, SYS_ANOMALY + 1, days * 2.1);
}

/** Облачность в точке ячейки: билинейно по сетке чанков. */
export function chunkSample(weather: WeatherState, field: Float32Array, geo: Geo, cell: number): number {
  const n = geo.n;
  const x = cell % n;
  const z = (cell - x) / n;
  const per = n / weather.chunks;
  const c = weather.chunks;
  let fx = (x + 0.5) / per - 0.5;
  let fz = (z + 0.5) / per - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > c - 1) fx = c - 1;
  if (fz < 0) fz = 0;
  else if (fz > c - 1) fz = c - 1;
  let ix = Math.floor(fx);
  let iz = Math.floor(fz);
  if (ix > c - 2) ix = c - 2;
  if (iz > c - 2) iz = c - 2;
  const tx = fx - ix;
  const tz = fz - iz;
  const a = field[iz * c + ix]!;
  const b = field[iz * c + ix + 1]!;
  const d = field[(iz + 1) * c + ix]!;
  const e = field[(iz + 1) * c + ix + 1]!;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz;
}

/**
 * Предвычисленная билинейная выборка поля чанков для всех ячеек: те же индексы и веса, что в chunkSample,
 * поэтому результат побитно совпадает, но без деления и округления на каждой ячейке каждый час.
 */
export interface ChunkSampler {
  readonly chunks: number;
  /** Индекс левого верхнего чанка. */
  readonly base: Int32Array;
  readonly tx: Float64Array;
  readonly tz: Float64Array;
}

const samplers = new WeakMap<Geo, ChunkSampler>();

export function chunkSampler(weather: WeatherState, geo: Geo): ChunkSampler {
  const cached = samplers.get(geo);
  if (cached && cached.chunks === weather.chunks) return cached;
  const n = geo.n;
  const count = n * n;
  const c = weather.chunks;
  const per = n / c;
  const base = new Int32Array(count);
  const tx = new Float64Array(count);
  const tz = new Float64Array(count);
  for (let cell = 0; cell < count; cell++) {
    const x = cell % n;
    const z = (cell - x) / n;
    let fx = (x + 0.5) / per - 0.5;
    let fz = (z + 0.5) / per - 0.5;
    if (fx < 0) fx = 0;
    else if (fx > c - 1) fx = c - 1;
    if (fz < 0) fz = 0;
    else if (fz > c - 1) fz = c - 1;
    let ix = Math.floor(fx);
    let iz = Math.floor(fz);
    if (ix > c - 2) ix = c - 2;
    if (iz > c - 2) iz = c - 2;
    base[cell] = iz * c + ix;
    tx[cell] = fx - ix;
    tz[cell] = fz - iz;
  }
  const sampler = { chunks: c, base, tx, tz };
  samplers.set(geo, sampler);
  return sampler;
}

/** То же, что chunkSample, по предвычисленным весам. */
export function sampleChunks(s: ChunkSampler, field: Float32Array, cell: number): number {
  const k = s.base[cell]!;
  const c = s.chunks;
  const tx = s.tx[cell]!;
  const tz = s.tz[cell]!;
  const a = field[k]!;
  const b = field[k + 1]!;
  const d = field[k + c]!;
  const e = field[k + c + 1]!;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz;
}

export interface TimeContext {
  seasonal: number;
  diurnal: number;
  anomaly: number;
  sun: SunState;
}

/** Общие для всех ячеек величины момента времени — считаются один раз на шаг. */
export function timeContext(seed: number, tick: number, daysPerSeason: number, out?: TimeContext): TimeContext {
  const yf = yearFraction(tick, daysPerSeason);
  const df = dayFraction(tick);
  const ctx = out ?? { seasonal: 0, diurnal: 0, anomaly: 0, sun: { x: 0, y: 1, z: 0 } };
  // Сезонный ход отстаёт от солнца примерно на месяц.
  ctx.seasonal = seasonalSwing(yf - 0.04);
  ctx.diurnal = dcos(TWO_PI * (df - 0.625));
  ctx.anomaly = temperatureAnomaly(seed, tick);
  sunDirection(df, yf, ctx.sun);
  return ctx;
}

/** Температура воздуха у поверхности, °C. */
export function cellTemperature(geo: Geo, cell: number, ctx: TimeContext, cloud: number): number {
  const diurnalAmp = 4.6 * (1 - 0.6 * cloud);
  return geo.tMean[cell]! + geo.tAmp[cell]! * ctx.seasonal + diurnalAmp * ctx.diurnal + ctx.anomaly;
}

/** Освещённость поверхности 0..1: высота солнца, ослабленная облаками. */
export function cellLight(ctx: TimeContext, cloud: number): number {
  const sun = ctx.sun.y;
  return smoothstep(-0.05, 0.6, sun) * (1 - 0.6 * cloud);
}
