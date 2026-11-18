// Экологические опыты этапа 3 фазы 3 (зарастание, степь, свет, расселение): общий код для тестов
// и для инструмента, который пишет ряды и графики (tools/flora-experiments.ts).
// Участок: слева — «опушка» (источник семян: взрослые деревья и кустарники всех видов и банк семян всех трав),
// справа — голая земля. Какие виды придут и выживут, решают только их характеристики и условия.

import type { Simulation } from '../../src/sim/core/simulation';
import { BIOMES } from '../../src/sim/flora/biomes';
import { NO_SPECIES, PLANTS, SPECIES } from '../../src/sim/flora/species';
import { Ledger, SLOTS, nutrientBudget, nutrientStock } from '../../src/sim/flora/state';
import { refreshCover, woodyHeight } from '../../src/sim/flora/system';
import type { Stage } from '../../src/sim/flora/woodyStore';
import type { WorldConfig } from '../../src/shared/worldConfig';
import { plotSimulation, type PlotOptions } from './plot';

export const DAYS_PER_YEAR = 20;
/** Влажный плодородный участок (750 мм: при 900 мм плоский суглинок без стока заболачивается). */
export const WET: PlotOptions = { precip: 750, soil: 'loam', fertility: 0.8, n: 48 };
export const DRY: PlotOptions = { precip: 260, soil: 'sand', fertility: 0.3, tMean: 11, n: 48 };

export interface YearSample {
  year: number;
  /** Средняя биомасса трав в зоне наблюдения, г/м². */
  herbs: number;
  herbBySpecies: Record<string, number>;
  /** Доля ячеек зоны, где есть травы. */
  herbOccupancy: number;
  shrubs: number;
  trees: number;
  /** Деревья по стадиям: всходы, подрост, взрослые, старые. */
  treeStages: [number, number, number, number];
  woodyBySpecies: Record<string, number>;
  treeCover: number;
  shrubCover: number;
  /** Средняя высота пяти самых высоких деревьев зоны, м. */
  topHeight: number;
  biomes: Record<string, number>;
  /** Банк семян трав в зоне, г/м². */
  seedBank: number;
  /** Доступный элемент питания в зоне, г/м². */
  nutrient: number;
  /** Отклонение баланса элемента питания (относительное). */
  balanceError: number;
}

/**
 * Опушка в столбцах [0, columns): первая половина — лес (взрослые деревья и кустарники всех видов),
 * вторая — открытый луг со всеми травами. Вместе с банком семян всех трав — источник семян для голого участка.
 */
export function plantSourceStrip(sim: Simulation, columns: number): void {
  const f = sim.world.flora;
  const n = sim.world.geo.n;
  const cs = sim.world.geo.cellSize;
  const woody = PLANTS.map((p, i) => i).filter((i) => SPECIES.woody[i] === 1);
  let k = 0;
  const herbs = SPECIES.herbs;
  let m = 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < columns; x++) {
      const c = z * n + x;
      for (const h of herbs) f.seedBank[SPECIES.herbSlot[h]! * n * n + c] = 1;
      if (x < columns >> 1) {
        const s = woody[k++ % woody.length]!;
        const mature = SPECIES.maturityYears[s]! + 5;
        f.woody.spawn(s, (x + 0.5) * cs, (z + 0.5) * cs, c, 0.35 * SPECIES.maxBiomass[s]!, mature);
        f.woodyCount[c] = f.woodyCount[c]! + 1;
      } else {
        // Луг: четыре вида в ячейке по очереди из всех трав каталога.
        for (let slot = 0; slot < SLOTS; slot++) {
          f.slotSpecies[c * SLOTS + slot] = herbs[m++ % herbs.length]!;
          f.slotBiomass[c * SLOTS + slot] = 40;
        }
      }
    }
  }
  refreshCover(sim.world, true);
  // Опушка — начальное условие: её вещество входит в точку отсчёта баланса.
  f.ledger.fill(0);
  f.ledger[Ledger.initialStock] = nutrientStock(f, sim.world.geo);
}

