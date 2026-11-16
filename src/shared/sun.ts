// Положение солнца: одна функция для симуляции (освещённость ячеек) и рендера (небо, свет).
// Ось X — восток, Y — вверх, Z — юг. Солнце встаёт на востоке, в полдень стоит на юге.
// Длина дня зависит от сезона: летом солнце выше и дольше над горизонтом.

import { TWO_PI, dcos, dsin } from './dmath';

/** Склонение (в долях наклона): +1 в середине лета, −1 в середине зимы. Год начинается с весны. */
export function seasonalSwing(yearFrac: number): number {
  return dcos(TWO_PI * (yearFrac - 0.375));
}

export interface SunState {
  x: number;
  y: number;
  z: number;
}

/**
 * Направление на солнце (единичный вектор). Модель: широта ~50°, наклон оси ~23°.
 * Высота в полдень: летом ≈ 63°, зимой ≈ 17°; длина дня ≈ 16 ч летом и ≈ 8 ч зимой.
 */
export function sunDirection(dayFrac: number, yearFrac: number, out: SunState = { x: 0, y: 1, z: 0 }): SunState {
  const decl = 0.401 * seasonalSwing(yearFrac); // рад
  const lat = 0.873; // 50°
  const hourAngle = TWO_PI * (dayFrac - 0.5);
  const sinDecl = dsin(decl);
  const cosDecl = dcos(decl);
  const sinLat = dsin(lat);
  const cosLat = dcos(lat);
  // Горизонтальная система: up = sinLat·sinDecl + cosLat·cosDecl·cosH.
  const up = sinLat * sinDecl + cosLat * cosDecl * dcos(hourAngle);
  const east = -cosDecl * dsin(hourAngle);
  const north = cosLat * sinDecl - sinLat * cosDecl * dcos(hourAngle);
  const len = Math.sqrt(up * up + east * east + north * north) || 1;
  out.x = east / len;
  out.y = up / len;
  out.z = -north / len;
  return out;
}
