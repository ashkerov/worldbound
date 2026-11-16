// Каталог почв (content/soils/soils.json) со схемой и проверкой при загрузке.
// Симуляция видит только числовой идентификатор типа (индекс записи) и параметры.

import catalog from '../../../content/soils/soils.json' with { type: 'json' };
import { ID_PATTERN, validateCatalog, type CatalogSchema } from '../content/schema';

export interface SoilType {
  id: string;
  name: string;
  /** Полевая влагоёмкость корнеобитаемого слоя, мм воды. */
  fieldCapacityMm: number;
  /** Доля запаса влаги, уходящая в глубину и подземный сток за игровые сутки при насыщении. */
  drainagePerDay: number;
  /** Базовое плодородие 0..1. */
  fertility: number;
}

export const SOILS_SCHEMA: CatalogSchema = {
  file: 'content/soils/soils.json',
  listField: 'soils',
  maxEntries: 255,
  entry: {
    id: { kind: 'string', pattern: ID_PATTERN },
    name: { kind: 'string' },
    fieldCapacityMm: { kind: 'number', min: 5, max: 1000 },
    drainagePerDay: { kind: 'number', min: 0, max: 1 },
    fertility: { kind: 'number', min: 0, max: 1 },
  },
};

export const SOILS: readonly SoilType[] = validateCatalog<SoilType>(SOILS_SCHEMA, catalog);

export function soilIndex(id: string): number {
  const i = SOILS.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`Нет почвы ${id}`);
  return i;
}

export const SOIL = {
  rock: soilIndex('rock'),
  sand: soilIndex('sand'),
  loam: soilIndex('loam'),
  clay: soilIndex('clay'),
  alluvial: soilIndex('alluvial'),
  peat: soilIndex('peat'),
} as const;
