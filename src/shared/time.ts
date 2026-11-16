// Шкала времени (ARCHITECTURE.md, раздел 7). Стартовые значения, требуют плейтеста.

/** Реальная длительность такта на скорости ×1, мс. */
export const TICK_MS = 100;
export const TICKS_PER_HOUR = 300;
export const HOURS_PER_DAY = 24;
export const TICKS_PER_DAY = TICKS_PER_HOUR * HOURS_PER_DAY;
export const DAYS_PER_SEASON = 5;
export const SEASONS_PER_YEAR = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR;
/** Игровых секунд в одном такте. */
export const GAME_SECONDS_PER_TICK = (HOURS_PER_DAY * 3600) / TICKS_PER_DAY;
/** Реальных секунд симуляции в одном такте (для скоростей движения в м/с). */
export const TICK_SECONDS = TICK_MS / 1000;

export const SPEEDS = [0, 1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

export const SEASON_NAMES = ['Весна', 'Лето', 'Осень', 'Зима'] as const;

export interface Calendar {
  year: number;
  season: number;
  dayOfSeason: number;
  hour: number;
  minute: number;
}

export function calendarFromTick(tick: number): Calendar {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const tickOfDay = tick - day * TICKS_PER_DAY;
  const minutes = Math.floor((tickOfDay * HOURS_PER_DAY * 60) / TICKS_PER_DAY);
  const dayOfYear = day % DAYS_PER_YEAR;
  return {
    year: Math.floor(day / DAYS_PER_YEAR) + 1,
    season: Math.floor(dayOfYear / DAYS_PER_SEASON),
    dayOfSeason: (dayOfYear % DAYS_PER_SEASON) + 1,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  };
}
