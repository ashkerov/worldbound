// Тестовые участки: маленький мир с заданными условиями (климат, почва, плодородие, вода) —
// для экологических опытов, где нужны контролируемые условия, а не случайный рельеф.

import { normalizeConfig, type WorldConfig } from '../../src/shared/worldConfig';
import { Simulation } from '../../src/sim/core/simulation';
import { SOIL } from '../../src/sim/env/soils';
import { EdgeKind, WaterKind, type Geo } from '../../src/sim/worldgen/geo';

export interface PlotOptions {
  /** Ячеек по стороне (≥ 32: погода считается по чанкам 128 м). */
  n?: number;
  tMean?: number;
  tAmp?: number;
  precip?: number;
  soil?: keyof typeof SOIL;
  fertility?: number;
  /** Столбцы ячеек, занятые рекой (вода у западного края). */
  riverColumns?: number;
}

export function plotGeo(o: PlotOptions = {}): Geo {
  const n = o.n ?? 32;
  const cs = 8;
  const count = n * n;
  const waterKind = new Uint8Array(count);
  const waterDist = new Float32Array(count).fill(1000);
  const river = o.riverColumns ?? 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      if (x < river) waterKind[i] = WaterKind.River;
      waterDist[i] = x < river ? 0 : river > 0 ? (x - river + 0.5) * cs : 1000;
    }
  }
  const height = new Float32Array(count).fill(50);
  const samples = (n * cs) / 2 + 1;
  return {
    n,
    cellSize: cs,
    edges: [EdgeKind.Sea, EdgeKind.Mountains, EdgeKind.Mountains, EdgeKind.Mountains],
    height,
    slope: new Float32Array(count),
    waterKind,
    waterLevel: new Float32Array(count).fill(50),
    waterDist,
    seaDist: new Float32Array(count).fill(5000),
    receiver: new Int32Array(count).fill(-1),
    upstreamOrder: Int32Array.from({ length: count }, (_, i) => i),
    meanDischarge: new Float32Array(count).fill(river > 0 ? 1 : 0),
    lakeId: new Int16Array(count).fill(-1),
    lakes: [],
    tMean: new Float32Array(count).fill(o.tMean ?? 9),
    tAmp: new Float32Array(count).fill(o.tAmp ?? 10),
    precip: new Float32Array(count).fill(o.precip ?? 800),
    soil: new Uint8Array(count).fill(SOIL[o.soil ?? 'loam']),
    fertility: new Float32Array(count).fill(o.fertility ?? 0.75),
    deposit: new Uint8Array(count),
    depositRichness: new Uint8Array(count),
    province: new Uint16Array(count).fill(1),
    provinces: [{ id: 1, name: 'Опытный участок', kind: 'plain', x: (n * cs) / 2, z: (n * cs) / 2, cells: count, meanHeight: 50, meanTemp: o.tMean ?? 9, meanPrecip: o.precip ?? 800 }],
    windX: 0,
    windZ: 1,
    terrain: { samples, spacing: 2, heights: new Float32Array(samples * samples).fill(50) },
    horizon: { samples: 2, spacing: n * cs, heights: new Float32Array(4).fill(50), originX: 0, originZ: 0 },
  };
}

export function plotSimulation(o: PlotOptions = {}, config: Partial<WorldConfig> = {}): Simulation {
  const cfg = normalizeConfig({ seed: 7, size: 'S', daysPerSeason: 5, ...config });
  return new Simulation({ config: cfg, testAgents: 0 }, undefined, { geo: plotGeo(o), hash: `plot-${JSON.stringify(o)}` });
}

/** Прогон на целое число игровых суток. */
export function runDays(sim: Simulation, days: number): void {
  const end = sim.world.tick + days * 7200;
  while (sim.world.tick < end) sim.step();
}
