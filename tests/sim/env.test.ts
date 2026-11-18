// Среда во времени: сезоны (снег, температура, влага), погода с климатической нормой осадков,
// баланс воды, сток рек, независимость от наблюдения.

import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR, hoursPerYear } from '../../src/shared/time';
import type { Simulation } from '../../src/sim/core/simulation';
import { cellTemperature, chunkSample, timeContext } from '../../src/sim/env/climate';
import { WaterKind } from '../../src/sim/worldgen/geo';
import { buildSurface, cellInfo, chunkTemperatures, layerImage } from '../../src/sim/view/views';
import { LAYERS } from '../../src/shared/protocol';
import { preparedSimulation, simulation } from '../support/worlds';

interface SeasonSample {
  temp: number;
  snowCover: number;
  moisture: number;
  greenness: number;
}

function sample(sim: Simulation): SeasonSample {
  const w = sim.world;
  const geo = w.geo;
  const ctx = timeContext(w.seed, w.tick, w.config.daysPerSeason);
  let temp = 0;
  let snow = 0;
  let moisture = 0;
  let green = 0;
  let land = 0;
  for (let i = 0; i < geo.n * geo.n; i++) {
    if (geo.waterKind[i] !== WaterKind.None) continue;
    land++;
    temp += cellTemperature(geo, i, ctx, chunkSample(w.env.weather, w.env.weather.chunkCloud, geo, i));
    if (w.env.snow[i]! > 2) snow++;
    moisture += w.env.moisture[i]! / w.derived.capacity[i]!;
    green += w.env.greenness[i]!;
  }
  return { temp: temp / land, snowCover: snow / land, moisture: moisture / land, greenness: green / land };
}

function storage(sim: Simulation): number {
  let s = 0;
  for (let i = 0; i < sim.world.geo.n * sim.world.geo.n; i++) s += sim.world.env.moisture[i]! + sim.world.env.snow[i]!;
  return s;
}

/** Прогон текущего года мира с выборкой в середине каждого сезона (полдень). */
function runYear(sim: Simulation): SeasonSample[] {
  const days = sim.world.config.daysPerSeason;
  const yearTicks = hoursPerYear(days) * TICKS_PER_HOUR;
  const base = Math.floor(sim.world.tick / yearTicks) * yearTicks;
  const out: SeasonSample[] = [];
  for (let season = 0; season < 4; season++) {
    const target = base + Math.floor((season * days + days / 2) * TICKS_PER_DAY) + 12 * TICKS_PER_HOUR;
    while (sim.world.tick < target) sim.step();
    out.push(sample(sim));
  }
  return out;
}

