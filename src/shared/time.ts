// Шкала времени (ARCHITECTURE.md, раздел 7). Стартовые значения, требуют плейтеста.
// Длина сезона — настройка мира (DEVELOPMENT_PLAN.md, решение №3); остальное — константы.

/** Реальная длительность такта на скорости ×1, мс. */
export const TICK_MS = 100;
export const TICKS_PER_HOUR = 300;
export const HOURS_PER_DAY = 24;
export const TICKS_PER_DAY = TICKS_PER_HOUR * HOURS_PER_DAY;
/** Длина сезона по умолчанию, игровых суток. */
export const DAYS_PER_SEASON = 5;
export const SEASONS_PER_YEAR = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR;
/** Допустимые длины сезона в настройках мира. */
export const SEASON_LENGTHS = [3, 5, 8] as const;
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

export function calendarFromTick(tick: number, daysPerSeason: number = DAYS_PER_SEASON): Calendar {
  const daysPerYear = daysPerSeason * SEASONS_PER_YEAR;
  const day = Math.floor(tick / TICKS_PER_DAY);
  const tickOfDay = tick - day * TICKS_PER_DAY;
  const minutes = Math.floor((tickOfDay * HOURS_PER_DAY * 60) / TICKS_PER_DAY);
  const dayOfYear = day % daysPerYear;
  return {
    year: Math.floor(day / daysPerYear) + 1,
    season: Math.floor(dayOfYear / daysPerSeason),
    dayOfSeason: (dayOfYear % daysPerSeason) + 1,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  };
}

/** Доля суток [0, 1) — 0 в полночь. Дробный такт допустим (интерполяция в рендере). */
export function dayFraction(tick: number): number {
  const t = tick / TICKS_PER_DAY;
  return t - Math.floor(t);
}

/** Доля года [0, 1) — 0 в начале весны. */
export function yearFraction(tick: number, daysPerSeason: number): number {
  const t = tick / (TICKS_PER_DAY * daysPerSeason * SEASONS_PER_YEAR);
  return t - Math.floor(t);
}

/** Игровых часов в году при данной длине сезона. */
export function hoursPerYear(daysPerSeason: number): number {
  return daysPerSeason * SEASONS_PER_YEAR * HOURS_PER_DAY;
}
