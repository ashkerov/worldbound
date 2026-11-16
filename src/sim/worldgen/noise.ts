// Детерминированный градиентный шум для генерации мира. Таблица перестановок строится из seed
// целочисленным ГПСЧ; дальше только + − × и Math.floor — результат побитно одинаков в любом движке JS
// (ARCHITECTURE.md, раздел 6.4).

import { Rng, hash4 } from '../../shared/rng';

// 16 направлений градиента. Константы — точные литералы, тригонометрия не вызывается.
const GX = new Float64Array([1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834, 0, 0.3826834, 0.7071068, 0.9238795]);
const GY = new Float64Array([0, 0.3826834, 0.7071068, 0.9238795, 1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834]);

const SIZE = 1024;
const MASK = SIZE - 1;

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Один слой градиентного шума с собственной таблицей перестановок (период 1024 узла решётки). */
export class Noise2 {
  private readonly perm = new Uint16Array(SIZE * 2);

  constructor(seed: number, layer: number) {
    const rng = new Rng(seed, 0x51ed + layer);
    const p = new Uint16Array(SIZE);
    for (let i = 0; i < SIZE; i++) p[i] = i;
    for (let i = SIZE - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < SIZE * 2; i++) this.perm[i] = p[i & MASK]!;
  }

  /** Значение примерно в [−0.7, 0.7]. */
  at(x: number, z: number): number {
    const fx0 = Math.floor(x);
    const fz0 = Math.floor(z);
    const fx = x - fx0;
    const fz = z - fz0;
    const ix = fx0 & MASK;
    const iz = fz0 & MASK;
    const perm = this.perm;
    const a = perm[ix]!;
    const b = perm[ix + 1]!;
    const g00 = perm[a + iz]! & 15;
    const g10 = perm[b + iz]! & 15;
    const g01 = perm[a + iz + 1]! & 15;
    const g11 = perm[b + iz + 1]! & 15;
    const u = fade(fx);
    const v = fade(fz);
    const n00 = GX[g00]! * fx + GY[g00]! * fz;
    const n10 = GX[g10]! * (fx - 1) + GY[g10]! * fz;
    const n01 = GX[g01]! * fx + GY[g01]! * (fz - 1);
    const n11 = GX[g11]! * (fx - 1) + GY[g11]! * (fz - 1);
    const ab = n00 + (n10 - n00) * u;
    const cd = n01 + (n11 - n01) * u;
    return ab + (cd - ab) * v;
  }
}

/** Фрактальная сумма октав, примерно в [−1, 1]. Решётка поворачивается между октавами — сетка не видна. */
export class Fbm {
  private readonly layers: Noise2[] = [];
  private readonly norm: number;

  constructor(
    seed: number,
    layer: number,
    readonly octaves: number,
    private readonly gain = 0.5,
  ) {
    let norm = 0;
    let amp = 1;
    for (let o = 0; o < octaves; o++) {
      this.layers.push(new Noise2(seed, layer * 31 + o));
      norm += amp;
      amp *= gain;
    }
    this.norm = norm;
  }

  at(x: number, z: number): number {
    let sum = 0;
    let amp = 1;
    let fx = x;
    let fz = z;
    for (let o = 0; o < this.octaves; o++) {
      sum += this.layers[o]!.at(fx, fz) * amp;
      amp *= this.gain;
      const nx = fx * 1.6 + fz * 1.2;
      const nz = -fx * 1.2 + fz * 1.6;
      fx = nx + 17.3;
      fz = nz - 9.1;
    }
    return (sum / this.norm) * 1.45;
  }
}

/** Гребневой шум для горных хребтов, [0, 1]: острые гребни там, где обычный шум пересекает ноль. */
export class Ridged {
  private readonly layers: Noise2[] = [];

  constructor(
    seed: number,
    layer: number,
    readonly octaves: number,
  ) {
    for (let o = 0; o < octaves; o++) this.layers.push(new Noise2(seed, layer * 37 + o + 5000));
  }

  at(x: number, z: number): number {
    let sum = 0;
    let amp = 0.5;
    let weight = 1;
    let norm = 0;
    let fx = x;
    let fz = z;
    for (let o = 0; o < this.octaves; o++) {
      let n = this.layers[o]!.at(fx, fz) * 1.4;
      n = 1 - (n < 0 ? -n : n);
      n *= n;
      n *= weight;
      weight = n * 2 > 1 ? 1 : n * 2;
      sum += n * amp;
      norm += amp;
      amp *= 0.5;
      const nx = fx * 1.6 + fz * 1.2;
      const nz = -fx * 1.2 + fz * 1.6;
      fx = nx + 5.7;
      fz = nz + 11.9;
    }
    return sum / norm;
  }
}

/** Разовая выборка шума без таблицы (для редких вызовов): значение на узлах из хеша. */
export function hashNoise(seed: number, layer: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const g = (cx: number, cz: number, dx: number, dz: number) => {
    const h = hash4(seed, layer, cx, cz) & 15;
    return GX[h]! * dx + GY[h]! * dz;
  };
  const u = fade(fx);
  const v = fade(fz);
  const ab = g(ix, iz, fx, fz) + (g(ix + 1, iz, fx - 1, fz) - g(ix, iz, fx, fz)) * u;
  const cd = g(ix, iz + 1, fx, fz - 1) + (g(ix + 1, iz + 1, fx - 1, fz - 1) - g(ix, iz + 1, fx, fz - 1)) * u;
  return ab + (cd - ab) * v;
}
