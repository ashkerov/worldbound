import { describe, expect, it } from 'vitest';
import { Rng, counterRandom, hash4, seedFromString } from '../../src/shared/rng';
import { EntityKind, MAX_INDEX, idGeneration, idIndex, idKind, makeId } from '../../src/shared/ids';
import { DAYS_PER_YEAR, TICKS_PER_DAY, TICKS_PER_HOUR, calendarFromTick } from '../../src/shared/time';

describe('ГПСЧ', () => {
  it('hash4 — эталонные значения не меняются между запусками и версиями', () => {
    // Зафиксированные значения: изменение алгоритма сломает все сохранённые миры.
    expect([hash4(0, 0, 0, 0), hash4(1, 2, 3, 4), hash4(42, 7, -1, 100000)]).toMatchInlineSnapshot(`
      [
        937260802,
        3347682281,
        478758685,
      ]
    `);
  });

  it('счётчиковый генератор зависит только от аргументов и лежит в [0, 1)', () => {
    const a = counterRandom(42, 1, 1000, 77);
    expect(counterRandom(42, 1, 1000, 77)).toBe(a);
    expect(counterRandom(42, 1, 1001, 77)).not.toBe(a);
    expect(counterRandom(42, 2, 1000, 77)).not.toBe(a);
    expect(counterRandom(43, 1, 1000, 77)).not.toBe(a);
    for (let i = 0; i < 10000; i++) {
      const v = counterRandom(7, 3, i, i * 13);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('счётчиковый генератор распределён равномерно', () => {
    const buckets = new Array<number>(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) buckets[Math.floor(counterRandom(99, 5, i, 0) * 10)]!++;
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n * 0.01);
  });

  it('потоковый генератор воспроизводим и потоки независимы', () => {
    const a = new Rng(123, 0);
    const b = new Rng(123, 0);
    const c = new Rng(123, 1);
    const seqA = Array.from({ length: 50 }, () => a.nextU32());
    const seqB = Array.from({ length: 50 }, () => b.nextU32());
    const seqC = Array.from({ length: 50 }, () => c.nextU32());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('int и range остаются в границах', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 10000; i++) {
      const n = rng.int(7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
      const r = rng.range(-2, 3);
      expect(r).toBeGreaterThanOrEqual(-2);
      expect(r).toBeLessThan(3);
    }
  });

  it('строковый seed стабилен', () => {
    expect(seedFromString('worldbound')).toBe(seedFromString('worldbound'));
    expect(seedFromString('worldbound')).not.toBe(seedFromString('Worldbound'));
  });
});

describe('Идентификаторы сущностей', () => {
  it('упаковка и распаковка обратимы на границах диапазонов', () => {
    for (const kind of [EntityKind.Tree, EntityKind.Animal, EntityKind.Person, EntityKind.TestAgent]) {
      for (const generation of [0, 1, 255]) {
        for (const index of [0, 1, 12345, MAX_INDEX]) {
          const id = makeId(kind, generation, index);
          expect(idKind(id)).toBe(kind);
          expect(idGeneration(id)).toBe(generation);
          expect(idIndex(id)).toBe(index);
          expect(id).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('индекс вне диапазона отклоняется', () => {
    expect(() => makeId(EntityKind.Animal, 0, MAX_INDEX + 1)).toThrow(RangeError);
    expect(() => makeId(EntityKind.Animal, 0, -1)).toThrow(RangeError);
  });
});

describe('Календарь', () => {
  it('нулевой такт — начало первого года', () => {
    expect(calendarFromTick(0)).toEqual({ year: 1, season: 0, dayOfSeason: 1, hour: 0, minute: 0 });
  });

  it('часы, сутки, сезоны и годы переключаются на своих границах', () => {
    expect(calendarFromTick(TICKS_PER_HOUR * 13 + TICKS_PER_HOUR / 2)).toMatchObject({ hour: 13, minute: 30 });
    expect(calendarFromTick(TICKS_PER_DAY - 1)).toMatchObject({ dayOfSeason: 1, hour: 23, minute: 59 });
    expect(calendarFromTick(TICKS_PER_DAY)).toMatchObject({ dayOfSeason: 2, hour: 0 });
    expect(calendarFromTick(TICKS_PER_DAY * 5)).toMatchObject({ season: 1, dayOfSeason: 1 });
    expect(calendarFromTick(TICKS_PER_DAY * DAYS_PER_YEAR - 1)).toMatchObject({ year: 1, season: 3, dayOfSeason: 5 });
    expect(calendarFromTick(TICKS_PER_DAY * DAYS_PER_YEAR)).toMatchObject({ year: 2, season: 0, dayOfSeason: 1 });
  });
});