describe('Сезоны, погода и вода (малый мир, умеренный климат, сезон 5 суток)', () => {
  // Мир с растительностью (Wildlands, подготовка 1 год): покров меняется по сезонам.
  const sim = preparedSimulation({ seed: 42 });
  const initialStorage = storage(sim);
  // Суммы потоков — за год наблюдения (подготовка мира уже накопила свои).
  const totals0 = Float64Array.from(sim.world.env.waterTotals);
  const capillary0 = sim.world.flora.capillary[0]!;
  const yearStart = Math.floor(sim.world.tick / (hoursPerYear(sim.world.config.daysPerSeason) * TICKS_PER_HOUR));
  const seasons = runYear(sim);
  const [spring, summer, autumn, winter] = seasons as [SeasonSample, SeasonSample, SeasonSample, SeasonSample];
  // Дойти до конца года для годовых сумм.
  const yearTicks = hoursPerYear(sim.world.config.daysPerSeason) * TICKS_PER_HOUR;
  while (sim.world.tick < (yearStart + 1) * yearTicks) sim.step();
  const totals = sim.world.env.waterTotals.map((v, k) => v - totals0[k]!);
  const capillary = sim.world.flora.capillary[0]! - capillary0;
  const landCells = sim.world.derived.landCells;

  it('лето теплее зимы, весна и осень между ними', () => {
    expect(summer.temp - winter.temp).toBeGreaterThan(8);
    expect(spring.temp).toBeLessThan(summer.temp);
    expect(autumn.temp).toBeGreaterThan(winter.temp);
  });

  it('зимой лежит снег, летом его нет', () => {
    expect(winter.snowCover).toBeGreaterThan(0.25);
    expect(summer.snowCover).toBeLessThan(0.03);
  });

  it('влага почвы и покров меняются по сезонам', () => {
    const moistures = seasons.map((s) => s.moisture);
    expect(Math.max(...moistures) - Math.min(...moistures)).toBeGreaterThan(0.05);
    expect(summer.greenness).toBeGreaterThan(winter.greenness + 0.1);
  });

  it('годовая сумма осадков по суше близка к климатической норме', () => {
    const mean = totals[0]! / landCells;
    expect(mean / sim.world.derived.landMeanPrecip).toBeGreaterThan(0.8);
    expect(mean / sim.world.derived.landMeanPrecip).toBeLessThan(1.25);
  });

  it('баланс воды сходится: изменение запасов = осадки + подпитка у воды − испарение − сток', () => {
    const delta = storage(sim) - initialStorage;
    // Подпитка почвы из рек и озёр (фаза 3) — приход в баланс почвенной влаги.
    const budget = totals[0]! - totals[1]! - totals[3]! + capillary;
    expect(Math.abs(delta - budget) / totals[0]!).toBeLessThan(1e-4);
    // Весь сток по дереву стока доходит до моря (маршрутизация без потерь).
    expect(Math.abs(totals[2]! - totals[3]!) / totals[3]!).toBeLessThan(1e-4);
  });

  it('реки несут воду: расход в устьях положителен и соизмерим с многолетним', () => {
    const geo = sim.world.geo;
    let mouths = 0;
    let now = 0;
    let mean = 0;
    for (let i = 0; i < geo.n * geo.n; i++) {
      if (geo.waterKind[i] !== WaterKind.River) continue;
      const r = geo.receiver[i]!;
      if (r < 0 || geo.waterKind[r] !== WaterKind.Sea) continue;
      mouths++;
      now += sim.world.env.discharge[i]!;
      mean += geo.meanDischarge[i]!;
    }
    expect(mouths).toBeGreaterThan(0);
    expect(now).toBeGreaterThan(0);
    expect(now / mean).toBeGreaterThan(0.05);
    expect(now / mean).toBeLessThan(20);
  });

  it('все величины среды конечны и неотрицательны', () => {
    const env = sim.world.env;
    let bad = 0;
    for (let i = 0; i < env.moisture.length; i++) {
      if (!(env.moisture[i]! >= 0 && env.snow[i]! >= 0 && env.discharge[i]! >= 0 && Number.isFinite(env.greenness[i]!))) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe('Длина сезона — настройка мира', () => {
  it('при сезоне 3 суток зима наступает раньше, чем при 8', () => {
    const short = simulation({ seed: 42, daysPerSeason: 3 });
    const long = simulation({ seed: 42, daysPerSeason: 8 });
    const tick = Math.floor(10.5 * TICKS_PER_DAY);
    while (short.world.tick < tick) short.step();
    while (long.world.tick < tick) long.step();
    // 10,5 суток: при сезоне 3 — зима, при сезоне 8 — лето.
    expect(sample(short).temp).toBeLessThan(sample(long).temp - 8);
  });
});

describe('Наблюдение не влияет на мир', () => {
  it('карточки, слои и поверхность, запрошенные в любое время, не меняют хеш состояния', () => {
    const watched = simulation({ seed: 42 }, 200);
    const alone = simulation({ seed: 42 }, 200);
    for (let t = 0; t < 3 * TICKS_PER_HOUR + 17; t++) {
      if (t % 37 === 0) {
        cellInfo(watched.world, (t * 13) % 2048, (t * 29) % 2048);
        buildSurface(watched.world);
        chunkTemperatures(watched.world);
        layerImage(watched.world, LAYERS[t % LAYERS.length]!);
      }
      watched.step();
      alone.step();
    }
    expect(watched.stateHash()).toBe(alone.stateHash());
  });

  it('карточка ячейки даёт осмысленные значения', () => {
    const sim = simulation({ seed: 42 });
    for (let t = 0; t < TICKS_PER_HOUR * 2; t++) sim.step();
    const geo = sim.world.geo;
    const land = geo.waterKind.indexOf(WaterKind.None);
    const x = ((land % geo.n) + 0.5) * geo.cellSize;
    const z = (Math.floor(land / geo.n) + 0.5) * geo.cellSize;
    const info = cellInfo(sim.world, x, z)!;
    expect(info.water).toBe('Суша');
    expect(info.province.length).toBeGreaterThan(3);
    expect(info.moistureRel).toBeGreaterThan(0);
    expect(info.tSummer).toBeGreaterThan(info.tWinter);
    expect(cellInfo(sim.world, -10, 5)).toBeNull();
  });
});
