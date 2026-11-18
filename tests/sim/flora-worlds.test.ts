// Этап 4 фазы 3: биомы, колонизация извне, изолированный мир, Genesis и Wildlands (docs/PHASE3_PLAN.md, раздел 14).
// Тесты A–H из задания заказчика; каждый — на нескольких seed.

import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/core/simulation';
import { BIOMES, biomeIndex } from '../../src/sim/flora/biomes';
import { biomeCounts } from '../../src/sim/flora/biomeState';
import { PLANTS, SPECIES, speciesIndex } from '../../src/sim/flora/species';
import { Ledger, herbBiomass, nutrientBudget, nutrientStock } from '../../src/sim/flora/state';
import { killWoody, refreshCover } from '../../src/sim/flora/system';
import { Stage } from '../../src/sim/flora/woodyStore';
import { applySections, serializeWorld } from '../../src/sim/persistence/worldState';
import { WaterKind } from '../../src/sim/worldgen/geo';
import type { WorldConfig } from '../../src/shared/worldConfig';
import { plotGeo, plotSimulation, runDays, type PlotOptions } from '../support/plot';

const YEAR = 20;
const SEEDS = [1, 2, 3];
const WET: PlotOptions = { precip: 750, soil: 'loam', fertility: 0.8, n: 48 };
/** Разнообразный участок: река у западного края, влажный суглинок, на востоке — сухой бедный песок. */
const MIXED: PlotOptions = { n: 48, precip: 720, soil: 'loam', fertility: 0.75, riverColumns: 3, east: { soil: 'sand', precip: 300, fertility: 0.25 } };

function landCells(sim: Simulation): number[] {
  const geo = sim.world.geo;
  const out: number[] = [];
  for (let c = 0; c < geo.n * geo.n; c++) if (geo.waterKind[c] === WaterKind.None) out.push(c);
  return out;
}

/** Доля ячеек суши с травостоем > 1 г/м². */
function occupied(sim: Simulation, cells = landCells(sim)): number {
  let k = 0;
  for (const c of cells) if (herbBiomass(sim.world.flora, c) > 1) k++;
  return k / cells.length;
}

function balanceError(sim: Simulation): number {
  const f = sim.world.flora;
  return Math.abs(nutrientStock(f, sim.world.geo) - f.ledger[Ledger.initialStock]! - nutrientBudget(f)) / f.ledger[Ledger.initialStock]!;
}

function bankTotal(sim: Simulation): number {
  let s = 0;
  for (const v of sim.world.flora.seedBank) s += v;
  return s;
}

function biomeShare(sim: Simulation, id: string): number {
  const cells = landCells(sim);
  const k = biomeIndex(id);
  return cells.filter((c) => sim.world.flora.biome.current[c] === k).length / cells.length;
}

describe('Тест A — Genesis без изоляции: пустой мир постепенно заселяется извне', () => {
  it.each(SEEDS)('seed %i', (seed) => {
    const sim = plotSimulation(WET, { scenario: 'genesis', seed });
    const f = sim.world.flora;
    // Начало: ни растений, ни семян, ни биомов, кроме голой земли.
    expect(f.woody.count).toBe(0);
    expect(occupied(sim)).toBe(0);
    expect(bankTotal(sim)).toBe(0);
    expect(biomeShare(sim, 'barren')).toBe(1);
    // Первые семена приходят только у сухопутных краёв: середина участка в первый год ещё пуста.
    runDays(sim, YEAR);
    expect(f.ledger[Ledger.external]).toBeGreaterThan(0);
    const n = sim.world.geo.n;
    const centre: number[] = [];
    const edge: number[] = [];
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const c = z * n + x;
        if (x >= 18 && x < 30 && z >= 18 && z < 30) centre.push(c);
        if (x >= n - 3) edge.push(c);
      }
    }
    const bankAt = (cells: number[]) => cells.reduce((s, c) => s + SPECIES.herbs.reduce((t, _, h) => t + f.seedBank[h * n * n + c]!, 0), 0) / cells.length;
    expect(bankAt(edge)).toBeGreaterThan(bankAt(centre) * 3);
    const shares: number[] = [];
    for (let y = 2; y <= 8; y += 2) {
      runDays(sim, 2 * YEAR);
      shares.push(occupied(sim));
    }
    // Постепенно: не мгновенно, но к восьмому году травы заняли большую часть участка.
    expect(shares[0]).toBeLessThan(0.6);
    for (let k = 1; k < shares.length; k++) expect(shares[k]).toBeGreaterThanOrEqual(shares[k - 1]! - 0.02);
    expect(shares.at(-1)).toBeGreaterThan(0.6);
    // Пришли и древесные — семенами, как всходы, без готовых взрослых растений.
    expect(PLANTS.filter((_, s) => f.colonistFirst[s]! >= 0).length).toBeGreaterThanOrEqual(10);
    expect(f.woody.count).toBeGreaterThan(0);
    // Прошло 9 лет (1 + 4 × 2): ни одно растение не старше.
    for (let i = 0; i < f.woody.highWater; i++) if (f.woody.alive[i]) expect(f.woody.age[i]).toBeLessThanOrEqual(9.01);
    expect(biomeShare(sim, 'barren')).toBeLessThan(0.5);
    expect(balanceError(sim)).toBeLessThan(1e-4);
  });
});

