// Тесты прототипа 1C: инварианты перехода между уровнями и независимость от наблюдателя.
// Обязательный технический критерий (решение заказчика): до масштабирования симуляции
// переходы «когорта ↔ особи» должны быть проверены.

import { beforeAll, describe, expect, it } from 'vitest';
import { calibrate } from '../../prototypes/lod/calibrate';
import { FOX, LodWorld, RABBIT, type FarMode, type FarParams } from '../../prototypes/lod/model';
import { counterRandom } from '../../src/shared/rng';

const SIZE = 6;
let fp: FarParams;

beforeAll(() => {
  fp = calibrate({ seeds: [11, 12], nx: SIZE, ny: SIZE, days: 200, warmup: 40 });
}, 120_000);

const deathsOf = (world: LodWorld, species: number) => world.deaths[species]!.reduce((a, b) => a + b, 0);

/** Случайная зона наблюдателя, меняющаяся каждые сутки. */
function randomFocus(day: number) {
  return (chunk: number) => counterRandom(777, 1, chunk, day) < 0.35;
}

describe.each(['cohort', 'meanfield', 'coarse', 'unified'] as FarMode[])('Книга учёта, режим %s', (far) => {
  it('численность = начальная + рождения − смерти при любой смене уровней', () => {
    const world = new LodWorld(5, SIZE, SIZE, far, fp);
    const start = [world.count(RABBIT), world.count(FOX)];
    for (let day = 0; day < 120; day++) {
      world.setFocus(randomFocus(day));
      world.stepDay();
      for (const species of [RABBIT, FOX]) {
        expect(world.count(species), `сутки ${day}, вид ${species}`).toBe(start[species]! + world.births[species]! - deathsOf(world, species));
      }
    }
    // Проверка не вырожденная: в мире действительно что-то происходило.
    expect(world.births[RABBIT]).toBeGreaterThan(100);
    expect(deathsOf(world, RABBIT)).toBeGreaterThan(100);
  }, 120_000);
});

describe('Переход «особи ↔ когорта»', () => {
  it('свёртывание и воплощение сохраняют численность по чанкам и суммарную энергию', () => {
    const world = new LodWorld(9, SIZE, SIZE, 'cohort', fp);
    for (let day = 0; day < 40; day++) world.stepDay();
    const before = { r: world.countByChunk(RABBIT), f: world.countByChunk(FOX), er: world.totalEnergy(RABBIT), ef: world.totalEnergy(FOX) };
    expect(world.embodied(RABBIT)).toBe(world.count(RABBIT));

    world.setFocus(() => false);
    expect(world.embodied(RABBIT)).toBe(0);
    expect(world.embodied(FOX)).toBe(0);
    expect(Array.from(world.countByChunk(RABBIT))).toEqual(Array.from(before.r));
    expect(Array.from(world.countByChunk(FOX))).toEqual(Array.from(before.f));
    expect(world.totalEnergy(RABBIT)).toBeCloseTo(before.er, 2);
    expect(world.totalEnergy(FOX)).toBeCloseTo(before.ef, 2);

    world.setFocus(() => true);
    expect(world.embodied(RABBIT)).toBe(world.count(RABBIT));
    expect(Array.from(world.countByChunk(RABBIT))).toEqual(Array.from(before.r));
    expect(Array.from(world.countByChunk(FOX))).toEqual(Array.from(before.f));
    expect(world.totalEnergy(RABBIT)).toBeCloseTo(before.er, 2);
    expect(world.totalEnergy(FOX)).toBeCloseTo(before.ef, 2);
  }, 120_000);

  it('многократное переключение уровня без хода времени не меняет мир', () => {
    const world = new LodWorld(9, SIZE, SIZE, 'cohort', fp);
    for (let day = 0; day < 20; day++) world.stepDay();
    const rabbits = world.count(RABBIT);
    const foxes = world.count(FOX);
    const energy = world.totalEnergy(RABBIT);
    for (let k = 0; k < 25; k++) world.setFocus((c) => (c + k) % 3 === 0);
    expect(world.count(RABBIT)).toBe(rabbits);
    expect(world.count(FOX)).toBe(foxes);
    expect(world.totalEnergy(RABBIT)).toBeCloseTo(energy, 1);
  }, 120_000);
});

describe('Независимость от наблюдателя', () => {
  it('единая модель: состояние мира побитно одинаково при любой зоне наблюдателя', () => {
    const run = (focus: ((day: number) => (chunk: number) => boolean) | null) => {
      const world = new LodWorld(21, SIZE, SIZE, 'unified', null);
      for (let day = 0; day < 100; day++) {
        if (focus) world.setFocus(focus(day));
        world.stepDay();
      }
      return world.stateHash();
    };
    const reference = run(null);
    expect(run(randomFocus)).toBe(reference);
    expect(run(() => (c) => c % 2 === 0)).toBe(reference);
    expect(run(() => () => true)).toBe(reference);
  }, 120_000);

  it('контроль: в когортном режиме та же проверка не проходит — эффект наблюдателя существует', () => {
    const run = (focus: (day: number) => (chunk: number) => boolean) => {
      const world = new LodWorld(21, SIZE, SIZE, 'cohort', fp);
      for (let day = 0; day < 100; day++) {
        world.setFocus(focus(day));
        world.stepDay();
      }
      return world.stateHash();
    };
    expect(run(randomFocus)).not.toBe(run(() => () => false));
  }, 120_000);

  it('один seed и одна история наблюдателя воспроизводятся точно', () => {
    const run = () => {
      const world = new LodWorld(33, SIZE, SIZE, 'cohort', fp);
      for (let day = 0; day < 60; day++) {
        world.setFocus(randomFocus(day));
        world.stepDay();
      }
      return world.stateHash();
    };
    expect(run()).toBe(run());
  }, 120_000);
});
