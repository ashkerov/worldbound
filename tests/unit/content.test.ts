// Каталоги контента: все проходят схемы, а схемы ловят типичные ошибки.

import { describe, expect, it } from 'vitest';
import plantsRaw from '../../content/plants/plants.json' with { type: 'json' };
import { CatalogError } from '../../src/sim/content/schema';
import { SOILS } from '../../src/sim/env/soils';
import { BIOMES, classifyBiome, loadBiomes } from '../../src/sim/flora/biomes';
import { PLANTS, SPECIES, loadPlants } from '../../src/sim/flora/species';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('Каталоги проходят схемы', () => {
  it('почвы, растения, биомы', () => {
    expect(SOILS.length).toBeGreaterThanOrEqual(6);
    expect(PLANTS.length).toBe(18);
    expect(PLANTS.filter((p) => p.form === 'tree').length).toBeGreaterThanOrEqual(4);
    expect(PLANTS.filter((p) => p.form === 'shrub').length).toBeGreaterThanOrEqual(3);
    expect(PLANTS.filter((p) => p.form === 'herb').length).toBeGreaterThanOrEqual(5);
    expect(BIOMES.at(-1)!.id).toBe('barren');
    expect(SPECIES.count).toBe(PLANTS.length);
  });
});

describe('Схема видов отклоняет ошибки', () => {
  const base = plantsRaw as { plants: Record<string, unknown>[] };
  const withPlant = (mutate: (p: Record<string, unknown>) => void, index = 12) => {
    const raw = clone(base);
    mutate(raw.plants[index]!);
    return () => loadPlants(raw);
  };

  it('неизвестное поле (опечатка)', () => {
    expect(withPlant((p) => (p.growtRate = 1))).toThrow(/неизвестное поле/);
  });
  it('значение вне диапазона', () => {
    expect(withPlant((p) => (p.shadeTolerance = 1.5))).toThrow(/вне диапазона/);
  });
  it('нарушен порядок трапеции условий', () => {
    expect(withPlant((p) => ((p.temperature as Record<string, number>).optMin = 40))).toThrow(/min ≤ optMin/);
  });
  it('у дерева нет обязательных полей древесных', () => {
    expect(withPlant((p) => delete p.dispersal)).toThrow(/обязательно поле dispersal/);
  });
  it('дерево с отмиранием до корня', () => {
    expect(withPlant((p) => (p.leafHabit = 'annualDieback'))).toThrow(/древесные/);
  });
  it('неизвестная почва в предпочтениях', () => {
    expect(withPlant((p) => (p.soilPreference = { lava: 1 }))).toThrow(/неизвестный ключ/);
  });
  it('повтор идентификатора', () => {
    const raw = clone(base);
    raw.plants[1]!.id = raw.plants[0]!.id;
    expect(() => loadPlants(raw)).toThrow(/повтор id/);
  });
  it('ошибка называет файл и запись', () => {
    try {
      withPlant((p) => (p.maxHeight = -1))();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogError);
      expect(String(e)).toMatch(/content\/plants\/plants\.json, запись 12 \(birch\)\.maxHeight/);
    }
  });
});

describe('Биомы', () => {
  it('последний биом — без условий', () => {
    expect(() => loadBiomes({ biomes: [{ id: 'a', name: 'А', color: '#000000', rule: { treeCoverMin: 0.5 } }] })).toThrow(/последний биом/);
  });

  it('классификатор работает по фактическим показателям', () => {
    const land = { water: 0, treeCover: 0, shrubCover: 0, herbBiomass: 0, coniferShare: 0, tMean: 8, moisture: 0.5 };
    const id = (c: typeof land) => BIOMES[classifyBiome(c)]!.id;
    expect(id({ ...land, water: 2 })).toBe('water');
    expect(id(land)).toBe('barren');
    expect(id({ ...land, herbBiomass: 300 })).toBe('meadow');
    expect(id({ ...land, herbBiomass: 120, moisture: 0.2 })).toBe('steppe');
    expect(id({ ...land, treeCover: 0.7, coniferShare: 0.9 })).toBe('coniferous-forest');
    expect(id({ ...land, treeCover: 0.7, coniferShare: 0.1 })).toBe('broadleaf-forest');
    expect(id({ ...land, treeCover: 0.7, coniferShare: 0.5 })).toBe('mixed-forest');
    expect(id({ ...land, treeCover: 0.3 })).toBe('woodland');
    expect(id({ ...land, shrubCover: 0.4 })).toBe('shrubland');
    expect(id({ ...land, moisture: 0.95, herbBiomass: 200 })).toBe('bog');
  });
});
