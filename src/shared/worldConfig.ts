// Параметры создания мира: задаются игроком в меню, хранятся в манифесте сохранения.
// Один и тот же набор параметров даёт побитно одинаковый мир.

import { DAYS_PER_SEASON, SEASON_LENGTHS } from './time';

export const WORLD_SIZES = {
  /** Малый мир 2 × 2 км. */
  S: 2048,
  /** Средний мир 4 × 4 км — размер по умолчанию (ARCHITECTURE.md, раздел 5). */
  M: 4096,
} as const;
export type WorldSizeName = keyof typeof WORLD_SIZES;

export const CLIMATES = ['cold', 'temperate', 'warm'] as const;
export type ClimateName = (typeof CLIMATES)[number];

export const CLIMATE_LABELS: Record<ClimateName, string> = {
  cold: 'Холодный',
  temperate: 'Умеренный',
  warm: 'Тёплый',
};

export interface WorldConfig {
  /** Имя мира, видимое игроку. На генерацию не влияет. */
  name: string;
  seed: number;
  size: WorldSizeName;
  /** Длина сезона в игровых сутках. */
  daysPerSeason: number;
  climate: ClimateName;
}

export const DEFAULT_CONFIG: WorldConfig = {
  name: 'Новый мир',
  seed: 1,
  size: 'M',
  daysPerSeason: DAYS_PER_SEASON,
  climate: 'temperate',
};

/** Проверка и нормализация: в мир попадают только допустимые значения. */
export function normalizeConfig(config: Partial<WorldConfig>): WorldConfig {
  const size = config.size === 'S' || config.size === 'M' ? config.size : DEFAULT_CONFIG.size;
  const days = (SEASON_LENGTHS as readonly number[]).includes(config.daysPerSeason ?? -1) ? config.daysPerSeason! : DEFAULT_CONFIG.daysPerSeason;
  const climate = (CLIMATES as readonly string[]).includes(config.climate ?? '') ? config.climate! : DEFAULT_CONFIG.climate;
  const name = (config.name ?? '').trim().slice(0, 40) || DEFAULT_CONFIG.name;
  return { name, seed: (config.seed ?? DEFAULT_CONFIG.seed) >>> 0, size, daysPerSeason: days, climate };
}

/** Размер эко-ячейки, м (ARCHITECTURE.md, раздел 5). */
export const CELL_SIZE = 8;
/** Шаг отсчётов высоты, м. */
export const HEIGHT_SPACING = 2;
/** Сторона чанка, м. */
export const CHUNK_SIZE = 128;
/** Уровень моря, м. */
export const SEA_LEVEL = 0;
