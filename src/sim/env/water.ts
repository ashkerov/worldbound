// Часовой шаг воды и покрова (ARCHITECTURE.md, разделы 8.2–8.3):
// осадки → снег или почва; таяние; ведёрная модель влаги (полевая влагоёмкость, испарение, дренаж);
// капиллярная подпитка почвы у рек и озёр; сток по дереву стока → текущий расход рек;
// суточные накопители условий для растений. Испарение зависит от растительного покрова.
// Баланс воды учитывается точно: изменение запасов = осадки + подпитка − испарение − сток.

import { smoothstep } from '../../shared/dmath';
import { TICKS_PER_HOUR, hoursPerYear } from '../../shared/time';
import type { System } from '../core/scheduler';
import type { World } from '../core/world';
import { WaterKind } from '../worldgen/geo';
import { cellTemperature, chunkSampler, sampleChunks, timeContext, type TimeContext } from './climate';

/** Ниже этой температуры осадки выпадают снегом, °C. */
export const SNOW_THRESHOLD = 0.5;
/** Коэффициент стаивания, мм на °C за реальные сутки (масштабируется сжатием года). */
const DEGREE_DAY_FACTOR = 3.2;
const REAL_HOURS_PER_YEAR = 8760;

const ctx: TimeContext = { seasonal: 0, diurnal: 0, anomaly: 0, sun: { x: 0, y: 1, z: 0 } };

/** Дальность капиллярной подпитки почвы от реки или озера, м. */
export const CAPILLARY_RANGE = 40;
/** Подпитка у самой воды: доля влагоёмкости за час. */
const CAPILLARY_RATE = 0.03;
/** Потенциальное испарение, мм за реальный час на градус выше −4 °C: ≈ 600 мм за год в умеренном климате. */
const PET_PER_DEGREE = 0.0084;

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
    const flora = world.flora;
    let capillary = 0;
    const sampler = chunkSampler(weather, geo);
    // Множитель освещённости одинаков для всех ячеек в этот час: вычисляется один раз (то же значение).
    const sunFactor = 0.35 + 0.65 * smoothstep(-0.05, 0.5, ctx.sun.y);
    for (let i = 0; i < count; i++) {
      const kind = geo.waterKind[i]!;
      if (kind === WaterKind.Sea) {
        runoff[i] = 0;
        continue;
      }
      const cloud = sampleChunks(sampler, weather.chunkCloud, i);
      const precip = sampleChunks(sampler, weather.chunkAccum, i) * d.pFactor[i]!;
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
      // Капиллярная подпитка у воды: почва берегов не пересыхает — основа прибрежной растительности.
      const wd = geo.waterDist[i]!;
      if (wd < CAPILLARY_RANGE && m < cap) {
        const add = Math.min(cap - m, cap * CAPILLARY_RATE * (1 - wd / CAPILLARY_RANGE));
        m += add;
        capillary += add;
      }
      // Испарение и транспирация: растут с температурой, светом и растительным покровом (голая почва — половина
      // потенциального испарения); под снегом почти нет.
      const cover = env.greenness[i]!;
      const pet = t > -4 ? (t + 4) * PET_PER_DEGREE * compression * sunFactor * (1 - 0.5 * cloud) * (0.5 + 0.5 * (cover > 1 ? 1 : cover)) : 0;
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

      // Суточные накопители для растений (их читает суточный шаг флоры).
      flora.accT[i] = flora.accT[i]! + t;
      flora.accW[i] = flora.accW[i]! + m / cap;
      flora.accRunoff[i] = flora.accRunoff[i]! + out;
      if (t < flora.accMinT[i]!) flora.accMinT[i] = t;
      if (flora.accHours[i]! < 255) flora.accHours[i] = flora.accHours[i]! + 1;
    }
    flora.capillary[0]! += capillary;
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
