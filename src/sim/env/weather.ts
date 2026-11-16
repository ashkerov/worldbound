// Погода (ARCHITECTURE.md, раздел 8.2): стохастические ячейки осадков, дрейфующие по ветру
// над сеткой чанков. Не гидродинамика, а модель, у которой верна многолетняя норма:
// регулятор рождает ячейки, когда выпавшее отстаёт от климатической нормы, — поэтому за год
// выпадает столько, сколько задаёт климат, а рисунок по месту определяют орография и случай.

import { TWO_PI, clamp, dcos, dsin } from '../../shared/dmath';
import { counterRandom } from '../../shared/rng';
import { TICKS_PER_HOUR, hoursPerYear, yearFraction } from '../../shared/time';
import { CHUNK_SIZE } from '../../shared/worldConfig';
import type { System } from '../core/scheduler';
import type { World } from '../core/world';
import { timeNoise } from './climate';
import { WEATHER_MAX_CELLS, WEATHER_STRIDE } from './envState';

/** Шаг погоды — 10 игровых минут. */
export const WEATHER_PERIOD = 50;
const STEP_HOURS = WEATHER_PERIOD / TICKS_PER_HOUR;
/** Интенсивность осадков в центре ячейки единичной силы, мм/ч. */
const MM_PER_UNIT = 8;
/** Дрейф ячейки за шаг при единичной скорости ветра, м (сжатие времени: см. docs/PHASE2_REPORT.md). */
const DRIFT_PER_STEP = 160;

const SYS_WIND_DIR = 51;
const SYS_WIND_SPEED = 52;
const SYS_SPAWN = 53;

export interface Wind {
  /** Единичный вектор направления движения воздуха. */
  x: number;
  z: number;
  /** Скорость, м/с. */
  speed: number;
}

export function windAt(world: World, tick: number, out: Wind = { x: 0, z: 1, speed: 5 }): Wind {
  const hours = tick / TICKS_PER_HOUR;
  const turn = 0.55 * timeNoise(world.seed, SYS_WIND_DIR, hours / 14);
  const c = dcos(turn);
  const s = dsin(turn);
  const bx = world.geo.windX;
  const bz = world.geo.windZ;
  out.x = bx * c - bz * s;
  out.z = bx * s + bz * c;
  out.speed = 5.5 + 3.5 * timeNoise(world.seed, SYS_WIND_SPEED, hours / 5);
  return out;
}

/** Сезонный множитель нормы осадков: влажнее в конце лета и осенью; среднее за год — 1. */
export function seasonalPrecipFactor(yearFrac: number): number {
  return 1 + 0.25 * dcos(TWO_PI * (yearFrac - 0.55));
}

/** Огибающая жизни ячейки: нарастание, зрелость, распад. */
function envelope(age: number, life: number): number {
  const t = age / life;
  if (t < 0.2) return t / 0.2;
  if (t > 0.7) return (1 - t) / 0.3;
  return 1;
}

/** Ожидаемый вклад средней ячейки в средний слой осадков по миру, мм. */
function stormMean(worldSize: number): number {
  const radius = 1000;
  const lifeHours = 6;
  const meanEnvelope = 0.7;
  const area = (Math.PI * radius * radius) / 3;
  return (meanEnvelope * area * MM_PER_UNIT * lifeHours) / (worldSize * worldSize);
}

const wind: Wind = { x: 0, z: 1, speed: 5 };

export const weatherSystem: System<World> = {
  name: 'env.weather',
  period: WEATHER_PERIOD,
  run(world, tick) {
    const w = world.env.weather;
    const cells = w.cells;
    const size = world.worldSize;
    const seed = world.seed;
    windAt(world, tick, wind);

    // Норма осадков за шаг.
    const yf = yearFraction(tick, world.config.daysPerSeason);
    w.balance[0]! += (world.derived.landMeanPrecip / hoursPerYear(world.config.daysPerSeason)) * seasonalPrecipFactor(yf) * STEP_HOURS;

    // Старение и дрейф.
    const drift = DRIFT_PER_STEP * (wind.speed / 6);
    let free = -1;
    for (let k = 0; k < WEATHER_MAX_CELLS; k++) {
      const o = k * WEATHER_STRIDE;
      const life = cells[o + 5]!;
      if (life <= 0) {
        if (free < 0) free = k;
        continue;
      }
      const age = cells[o + 4]! + 1;
      if (age >= life) {
        cells.fill(0, o, o + WEATHER_STRIDE);
        if (free < 0) free = k;
        continue;
      }
      cells[o + 4] = age;
      cells[o] = cells[o]! + wind.x * drift;
      cells[o + 1] = cells[o + 1]! + wind.z * drift;
    }

    // Рождение: тем вероятнее, чем сильнее факт отстаёт от нормы.
    const deficit = w.balance[0]! - w.balance[1]!;
    const p = clamp(deficit / stormMean(size), 0, 0.85);
    if (free >= 0 && counterRandom(seed, SYS_SPAWN, 0, tick) < p) {
      const o = free * WEATHER_STRIDE;
      const margin = 900;
      const r = (k: number) => counterRandom(seed, SYS_SPAWN, k, tick);
      // Ячейки чаще рождаются с наветренной стороны и проходят над миром.
      const ux = r(1);
      const uz = r(2);
      cells[o] = -margin + ux * (size + 2 * margin) - wind.x * size * 0.35 * r(3);
      cells[o + 1] = -margin + uz * (size + 2 * margin) - wind.z * size * 0.35 * r(3);
      cells[o + 2] = 600 + 900 * r(4);
      cells[o + 3] = 0.55 + 0.9 * r(5);
      cells[o + 4] = 0;
      cells[o + 5] = Math.round((3 + 6 * r(6)) / STEP_HOURS);
    }

    // Поля по чанкам.
    const chunks = w.chunks;
    for (let cz = 0; cz < chunks; cz++) {
      for (let cx = 0; cx < chunks; cx++) {
        const px = (cx + 0.5) * CHUNK_SIZE;
        const pz = (cz + 0.5) * CHUNK_SIZE;
        let rate = 0;
        let cloud = 0.06;
        for (let k = 0; k < WEATHER_MAX_CELLS; k++) {
          const o = k * WEATHER_STRIDE;
          const life = cells[o + 5]!;
          if (life <= 0) continue;
          const dx = px - cells[o]!;
          const dz = pz - cells[o + 1]!;
          const d2 = dx * dx + dz * dz;
          const radius = cells[o + 2]!;
          const env = envelope(cells[o + 4]!, life);
          const strength = cells[o + 3]! * env;
          const cloudR = radius * 1.6;
          if (d2 < cloudR * cloudR) {
            const t = 1 - d2 / (cloudR * cloudR);
            cloud += t * (0.45 + 0.45 * env);
          }
          if (d2 < radius * radius) {
            const t = 1 - d2 / (radius * radius);
            rate += strength * t * t;
          }
        }
        const i = cz * chunks + cx;
        const mm = rate * MM_PER_UNIT;
        w.chunkRate[i] = mm;
        w.chunkCloud[i] = cloud > 1 ? 1 : cloud;
        w.chunkAccum[i] = w.chunkAccum[i]! + mm * STEP_HOURS;
      }
    }
  },
};
