// Отклик вида на условия: общие функции для роста, приживания, начального заселения и слоя пригодности.
// Одна формула на всё: слой «пригодность для вида» показывает ровно то, по чему вид растёт в симуляции.

import { SOILS } from '../env/soils';
import type { SpeciesTable } from './species';

/** Трапеция: 0 вне [a, d], 1 на [b, c], линейно между. */
export function trapezoid(v: number, a: number, b: number, c: number, d: number): number {
  if (v <= a || v >= d) return 0;
  if (v < b) return (v - a) / (b - a);
  if (v <= c) return 1;
  return (d - v) / (d - c);
}

export function tempResponse(t: SpeciesTable, s: number, temperature: number): number {
  return trapezoid(temperature, t.tMin[s]!, t.tOptMin[s]!, t.tOptMax[s]!, t.tMax[s]!);
}

export function moistureResponse(t: SpeciesTable, s: number, moistureRel: number): number {
  // Верхний край трапеции может лежать выше 1 (переносит насыщение) — тогда при полной влаге отклик 1.
  return trapezoid(moistureRel, t.wMin[s]!, t.wOptMin[s]!, t.wOptMax[s]!, t.wMax[s]! + 1e-9);
}

/** Свет: 1, если света хватает виду; иначе пропорционально нехватке. */
export function lightResponse(t: SpeciesTable, s: number, light: number): number {
  const need = t.lightNeed[s]!;
  return light >= need ? 1 : light / need;
}

/** Элемент питания: насыщающий отклик на доступный запас, г/м². */
export function nutrientResponse(t: SpeciesTable, s: number, available: number): number {
  return available / (available + t.nutrientHalf[s]!);
}

export function soilResponse(t: SpeciesTable, s: number, soil: number): number {
  return t.soil[s * SOILS.length + soil]!;
}

/**
 * Пригодность условий для вида 0..1 при среднегодовых условиях вегетационного сезона:
 * используется для начального заселения, колонизации и слоя пригодности.
 */
export function suitability(t: SpeciesTable, s: number, growingTemp: number, moistureRel: number, light: number, nutrient: number, soil: number): number {
  return tempResponse(t, s, growingTemp) * moistureResponse(t, s, moistureRel) * lightResponse(t, s, light) * (0.4 + 0.6 * nutrientResponse(t, s, nutrient)) * soilResponse(t, s, soil);
}