/** Показатели зоны участка — столбцы [fromColumn, toColumn). */
export function sampleZone(sim: Simulation, fromColumn: number, year: number, toColumn = sim.world.geo.n): YearSample {
  const f = sim.world.flora;
  const geo = sim.world.geo;
  const n = geo.n;
  let cells = 0;
  let herbs = 0;
  let occupied = 0;
  let treeCover = 0;
  let shrubCover = 0;
  let bank = 0;
  let nutrient = 0;
  const herbBySpecies: Record<string, number> = {};
  const biomes: Record<string, number> = {};
  for (let z = 0; z < n; z++) {
    for (let x = fromColumn; x < toColumn; x++) {
      const c = z * n + x;
      cells++;
      let hb = 0;
      for (let k = 0; k < SLOTS; k++) {
        const s = f.slotSpecies[c * SLOTS + k]!;
        if (s === NO_SPECIES) continue;
        const b = f.slotBiomass[c * SLOTS + k]!;
        hb += b;
        herbBySpecies[PLANTS[s]!.id] = (herbBySpecies[PLANTS[s]!.id] ?? 0) + b;
      }
      herbs += hb;
      if (hb > 1) occupied++;
      treeCover += f.treeCover[c]!;
      nutrient += f.nutrient[c]!;
      shrubCover += f.shrubCover[c]!;
      for (let h = 0; h < SPECIES.herbs.length; h++) bank += f.seedBank[h * n * n + c]!;
      const id = BIOMES[f.biome.current[c]!]!.id;
      biomes[id] = (biomes[id] ?? 0) + 1;
    }
  }
  for (const k of Object.keys(herbBySpecies)) herbBySpecies[k] = +(herbBySpecies[k]! / cells).toFixed(1);
  const w = f.woody;
  let shrubs = 0;
  let trees = 0;
  const treeStages: [number, number, number, number] = [0, 0, 0, 0];
  const woodyBySpecies: Record<string, number> = {};
  const heights: number[] = [];
  for (let i = 0; i < w.highWater; i++) {
    if (w.alive[i] !== 1 || w.x[i]! < fromColumn * geo.cellSize || w.x[i]! >= toColumn * geo.cellSize) continue;
    const s = w.species[i]!;
    woodyBySpecies[PLANTS[s]!.id] = (woodyBySpecies[PLANTS[s]!.id] ?? 0) + 1;
    if (SPECIES.tree[s] === 1) {
      trees++;
      treeStages[w.stage[i]! as Stage]++;
      heights.push(woodyHeight(s, w.biomass[i]!));
    } else shrubs++;
  }
  heights.sort((a, b) => b - a);
  const top = heights.slice(0, 5);
  const initial = f.ledger[Ledger.initialStock]!;
  return {
    year,
    herbs: +(herbs / cells).toFixed(1),
    herbBySpecies,
    herbOccupancy: +(occupied / cells).toFixed(3),
    shrubs,
    trees,
    treeStages,
    woodyBySpecies,
    treeCover: +(treeCover / cells).toFixed(3),
    shrubCover: +(shrubCover / cells).toFixed(3),
    topHeight: +(top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0).toFixed(2),
    biomes,
    seedBank: +(bank / cells).toFixed(3),
    nutrient: +(nutrient / cells).toFixed(2),
    balanceError: Math.abs(nutrientStock(f, geo) - initial - nutrientBudget(f)) / initial,
  };
}

export interface SuccessionRun {
  seed: number;
  /** Всё поле (от опушки до восточного края). */
  samples: YearSample[];
  /** Ближняя полоса поля: 10 столбцов (80 м) от опушки. */
  near: YearSample[];
  stateHash: string;
  /** Время расчёта, мс. */
  ms: number;
}

/** Опыт зарастания: опушка слева, голая земля справа; выборка в середине лета каждого года. */
export function runSuccession(plot: PlotOptions, seed: number, years: number, config: Partial<WorldConfig> = {}, sourceColumns = 4, clock: () => number = () => 0): SuccessionRun {
  const sim = plotSimulation(plot, { scenario: 'genesis', isolated: true, seed, ...config });
  plantSourceStrip(sim, sourceColumns);
  const samples: YearSample[] = [];
  const near: YearSample[] = [];
  const t0 = clock();
  for (let y = 1; y <= years; y++) {
    const target = ((y - 1) * DAYS_PER_YEAR + 7.5) * 7200;
    while (sim.world.tick < target) sim.step();
    samples.push(sampleZone(sim, sourceColumns + 2, y));
    near.push(sampleZone(sim, sourceColumns + 2, y, sourceColumns + 12));
  }
  return { seed, samples, near, stateHash: sim.stateHash(), ms: clock() - t0 };
}

