// Детерминированная математика: результат побитно одинаков в любом движке JS.
// Используются только + − × /, Math.floor и Math.sqrt (последние два по стандарту IEEE 754
// дают точный результат). Math.sin/cos/exp/pow различаются между движками и в генерации мира
// и ядре симуляции не применяются (ARCHITECTURE.md, раздел 6.4).

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/** Синус: приведение к [−π/2, π/2] и ряд Тейлора до x¹³ (погрешность < 1e−9). */
export function dsin(x: number): number {
  // Приведение к [−π, π].
  let r = x - TWO_PI * Math.floor((x + PI) / TWO_PI);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const r2 = r * r;
  return (
    r *
    (1 +
      r2 *
        (-1 / 6 +
          r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800)))))))
  );
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Гладкая ступень Эрмита: 0 при x ≤ e0, 1 при x ≥ e1 (e0 может быть больше e1). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Ограниченная «экспонента затухания» без Math.exp: 1/(1 + x + x²/2) — монотонна, 1 при 0. */
export function decay(x: number): number {
  return 1 / (1 + x + 0.5 * x * x);
}