describe('Тест B — Genesis с изоляцией: без вмешательства мир остаётся пустым', () => {
  it.each(SEEDS)('seed %i', (seed) => {
    const sim = plotSimulation(WET, { scenario: 'genesis', isolated: true, seed });
    runDays(sim, 6 * YEAR);
    const f = sim.world.flora;
    expect(f.woody.count).toBe(0);
    expect(occupied(sim)).toBe(0);
    expect(bankTotal(sim)).toBe(0);
    expect(f.ledger[Ledger.external]).toBe(0);
    expect(f.colonistMass.every((m) => m === 0)).toBe(true);
    expect(f.colonistFirst.every((t) => t === -1)).toBe(true);
    expect(biomeShare(sim, 'barren')).toBe(1);
  });
});

/** Источник растительности у западного края: банк семян луговых трав и взрослые деревья двух видов. */
function plantSource(sim: Simulation, width: number): void {
  const w = sim.world;
  const f = w.flora;
  const n = w.geo.n;
  const count = n * n;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < width; x++) {
      const c = z * n + x;
      for (const id of ['meadow-grass', 'clover', 'fireweed']) f.seedBank[SPECIES.herbSlot[speciesIndex(id)]! * count + c] = 1;
      if ((x + z) % 2 === 0) {
        const s = speciesIndex(z % 4 === 0 ? 'birch' : 'alder');
        f.woody.spawn(s, (x + 0.5) * 8, (z + 0.5) * 8, c, 300, 30);
        f.woodyCount[c] = f.woodyCount[c]! + 1;
      }
    }
  }
  refreshCover(w, true);
  f.ledger[Ledger.initialStock] = nutrientStock(f, w.geo);
}

describe('Тест C — внутреннее распространение в изолированном мире', () => {
  it.each(SEEDS)('seed %i', (seed) => {
    const sim = plotSimulation(WET, { scenario: 'genesis', isolated: true, seed });
    plantSource(sim, 4);
    const n = sim.world.geo.n;
    const field = landCells(sim).filter((c) => c % n >= 6);
    const near = field.filter((c) => c % n < 16);
    const far = field.filter((c) => c % n >= 36);
    expect(occupied(sim, field)).toBe(0);
    runDays(sim, 3 * YEAR);
    const nearEarly = occupied(sim, near);
    const farEarly = occupied(sim, far);
    expect(nearEarly).toBeGreaterThan(farEarly);
    runDays(sim, 7 * YEAR);
    expect(occupied(sim, field)).toBeGreaterThan(0.6);
    // Подрост вне источника — потомки деревьев мира (извне ничего не пришло).
    const f = sim.world.flora;
    let offspring = 0;
    for (let i = 0; i < f.woody.highWater; i++) if (f.woody.alive[i] && f.woody.x[i]! >= 6 * 8) offspring++;
    expect(offspring).toBeGreaterThan(0);
    expect(f.ledger[Ledger.external]).toBe(0);
    expect(balanceError(sim)).toBeLessThan(1e-4);
  });
});

