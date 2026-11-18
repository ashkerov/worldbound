// Опыты этапа 3 фазы 3 (размножение, расселение, конкуренция): A — зарастание влажного участка,
// B — сухой участок остаётся степью, C — конкуренция за свет, D — расселение только в пригодное, E — детерминизм.
// Исход определяется характеристиками видов и условиями: списков приоритетов видов в модели нет.

import { describe, expect, it } from 'vitest';
import { MAX_WOODY_PER_CELL } from '../../src/sim/flora/system';
import { DRY, WET, runBoundary, runShade, runSuccession, type SuccessionRun } from '../support/experiments';

const at = (run: SuccessionRun['samples'], year: number) => run[year - 1]!;
const forestCells = (b: Record<string, number>) => (b['woodland'] ?? 0) + (b['broadleaf-forest'] ?? 0) + (b['mixed-forest'] ?? 0) + (b['coniferous-forest'] ?? 0);

describe.each([1, 2, 3])('Опыт A: зарастание голого влажного плодородного участка, seed %i', (seed) => {
  const run = runSuccession(WET, seed, 50);
  const field = run.samples;
  const near = run.near;
  const cells = 48 * 42;

  it('сначала травы: к 12-му году травы заняли поле, а полог кустарников и деревьев ещё ничтожен', () => {
    expect(at(field, 12).herbOccupancy).toBeGreaterThan(0.8);
    expect(at(field, 12).shrubCover).toBeLessThan(0.01);
    expect(at(field, 12).treeCover).toBeLessThan(0.01);
  });

  it('затем кустарники: их число растёт, к 50-му году они заметно покрывают поле', () => {
    expect(at(field, 40).shrubs).toBeGreaterThan(3 * at(field, 15).shrubs);
    expect(at(field, 50).shrubCover).toBeGreaterThan(0.03);
  });

  it('затем деревья: подрост взрослеет, полог деревьев растёт, у опушки складывается лес', () => {
    expect(at(field, 30).treeStages[2]).toBeGreaterThan(0);
    expect(at(field, 50).treeCover).toBeGreaterThan(at(field, 30).treeCover);
    expect(at(near, 50).treeCover).toBeGreaterThan(0.05);
    expect(forestCells(at(near, 50).biomes)).toBeGreaterThan(0);
    expect(at(near, 50).topHeight).toBeGreaterThan(12);
  });

  it('популяции и банк семян ограничены, вещество сохраняется', () => {
    for (const s of field) {
      expect(s.shrubs + s.trees).toBeLessThanOrEqual(cells * MAX_WOODY_PER_CELL);
      expect(s.seedBank).toBeLessThan(50);
      expect(s.herbs).toBeLessThan(600);
      expect(s.balanceError).toBeLessThan(1e-4);
    }
  });
});

describe('Опыт B: сухой бедный участок остаётся степью', () => {
  const run = runSuccession(DRY, 1, 40);
  const end = run.samples.at(-1)!;

  it('господствует ковыль, луговых трав почти нет', () => {
    const total = Object.values(end.herbBySpecies).reduce((a, b) => a + b, 0);
    expect((end.herbBySpecies['feather-grass'] ?? 0) / total).toBeGreaterThan(0.7);
    expect((end.herbBySpecies['meadow-grass'] ?? 0) / total).toBeLessThan(0.1);
    expect(end.biomes['steppe'] ?? 0).toBeGreaterThan(end.biomes['meadow'] ?? 0);
  });

  it('деревья не смыкаются: полог деревьев остаётся ничтожным', () => {
    expect(end.treeCover).toBeLessThan(0.01);
    expect(forestCells(end.biomes)).toBeLessThan(20);
  });
});

describe('Опыт C: конкуренция за свет', () => {
  const { open, shaded } = runShade(1, 20);
  const tolerant = (s: Record<string, number>) => (s['bilberry'] ?? 0) + (s['moss'] ?? 0);

  it('под сомкнутым пологом мятлик даёт заметно меньше биомассы, чем на открытом месте', () => {
    expect(shaded.treeCover).toBeGreaterThan(0.7);
    expect(shaded.herbBySpecies['meadow-grass'] ?? 0).toBeLessThan(0.3 * (open.herbBySpecies['meadow-grass'] ?? 0));
  });

  it('под пологом теневыносливые обгоняют светолюбивых, на открытом месте — наоборот', () => {
    expect(tolerant(shaded.herbBySpecies)).toBeGreaterThan(shaded.herbBySpecies['meadow-grass'] ?? 0);
    expect(open.herbBySpecies['meadow-grass'] ?? 0).toBeGreaterThan(10 * tolerant(open.herbBySpecies));
    expect(shaded.herbBySpecies['clover'] ?? 0).toBeLessThan(1);
  });
});

describe('Опыт D: расселение только в пригодные места', () => {
  const r = runBoundary(1, 20);

  it('на пригодном западе травы заняли поле, на сухом каменистом востоке не закрепились даже у самой границы', () => {
    expect(r.west.herbOccupancy).toBeGreaterThan(0.8);
    expect(r.east.herbOccupancy).toBeLessThan(0.05);
    expect(r.eastNearBoundary.herbOccupancy).toBeLessThan(0.05);
    // Семена на восток долетают — их не пускают условия, а не расстояние.
    expect(r.eastNearBoundary.seedBank + r.east.seedBank).toBeGreaterThan(0);
  });
});

describe('Опыт E: детерминизм', () => {
  it('одинаковые параметры и seed дают побитно одинаковое состояние, другой seed — другое', () => {
    const a = runSuccession(WET, 5, 15);
    const b = runSuccession(WET, 5, 15);
    const c = runSuccession(WET, 6, 15);
    expect(a.stateHash).toBe(b.stateHash);
    expect(a.samples).toEqual(b.samples);
    expect(c.stateHash).not.toBe(a.stateHash);
  });
});
