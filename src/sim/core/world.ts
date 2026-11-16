import type { Speed } from '../../shared/time';
import type { AgentStore } from './agentStore';

export interface Terrain {
  /** Число отсчётов по стороне. */
  readonly samples: number;
  /** Шаг между отсчётами, м. */
  readonly spacing: number;
  readonly heights: Float32Array;
}

/** Всё авторитетное состояние мира. Ничего игрового вне этого объекта не живёт. */
export interface World {
  readonly seed: number;
  /** Сторона мира, м. */
  readonly worldSize: number;
  tick: number;
  speed: Speed;
  readonly terrain: Terrain;
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
