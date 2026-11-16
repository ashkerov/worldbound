import type { Speed } from '../../shared/time';
import type { WorldConfig } from '../../shared/worldConfig';
import type { EnvState } from '../env/envState';
import type { Geo } from '../worldgen/geo';
import type { AgentStore } from './agentStore';

export interface Terrain {
  /** Число отсчётов по стороне. */
  readonly samples: number;
  /** Шаг между отсчётами, м. */
  readonly spacing: number;
  readonly heights: Float32Array;
}

/** Величины, однозначно выводимые из статики мира; не сохраняются, пересчитываются при загрузке. */
export interface WorldDerived {
  /** Множитель осадков ячейки к среднему по суше. */
  readonly pFactor: Float32Array;
  readonly landMeanPrecip: number;
  readonly landCells: number;
  /** Полевая влагоёмкость ячейки, мм. */
  readonly capacity: Float32Array;
  /** Доля запаса влаги, уходящая дренажом за игровой час при насыщении. */
  readonly drainHour: Float32Array;
}

/** Всё авторитетное состояние мира. Ничего игрового вне этого объекта не живёт. */
export interface World {
  readonly seed: number;
  readonly config: WorldConfig;
  /** Сторона мира, м. */
  readonly worldSize: number;
  tick: number;
  speed: Speed;
  readonly terrain: Terrain;
  readonly geo: Geo;
  /** Хеш статики мира, полученный при генерации. */
  readonly geoHash: string;
  readonly env: EnvState;
  readonly derived: WorldDerived;
  readonly agents: AgentStore;
}

/** Билинейная выборка высоты в метрах. Координаты зажимаются в границы мира. */
export function heightAt(terrain: Terrain, x: number, z: number): number {
  const last = terrain.samples - 1;
  let fx = x / terrain.spacing;
  let fz = z / terrain.spacing;
  if (fx < 0) fx = 0;
  else if (fx > last) fx = last;
  if (fz < 0) fz = 0;
  else if (fz > last) fz = last;
  let ix = Math.floor(fx);
  let iz = Math.floor(fz);
  if (ix >= last) ix = last - 1;
  if (iz >= last) iz = last - 1;
  const tx = fx - ix;
  const tz = fz - iz;
  const h = terrain.heights;
  const row = iz * terrain.samples + ix;
  const h00 = h[row]!;
  const h10 = h[row + 1]!;
  const h01 = h[row + terrain.samples]!;
  const h11 = h[row + terrain.samples + 1]!;
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** Индекс эко-ячейки по координатам (зажимается в границы). */
export function cellAt(world: World, x: number, z: number): number {
  const n = world.geo.n;
  const cs = world.geo.cellSize;
  let cx = Math.floor(x / cs);
  let cz = Math.floor(z / cs);
  if (cx < 0) cx = 0;
  else if (cx >= n) cx = n - 1;
  if (cz < 0) cz = 0;
  else if (cz >= n) cz = n - 1;
  return cz * n + cx;
}