/**
 * Опыт C: свет. Одинаковые участки с одинаковым смешанным травостоем (мятлик, клевер, черника, мох) и банком семян
 * всех трав; на одном — сомкнутый еловый полог (2 ели на ячейку 8 × 8 м: покрытие ≈ 87 %, у земли ≈ 20 % света).
 * Вопрос — исход конкуренции видов. (Под 4 елями на ячейку света ≈ 3 % — «мертвопокровный» ельник, где гибнут все травы.)
 */
export function runShade(seed: number, years: number): { open: YearSample; shaded: YearSample } {
  const make = (shade: boolean) => {
    const sim = plotSimulation({ ...WET, n: 32 }, { scenario: 'genesis', isolated: true, seed });
    const f = sim.world.flora;
    const n = 32;
    const spruce = PLANTS.findIndex((p) => p.id === 'spruce');
    const mix: [string, number][] = [
      ['meadow-grass', 120],
      ['clover', 40],
      ['bilberry', 30],
      ['moss', 20],
    ];
    for (let c = 0; c < n * n; c++) {
      for (const h of SPECIES.herbs) f.seedBank[SPECIES.herbSlot[h]! * n * n + c] = 1;
      mix.forEach(([id, b], k) => {
        f.slotSpecies[c * SLOTS + k] = PLANTS.findIndex((p) => p.id === id);
        f.slotBiomass[c * SLOTS + k] = b;
      });
      if (shade) {
        const x = c % n;
        const z = Math.floor(c / n);
        for (const [dx, dz] of [
          [2, 2],
          [6, 6],
        ]) {
          f.woody.spawn(spruce, x * 8 + dx!, z * 8 + dz!, c, 900, 60);
          f.woodyCount[c] = f.woodyCount[c]! + 1;
        }
      }
    }
    refreshCover(sim.world, true);
    f.ledger.fill(0);
    f.ledger[Ledger.initialStock] = nutrientStock(f, sim.world.geo);
    const target = ((years - 1) * DAYS_PER_YEAR + 7.5) * 7200;
    while (sim.world.tick < target) sim.step();
    return sampleZone(sim, 0, years);
  };
  return { open: make(false), shaded: make(true) };
}

/** Опыт D: граница пригодности. Запад — влажный суглинок, восток — сухие камни; луг-источник у западного края. */
export const BOUNDARY: PlotOptions = { precip: 750, soil: 'loam', fertility: 0.8, n: 48, east: { soil: 'rock', precip: 300, fertility: 0.1 } };
export function runBoundary(seed: number, years: number): { west: YearSample; east: YearSample; eastNearBoundary: YearSample } {
  const sim = plotSimulation(BOUNDARY, { scenario: 'genesis', isolated: true, seed });
  const f = sim.world.flora;
  const n = 48;
  const herbs = SPECIES.herbs;
  let m = 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < 4; x++) {
      const c = z * n + x;
      for (let slot = 0; slot < SLOTS; slot++) {
        f.slotSpecies[c * SLOTS + slot] = herbs[m++ % herbs.length]!;
        f.slotBiomass[c * SLOTS + slot] = 40;
      }
      for (const h of herbs) f.seedBank[SPECIES.herbSlot[h]! * n * n + c] = 1;
    }
  }
  f.ledger.fill(0);
  f.ledger[Ledger.initialStock] = nutrientStock(f, sim.world.geo);
  const target = ((years - 1) * DAYS_PER_YEAR + 7.5) * 7200;
  while (sim.world.tick < target) sim.step();
  return { west: sampleZone(sim, 4, years, n >> 1), east: sampleZone(sim, n >> 1, years), eastNearBoundary: sampleZone(sim, n >> 1, years, (n >> 1) + 4) };
}