describe('Тест D — непригодная территория: колонисты закрепляются только там, где могут жить', () => {
  // Восток — каменистая пустыня (120 мм): ни один вид каталога там не живёт.
  const BOUNDARY: PlotOptions = { n: 48, precip: 750, soil: 'loam', fertility: 0.8, east: { soil: 'rock', precip: 120, fertility: 0.05 } };
  it.each(SEEDS)('seed %i', (seed) => {
    const sim = plotSimulation(BOUNDARY, { scenario: 'genesis', seed });
    runDays(sim, 10 * YEAR);
    const n = sim.world.geo.n;
    const west = landCells(sim).filter((c) => c % n < n / 2);
    const east = landCells(sim).filter((c) => c % n >= n / 2);
    expect(occupied(sim, west)).toBeGreaterThan(0.5);
    expect(occupied(sim, east)).toBe(0);
    const f = sim.world.flora;
    for (let i = 0; i < f.woody.highWater; i++) if (f.woody.alive[i]) expect(f.woody.x[i]).toBeLessThan((n / 2) * 8);
  });
});

/** Почвенный банк семян всех трав по всему участку (одинаковый запас; что вырастет, решают условия). */
function sowAllHerbs(sim: Simulation): void {
  const f = sim.world.flora;
  const count = sim.world.geo.n * sim.world.geo.n;
  for (const c of landCells(sim)) for (let h = 0; h < SPECIES.herbs.length; h++) f.seedBank[h * count + c] = 0.5;
  f.ledger[Ledger.initialStock] = nutrientStock(f, sim.world.geo);
}

