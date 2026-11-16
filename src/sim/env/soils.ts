// Каталог почв (content/soils/soils.json) с проверкой при загрузке.
// Симуляция видит только числовой идентификатор типа (индекс записи) и параметры.

import catalog from '../../../content/soils/soils.json' with { type: 'json' };

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

function validate(raw: unknown): SoilType[] {
  const soils = (raw as { soils?: unknown }).soils;
  if (!Array.isArray(soils) || soils.length === 0 || soils.length > 255) throw new Error('Каталог почв: нет записей');
  const seen = new Set<string>();
  return soils.map((entry, index) => {
    const s = entry as Partial<SoilType>;
    const where = `Каталог почв, запись ${index}`;
    if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(s.id)) throw new Error(`${where}: неверный id`);
    if (seen.has(s.id)) throw new Error(`${where}: повтор id ${s.id}`);
    seen.add(s.id);
    if (typeof s.name !== 'string' || s.name.length === 0) throw new Error(`${where}: нет имени`);
    const num = (v: unknown, min: number, max: number, field: string): number => {
      if (typeof v !== 'number' || !(v >= min && v <= max)) throw new Error(`${where}: ${field} вне [${min}, ${max}]`);
      return v;
    };
    return {
      id: s.id,
      name: s.name,
      fieldCapacityMm: num(s.fieldCapacityMm, 5, 1000, 'fieldCapacityMm'),
      drainagePerDay: num(s.drainagePerDay, 0, 1, 'drainagePerDay'),
      fertility: num(s.fertility, 0, 1, 'fertility'),
    };
  });
}

export const SOILS: readonly SoilType[] = validate(catalog);

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
