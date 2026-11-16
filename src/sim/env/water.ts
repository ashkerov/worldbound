// Часовой шаг воды и покрова (ARCHITECTURE.md, разделы 8.2–8.3):
// осадки → снег или почва; таяние; ведёрная модель влаги (полевая влагоёмкость, испарение, дренаж);
// сток по дереву стока → текущий расход рек; отклик индекса зелени на тепло и влагу.
// Баланс воды учитывается точно: изменение запасов = осадки − испарение − сток.

import { smoothstep } from '../../shared/dmath';
import { TICKS_PER_HOUR, hoursPerYear } from '../../shared/time';
import type { System } from '../core/scheduler';
import type { World } from '../core/world';
import { WaterKind, type Geo } from '../worldgen/geo';
import { cellTemperature, chunkSample, timeContext, type TimeContext } from './climate';

/** Ниже этой температуры осадки выпадают снегом, °C. */
export const SNOW_THRESHOLD = 0.5;
/** Коэффициент стаивания, мм на °C за реальные сутки (масштабируется сжатием года). */
const DEGREE_DAY_FACTOR = 3.2;
const REAL_HOURS_PER_YEAR = 8760;

const ctx: TimeContext = { seasonal: 0, diurnal: 0, anomaly: 0, sun: { x: 0, y: 1, z: 0 } };

/** Уровень зелени, который поддерживают тепло сезона, влага почвы и снег. */
export function greennessTarget(geo: Geo, i: number, c: TimeContext, temperature: number, moistureRel: number, snow: number): number {
  const warm = smoothstep(-1, 9, geo.tMean[i]! + geo.tAmp[i]! * c.seasonal) * (1 - smoothstep(29, 38, temperature));
  const wet = smoothstep(0.1, 0.5, moistureRel);
  return snow > 4 ? 0.04 : warm * wet * (0.35 + 0.65 * geo.fertility[i]!);
}

export const waterSystem: System<World> = {
  name: 'env.water',
  period: TICKS_PER_HOUR,
  run(world, tick) {
    const geo = world.geo;
    const env = world.env;
    const weather = env.weather;
    const d = world.derived;
    const n = geo.n;
    const count = n * n;
    const cellArea = geo.cellSize * geo.cellSize;
    // Год в игре короче реального: интенсивности процессов, заданные «за реальный год», сжимаются вместе с ним.
    const compression = REAL_HOURS_PER_YEAR / hoursPerYear(world.config.daysPerSeason);
    const meltPerDegree = (DEGREE_DAY_FACTOR / 24) * compression;
    timeContext(world.seed, tick, world.config.daysPerSeason, ctx);

    let landPrecip = 0;
    let evaporated = 0;
    let precipTotal = 0;
    let localTotal = 0;
    const runoff = env.runoff;
    for (let i = 0; i < count; i++) {
      const kind = geo.waterKind[i]!;
      if (kind === WaterKind.Sea) {
        runoff[i] = 0;
        continue;
      }
      const cloud = chunkSample(weather, weather.chunkCloud, geo, i);
      const precip = chunkSample(weather, weather.chunkAccum, geo, i) * d.pFactor[i]!;
      landPrecip += precip;
      precipTotal += precip;
      if (kind !== WaterKind.None) {
        // Осадки на реку или озеро сразу идут в сток.
        runoff[i] = precip;
        localTotal += precip;
        continue;
      }
      const t = cellTemperature(geo, i, ctx, cloud);
      let snow = env.snow[i]!;
      let input = 0;
      if (t < SNOW_THRESHOLD) snow += precip;
      else input += precip;
      if (t > 0 && snow > 0) {
        const melt = Math.min(snow, meltPerDegree * t);
        snow -= melt;
        input += melt;
      }
      const cap = d.capacity[i]!;
      let m = env.moisture[i]! + input;
      let out = 0;
      if (m > cap) {
        out = m - cap;
        m = cap;
      }
      // Испарение и транспирация: растут с температурой и светом; под снегом почти нет.
      const pet = t > -4 ? (t + 4) * 0.0042 * compression * (0.35 + 0.65 * smoothstep(-0.05, 0.5, ctx.sun.y)) * (1 - 0.5 * cloud) : 0;
      const et = Math.min(m, pet * (m / cap) * (snow > 5 ? 0.2 : 1));
      m -= et;
      const drain = d.drainHour[i]! * m * (m / cap);
      m -= drain;
      out += drain;
      env.moisture[i] = m;
      env.snow[i] = snow;
      runoff[i] = out;
      evaporated += et;
      localTotal += out;

      // Индекс зелени тянется к тому, что позволяют тепло, влага и снег.
      const target = greennessTarget(geo, i, ctx, t, m / cap, snow);
      const g = env.greenness[i]!;
      env.greenness[i] = g + (target - g) * (target > g ? 0.035 : 0.022);
    }
    // Сток по дереву: от истоков к устьям.
    const discharge = env.discharge;
    const order = geo.upstreamOrder;
    discharge.fill(0);
    let toSea = 0;
    const toM3s = cellArea / 1000 / 3600;
    for (let k = 0; k < count; k++) {
      const i = order[k]!;
      if (geo.waterKind[i] === WaterKind.Sea) continue;
      const q = discharge[i]! + runoff[i]! * toM3s;
      discharge[i] = q;
      const r = geo.receiver[i]!;
      if (r < 0 || geo.waterKind[r] === WaterKind.Sea) toSea += q;
      else discharge[r] = discharge[r]! + q;
    }
    weather.chunkAccum.fill(0);
    weather.balance[1]! += landPrecip / d.landCells;
    env.waterTotals[0]! += precipTotal;
    env.waterTotals[1]! += evaporated;
    env.waterTotals[2]! += toSea / toM3s;
    env.waterTotals[3]! += localTotal;
    env.lastHourStep = Math.floor(tick / TICKS_PER_HOUR);
  },
};