describe('Тест E — биом следует за растительностью', () => {
  it.each([1, 2])('луг → лес → вырубка → травы (seed %i)', (seed) => {
    const sim = plotSimulation(WET, { scenario: 'genesis', isolated: true, seed });
    sowAllHerbs(sim);
    runDays(sim, 4 * YEAR);
    const w = sim.world;
    const f = w.flora;
    const n = w.geo.n;
    const plot = landCells(sim).filter((c) => c % n >= 10 && c % n < 38 && Math.floor(c / n) >= 10 && Math.floor(c / n) < 38);
    const forest = new Set(['young-forest', 'coniferous-forest', 'broadleaf-forest', 'mixed-forest', 'woodland']);
    const herbal = new Set(['meadow', 'pioneer', 'sparse-grass', 'steppe']);
    const shareOf = (ids: Set<string>) => plot.filter((c) => ids.has(BIOMES[f.biome.current[c]!]!.id)).length / plot.length;
    expect(shareOf(herbal)).toBeGreaterThan(0.8);
    // Создатель сажает рощу (берёза и сосна по 4 взрослых дерева на ячейку): лес возникает в биоме с задержкой.
    const birch = speciesIndex('birch');
    const pine = speciesIndex('pine');
    for (const c of plot) {
      for (let k = 0; k < 4; k++) {
        const s = k % 2 === 0 ? birch : pine;
        const j = f.woody.spawn(s, ((c % n) + 0.25 + (k % 2) * 0.5) * 8, (Math.floor(c / n) + 0.25 + (k >> 1) * 0.5) * 8, c, 250, 25);
        f.woody.stage[j] = Stage.Mature;
        f.woodyCount[c] = f.woodyCount[c]! + 1;
      }
    }
    refreshCover(w, false);
    runDays(sim, 2);
    expect(shareOf(forest)).toBeLessThan(0.2);
    runDays(sim, 2 * YEAR);
    expect(shareOf(forest)).toBeGreaterThan(0.8);
    // Вырубка: всё вещество деревьев — в опад; через два года на месте леса травы.
    for (let i = 0; i < f.woody.highWater; i++) if (f.woody.alive[i] && plot.includes(f.woody.cell[i]!)) killWoody(w, i);
    refreshCover(w, false);
    runDays(sim, 2 * YEAR);
    expect(shareOf(forest)).toBeLessThan(0.1);
    expect(shareOf(herbal)).toBeGreaterThan(0.7);
  });

  it('у порогов биом не мигает: за два года устойчивого луга — не больше одной смены в ячейке', () => {
    const sim = plotSimulation(WET, { scenario: 'genesis', isolated: true, seed: 4 });
    sowAllHerbs(sim);
    runDays(sim, 6 * YEAR);
    const f = sim.world.flora;
    const prev = Uint8Array.from(f.biome.current);
    const changes = new Uint16Array(prev.length);
    for (let d = 0; d < 2 * YEAR; d++) {
      runDays(sim, 1);
      for (let c = 0; c < prev.length; c++) {
        if (f.biome.current[c] !== prev[c]) changes[c]!++;
        prev[c] = f.biome.current[c]!;
      }
    }
    expect(Math.max(...changes)).toBeLessThanOrEqual(1);
  });

  it.each([5, 6])('засуха (осадки −65 %) меняет растительность, а за ней и биом: луг → степь (seed %i)', (seed) => {
    const sim = plotSimulation({ n: 32, precip: 480, soil: 'loam', fertility: 0.5 }, { scenario: 'genesis', isolated: true, seed });
    sowAllHerbs(sim);
    runDays(sim, 6 * YEAR);
    const meadowBefore = biomeShare(sim, 'meadow') + biomeShare(sim, 'pioneer');
    const steppeBefore = biomeShare(sim, 'steppe') + biomeShare(sim, 'sparse-grass');
    expect(meadowBefore).toBeGreaterThan(0.6);
    // Засуха: климатическая норма осадков падает до трети (погода держит годовую сумму у нормы, поэтому
    // меняется сама норма, а не множители ячеек).
    (sim.world.derived as { landMeanPrecip: number }).landMeanPrecip *= 0.35;
    runDays(sim, 8 * YEAR);
    expect(biomeShare(sim, 'steppe') + biomeShare(sim, 'sparse-grass') + biomeShare(sim, 'barren')).toBeGreaterThan(steppeBefore + 0.5);
    expect(biomeShare(sim, 'meadow')).toBeLessThan(meadowBefore - 0.5);
  });

  it('у реки — болото там, где растут болотные травы', () => {
    const sim = plotSimulation({ n: 32, precip: 900, soil: 'clay', fertility: 0.6, riverColumns: 4 }, { scenario: 'genesis', seed: 6 });
    runDays(sim, 10 * YEAR);
    expect(biomeShare(sim, 'bog')).toBeGreaterThan(0);
    expect(biomeCounts(sim.world)[biomeIndex('river')]).toBe(4 * 32);
  });
});

describe('Тест F — детерминизм колонизации и развития', () => {
  it.each([1, 2])('seed %i: одинаковые настройки — одинаковый результат, другой seed — другой', (seed) => {
    const a = plotSimulation(WET, { scenario: 'genesis', seed });
    const b = plotSimulation(WET, { scenario: 'genesis', seed });
    const c = plotSimulation(WET, { scenario: 'genesis', seed: seed + 100 });
    for (const sim of [a, b, c]) runDays(sim, 3 * YEAR);
    expect(a.stateHash()).toBe(b.stateHash());
    expect(Array.from(a.world.flora.colonistFirst)).toEqual(Array.from(b.world.flora.colonistFirst));
    expect(a.stateHash()).not.toBe(c.stateHash());
  });

  it('Wildlands: одинаковые seed — побитно одинаковый подготовленный мир', () => {
    const a = plotSimulation({ ...MIXED, n: 32 }, { scenario: 'wild', seed: 9 }, 3);
    const b = plotSimulation({ ...MIXED, n: 32 }, { scenario: 'wild', seed: 9 }, 3);
    while (a.preparation) a.advancePreparation(7200);
    while (b.preparation) b.advancePreparation(5000);
    expect(a.stateHash()).toBe(b.stateHash());
  });
});

function reload(sim: Simulation, o: PlotOptions, config: Partial<WorldConfig>): Simulation {
  const sections = serializeWorld(sim.world);
  const next = new Simulation({ config: sim.world.config, testAgents: 0, populate: false }, undefined, { geo: plotGeo(o), hash: sim.world.geoHash });
  expect(applySections(next.world, sections)).toEqual([]);
  expect(next.world.config).toMatchObject(config);
  return next;
}

