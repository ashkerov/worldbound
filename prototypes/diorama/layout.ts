// Планировка диорамы 150×150 м: рельеф, русло реки, тропа, площадка дома.
// Чистая математика без three — одна и та же функция высоты используется рельефом,
// расстановкой растений, существами и камерой.

import { hash4 } from '../../src/shared/rng';

export const HALF = 75;
const INV = 1 / 4294967296;

export const rand = (seed: number, a: number, b = 0, c = 0): number => hash4(seed, a, b, c) * INV;

const smooth = (t: number) => t * t * (3 - 2 * t);
export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const smoothstep = (a: number, b: number, x: number) => smooth(clamp01((x - a) / (b - a)));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Значащий шум 0..1. */
export function noise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const tz = smooth(z - iz);
  const a = hash4(seed, 0, ix, iz) * INV;
  const b = hash4(seed, 0, ix + 1, iz) * INV;
  const c = hash4(seed, 0, ix, iz + 1) * INV;
  const d = hash4(seed, 0, ix + 1, iz + 1) * INV;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** Фрактальный шум примерно в диапазоне −1..1. */
export function fbm(seed: number, x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (noise2(seed + o, x, z) - 0.5) * 2 * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    z *= 2.03;
  }
  return sum / norm;
}

/** Ломаная, построенная по сплайну Катмулла — Рома; параметр s — длина дуги. */
export class Polyline {
  readonly xs: number[] = [];
  readonly zs: number[] = [];
  readonly cum: number[] = [];
  readonly length: number;

  constructor(control: [number, number][], perSegment = 10) {
    const p = (i: number) => control[Math.max(0, Math.min(control.length - 1, i))]!;
    for (let i = 0; i < control.length - 1; i++) {
      const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
      for (let k = 0; k < perSegment; k++) {
        const t = k / perSegment;
        const t2 = t * t;
        const t3 = t2 * t;
        const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        this.xs.push(f(p0[0], p1[0], p2[0], p3[0]));
        this.zs.push(f(p0[1], p1[1], p2[1], p3[1]));
      }
    }
    const last = control[control.length - 1]!;
    this.xs.push(last[0]);
    this.zs.push(last[1]);
    let total = 0;
    this.cum.push(0);
    for (let i = 1; i < this.xs.length; i++) {
      total += Math.hypot(this.xs[i]! - this.xs[i - 1]!, this.zs[i]! - this.zs[i - 1]!);
      this.cum.push(total);
    }
    this.length = total;
  }

  /** Ближайшая точка: расстояние d и длина дуги s. */
  nearest(x: number, z: number): { d: number; s: number } {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < this.xs.length - 1; i++) {
      const ax = this.xs[i]!;
      const az = this.zs[i]!;
      const bx = this.xs[i + 1]! - ax;
      const bz = this.zs[i + 1]! - az;
      const len2 = bx * bx + bz * bz;
      let t = len2 > 0 ? ((x - ax) * bx + (z - az) * bz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + bx * t);
      const dz = z - (az + bz * t);
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bestS = this.cum[i]! + Math.sqrt(len2) * t;
      }
    }
    return { d: Math.sqrt(best), s: bestS };
  }

  /** Точка и единичная касательная на длине дуги s. */
  at(s: number): { x: number; z: number; tx: number; tz: number } {
    s = Math.max(0, Math.min(this.length, s));
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1]! < s) i++;
    const seg = this.cum[i + 1]! - this.cum[i]! || 1;
    const t = (s - this.cum[i]!) / seg;
    const dx = this.xs[i + 1]! - this.xs[i]!;
    const dz = this.zs[i + 1]! - this.zs[i]!;
    const len = Math.hypot(dx, dz) || 1;
    return { x: this.xs[i]! + dx * t, z: this.zs[i]! + dz * t, tx: dx / len, tz: dz / len };
  }
}

// ───────── плато и скальный срез ─────────

const CLIFF_A: [number, number] = [-75, 8];
const CLIFF_DIR: [number, number] = [0.746, -0.666];
const CLIFF_N: [number, number] = [-0.666, -0.746];
void CLIFF_DIR;

/** Знаковое расстояние до линии обрыва: > 0 — плато. */
export function plateauDistance(x: number, z: number): number {
  const s = (x - CLIFF_A[0]) * CLIFF_N[0] + (z - CLIFF_A[1]) * CLIFF_N[1];
  return s + (noise2(31, x / 22, z / 22) - 0.5) * 9 + (noise2(32, x / 6, z / 6) - 0.5) * 1.6;
}

// ───────── река ─────────

export const river = new Polyline(
  [
    [-64, -80],
    [-53, -57],
    [-41, -40],
    [-33, -29],
    [-27, -21],
    [-15, -10],
    [-4, 3],
    [5, 19],
    [19, 33],
    [30, 52],
    [35, 80],
  ],
  12,
);

/** Длина дуги, на которой река пересекает линию обрыва (кромка водопада). */
export const LIP_S = (() => {
  for (let s = 0; s < river.length; s += 0.25) {
    const p = river.at(s);
    if (plateauDistance(p.x, p.z) < 0.8) return s;
  }
  return river.length * 0.3;
})();
export const FOOT_S = LIP_S + 3.2;
export const POOL_S = FOOT_S + 5.5;
export const WATER_UP = 9.9;
export const WATER_LOW = 0.55;

export function waterLevel(s: number): number {
  if (s <= LIP_S) return WATER_UP + (LIP_S - s) * 0.012;
  if (s >= FOOT_S) return WATER_LOW - ((s - FOOT_S) / (river.length - FOOT_S)) * 0.9;
  return mix(WATER_UP, WATER_LOW, (s - LIP_S) / (FOOT_S - LIP_S));
}

export function riverHalfWidth(s: number): number {
  if (s <= LIP_S + 1) return 1.7 + Math.sin(s * 0.21) * 0.25;
  const pool = 5.2 * Math.exp(-(((s - POOL_S) / 6.5) ** 2));
  return 2.5 + Math.sin(s * 0.13) * 0.45 + pool;
}

// ───────── дом, мост, тропа ─────────

export const HOUSE = { x: 31, z: -15, y: 3.0, yaw: -2.35 };

export const BRIDGE_S = POOL_S + 17;
export const bridge = (() => {
  const p = river.at(BRIDGE_S);
  const w = riverHalfWidth(BRIDGE_S) + 2.4;
  // Нормаль к руслу; «восточный» конец — со стороны дома.
  let nx = -p.tz;
  let nz = p.tx;
  if (nx < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { x: p.x, z: p.z, nx, nz, half: w, deck: waterLevel(BRIDGE_S) + 1.25 };
})();

const doorX = HOUSE.x + Math.sin(HOUSE.yaw) * 5.2;
const doorZ = HOUSE.z + Math.cos(HOUSE.yaw) * 5.2;
export const DOOR = { x: doorX, z: doorZ };

export const trail = new Polyline(
  [
    [doorX, doorZ],
    [doorX - 7, doorZ + 3.5],
    [bridge.x + bridge.nx * (bridge.half + 5), bridge.z + bridge.nz * (bridge.half + 5)],
    [bridge.x + bridge.nx * bridge.half, bridge.z + bridge.nz * bridge.half],
    [bridge.x - bridge.nx * bridge.half, bridge.z - bridge.nz * bridge.half],
    [bridge.x - bridge.nx * (bridge.half + 6), bridge.z - bridge.nz * (bridge.half + 6)],
    [-32, 12],
    [-46, 24],
    [-60, 31],
  ],
  10,
);

// ───────── высота рельефа ─────────

export interface Ground {
  h: number;
  /** Расстояние до оси реки и её полуширина в ближайшей точке. */
  riverD: number;
  riverW: number;
  riverS: number;
  water: number;
  /** 0 — низина, 1 — плато. */
  plateau: number;
  trailD: number;
}

export function ground(x: number, z: number): Ground {
  const pd = plateauDistance(x, z);
  const plateau = smoothstep(-2.4, 2.4, pd);
  const low = 1.9 + fbm(11, x / 46, z / 46, 4) * 1.5 + fbm(12, x / 9, z / 9, 2) * 0.12;
  const high = 11.2 + fbm(13, x / 38, z / 38, 4) * 1.6 + smoothstep(8, 60, pd) * 2.2;
  let h = mix(low, high, plateau);

  const hd = Math.hypot(x - HOUSE.x, z - HOUSE.z);
  h = mix(HOUSE.y, h, smoothstep(8.5, 16, hd));

  const { d, s } = river.nearest(x, z);
  const w = riverHalfWidth(s);
  const water = waterLevel(s);
  if (d < w) {
    const k = d / w;
    h = water - 0.22 - 0.8 * (1 - k * k);
  } else {
    const bank = s < LIP_S ? 3.6 : 6.5;
    const k = smoothstep(0, 1, (d - w) / bank);
    h = mix(water + 0.03, Math.max(h, water + 0.03), k);
  }
  const trailD = trail.nearest(x, z).d;
  return { h, riverD: d, riverW: w, riverS: s, water, plateau, trailD };
}

export const heightAt = (x: number, z: number): number => ground(x, z).h;

/** Уклон поверхности: 0 — ровно, 1 — отвесно. */
export function slopeAt(x: number, z: number): number {
  const e = 0.6;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  const ny = (2 * e) / Math.sqrt(dx * dx + dz * dz + 4 * e * e);
  return 1 - ny;
}

// ───────── маршруты существ ─────────

const closed = (pts: [number, number][]): [number, number][] => [...pts, pts[0]!];
/** Замкнутый маршрут оленя-самца по юго-западному лугу. */
export const stagLoop = new Polyline(closed([[-54, 40], [-41, 30], [-27, 33], [-17, 45], [-25, 58], [-42, 62], [-57, 53]]), 12);
/** Маршрут самки с оленёнком — ближе к реке. */
export const doeLoop = new Polyline(closed([[-12, 30], [-2, 40], [4, 54], [-8, 64], [-20, 56], [-22, 40]]), 12);

/** Высота, по которой идут существа: рельеф, а на мосту — настил. */
export function walkHeight(x: number, z: number): number {
  const along = (x - bridge.x) * bridge.nx + (z - bridge.z) * bridge.nz;
  const side = Math.abs(-(x - bridge.x) * bridge.nz + (z - bridge.z) * bridge.nx);
  const h = heightAt(x, z);
  if (side < 1.3 && Math.abs(along) < bridge.half + 0.6) {
    const k = along / bridge.half;
    return Math.max(h, bridge.deck - 0.55 * k * k + 0.12);
  }
  return h;
}

/** Свободно ли место для дерева, куста или камня (не дом, не тропа, не маршрут существ). */
export function isClear(x: number, z: number, margin: number): boolean {
  if (Math.hypot(x - HOUSE.x, z - HOUSE.z) < 8.5 + margin) return false;
  if (trail.nearest(x, z).d < 1.6 + margin) return false;
  if (stagLoop.nearest(x, z).d < 1.2 + margin) return false;
  if (doeLoop.nearest(x, z).d < 1.2 + margin) return false;
  return true;
}