describe('Тест G — сохранение и загрузка не повторяют подготовку и не меняют мир', () => {
  it.each([1, 2])('Wildlands, seed %i', (seed) => {
    const o = { ...MIXED, n: 32 };
    const sim = plotSimulation(o, { scenario: 'wild', seed }, 2);
    while (sim.preparation) sim.advancePreparation(7200);
    runDays(sim, 3);
    const loaded = reload(sim, o, { scenario: 'wild', isolated: false });
    expect(loaded.preparation).toBeNull();
    expect(loaded.world.flora.preparedYears).toBe(2);
    expect(loaded.world.flora.regionalSeedRain).toBe(false);
    expect(loaded.world.tick).toBe(sim.world.tick);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    runDays(sim, 25);
    runDays(loaded, 25);
    expect(loaded.stateHash()).toBe(sim.stateHash());
  });

  it.each([false, true])('Genesis, изоляция %s', (isolated) => {
    const sim = plotSimulation(WET, { scenario: 'genesis', isolated, seed: 3 });
    runDays(sim, 2 * YEAR + 3);
    const loaded = reload(sim, WET, { scenario: 'genesis', isolated });
    expect(loaded.preparation).toBeNull();
    expect(loaded.stateHash()).toBe(sim.stateHash());
    runDays(sim, YEAR);
    runDays(loaded, YEAR);
    expect(loaded.stateHash()).toBe(sim.stateHash());
  });

  it('мир во время подготовки не сохраняется', () => {
    const sim = plotSimulation({ ...MIXED, n: 32 }, { scenario: 'wild', seed: 1 }, 2);
    sim.advancePreparation(7200);
    expect(() => serializeWorld(sim.world)).toThrow(/готовится/);
  });
});

describe('Тест H — Wildlands: сложившийся мир из предварительного прогона той же симуляции', () => {
  it.each(SEEDS)('seed %i: 20 лет', (seed) => {
    const sim = plotSimulation(MIXED, { scenario: 'wild', seed });
    const f = sim.world.flora;
    // До подготовки — ни одного растения: только почвенный банк семян.
    expect(f.woody.count).toBe(0);
    expect(occupied(sim)).toBe(0);
    expect(sim.preparation?.years).toBe(20);
    while (sim.preparation) sim.advancePreparation(7200 * 10);
    expect(f.preparedYears).toBe(20);
    expect(f.regionalSeedRain).toBe(false);
    // Травяной покров, все стадии древесных, много видов, разные биомы.
    expect(occupied(sim)).toBeGreaterThan(0.8);
    const stages = [0, 0, 0, 0];
    const species = new Set<number>();
    let tallest = 0;
    let oldest = 0;
    for (let i = 0; i < f.woody.highWater; i++) {
      if (!f.woody.alive[i]) continue;
      stages[f.woody.stage[i]!]!++;
      species.add(f.woody.species[i]!);
      oldest = Math.max(oldest, f.woody.age[i]!);
    }
    for (let i = 0; i < f.woody.highWater; i++) if (f.woody.alive[i]) tallest = Math.max(tallest, f.woody.biomass[i]!);
    expect(stages[Stage.Seedling]).toBeGreaterThan(0);
    expect(stages[Stage.Sapling]).toBeGreaterThan(0);
    expect(stages[Stage.Mature]).toBeGreaterThan(0);
    expect(species.size).toBeGreaterThanOrEqual(5);
    // Ни одно растение не старше подготовки: всё выросло из семян за эти 20 лет.
    expect(oldest).toBeLessThanOrEqual(20.01);
    expect(tallest).toBeGreaterThan(10);
    const kinds = biomeCounts(sim.world).filter((k, i) => k > 0 && !['sea', 'lake', 'river'].includes(BIOMES[i]!.id)).length;
    expect(kinds).toBeGreaterThanOrEqual(3);
    expect(balanceError(sim)).toBeLessThan(1e-4);
  });
});
