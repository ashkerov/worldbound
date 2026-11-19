// Инструменты процедурной геометрии растений (собственная работа проекта; приёмы — из прототипа 1A,
// prototypes/diorama/flora.ts). Атрибуты вершин:
//   position, normal, color (цвет вершины), uv (текстура листвы),
//   extra = (sway, part, rnd) — одним буфером (у WebGPU не больше 8 вершинных буферов на конвейер):
//     sway — амплитуда качания на ветру (растёт от основания к концам ветвей),
//     part — 0 древесина, 1 листва или хвоя, 2 цветки или плоды,
//     rnd — случайное число карточки (0..1): по нему карточки листвы появляются и опадают по облиственности.

import * as THREE from 'three/webgpu';

export type ColorSource = THREE.Color | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color);
export type SwaySource = number | ((p: THREE.Vector3) => number);

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const UP = new THREE.Vector3(0, 1, 0);

/** Детерминированное случайное число 0..1 из целых аргументов. */
export function rand(...k: number[]): number {
  let h = 2166136261;
  for (const v of k) {
    h = Math.imul(h ^ (v | 0), 16777619);
    h = Math.imul(h ^ (h >>> 15), 2246822507);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Гладкий шум 0..1 на плоскости (для цвета коры). */
export function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = rand(seed, xi, yi);
  const b = rand(seed, xi + 1, yi);
  const c = rand(seed, xi, yi + 1);
  const d = rand(seed, xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
export const C = (hex: number) => new THREE.Color(hex);

export class GeoBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uvs: number[] = [];
  private readonly sway: number[] = [];
  private readonly part: number[] = [];
  private readonly rnd: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** Добавляет готовую геометрию (ветвь, ягода) целиком. */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: ColorSource, sway: SwaySource = 0, part = 0, rnd = 0): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = g.getAttribute('position');
    const normal = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    _nm.getNormalMatrix(matrix);
    for (let i = 0; i < position.count; i++) {
      _p.fromBufferAttribute(position, i).applyMatrix4(matrix);
      _n.fromBufferAttribute(normal, i).applyMatrix3(_nm).normalize();
      const c = typeof color === 'function' ? color(_p, _n) : color;
      this.pos.push(_p.x, _p.y, _p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.col.push(c.r, c.g, c.b);
      this.uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      this.sway.push(typeof sway === 'function' ? sway(_p) : sway);
      this.part.push(part);
      this.rnd.push(rnd);
    }
    if (g !== geometry) g.dispose();
    geometry.dispose();
    return this;
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3, colors: [THREE.Color, THREE.Color, THREE.Color], uv: [number, number, number, number, number, number], sway: [number, number, number], part = 1, rnd = 0): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.nor.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    for (const k of colors) this.col.push(k.r, k.g, k.b);
    this.uvs.push(...uv);
    this.sway.push(...sway);
    this.part.push(part, part, part);
    this.rnd.push(rnd, rnd, rnd);
  }

  /**
   * Листовая карточка: квадрат с центром centre в плоскости (right, up). Нормаль затенения общая (shade) —
   * карточки кроны освещаются как единый объём. uv — область атласа [u0, v0, u1, v1].
   */
  card(centre: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, shade: THREE.Vector3, low: THREE.Color, high: THREE.Color, swayLow: number, swayHigh: number, rnd: number, part = 1, uv: [number, number, number, number] = [0, 0, 1, 1]): void {
    const a = centre.clone().sub(right).sub(up);
    const b = centre.clone().add(right).sub(up);
    const c = centre.clone().add(right).add(up);
    const d = centre.clone().sub(right).add(up);
    const [u0, v0, u1, v1] = uv;
    this.tri(a, b, c, shade, [low, low, high], [u0, v0, u1, v0, u1, v1], [swayLow, swayLow, swayHigh], part, rnd);
    this.tri(a, c, d, shade, [low, high, high], [u0, v0, u1, v1, u0, v1], [swayLow, swayHigh, swayHigh], part, rnd);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    const extra = new Float32Array(this.sway.length * 3);
    for (let i = 0; i < this.sway.length; i++) {
      extra[i * 3] = this.sway[i]!;
      extra[i * 3 + 1] = this.part[i]!;
      extra[i * 3 + 2] = this.rnd[i]!;
    }
    g.setAttribute('extra', new THREE.Float32BufferAttribute(extra, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Ветвь переменной толщины вдоль кривой (сечение — sides граней). */
export function limb(points: THREE.Vector3[], r0: number, r1: number, sides: number, flare = 0, steps = 0): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const n = steps > 0 ? steps : Math.max(3, points.length * 2);
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const tangent = V(0, 1, 0);
  const side = V(1, 0, 0);
  const forward = V(0, 0, 1);
  const X = V(1, 0, 0);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const centre = curve.getPoint(t);
    curve.getTangent(t, tangent);
    side.crossVectors(tangent, Math.abs(tangent.y) > 0.95 ? X : UP).normalize();
    forward.crossVectors(side, tangent).normalize();
    const r = (r0 + (r1 - r0) * t) * (1 + flare * Math.max(0, 1 - t * 9) ** 2);
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const nx = side.x * Math.cos(a) + forward.x * Math.sin(a);
      const ny = side.y * Math.cos(a) + forward.y * Math.sin(a);
      const nz = side.z * Math.cos(a) + forward.z * Math.sin(a);
      pos.push(centre.x + nx * r, centre.y + ny * r, centre.z + nz * r);
      nor.push(nx, ny, nz);
      uvs.push(k / sides, t);
    }
    if (i > 0) {
      const a = (i - 1) * (sides + 1);
      const b = i * (sides + 1);
      for (let k = 0; k < sides; k++) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

export interface CrownStyle {
  seed: number;
  cards: number;
  size: number;
  base: THREE.Color;
  sunlit: THREE.Color;
  bottom: number;
  top: number;
  centre: THREE.Vector3;
  /** Область атласа листвы. */
  uv: [number, number, number, number];
  /** Сплющивание карточек по вертикали (хвоя, перистые листья). */
  aspect?: number;
}

/** Облако листовых карточек на поверхности эллипсоида. */
export function blob(b: GeoBuilder, centre: THREE.Vector3, radii: THREE.Vector3, style: CrownStyle, index: number): void {
  const dir = V(0, 0, 0);
  const point = V(0, 0, 0);
  const right = V(0, 0, 0);
  const up = V(0, 0, 0);
  const shade = V(0, 0, 0);
  const tmp = V(0, 0, 0);
  const col = new THREE.Color();
  for (let k = 0; k < style.cards; k++) {
    const u = rand(style.seed, index, k, 1) * Math.PI * 2;
    const y = rand(style.seed, index, k, 2) * 1.45 - 0.45;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    dir.set(Math.cos(u) * r, y, Math.sin(u) * r);
    const depth = 0.7 + rand(style.seed, index, k, 3) * 0.32;
    point.set(centre.x + dir.x * radii.x * depth, centre.y + dir.y * radii.y * depth, centre.z + dir.z * radii.z * depth);
    tmp.set(rand(style.seed, index, k, 4) - 0.5, rand(style.seed, index, k, 5) - 0.5, rand(style.seed, index, k, 6) - 0.5);
    right.crossVectors(dir, tmp).normalize();
    up.crossVectors(right, dir).add(tmp.set(0, 0.55, 0)).normalize();
    const size = style.size * (0.75 + rand(style.seed, index, k, 7) * 0.5);
    right.multiplyScalar(size);
    up.multiplyScalar(size * (style.aspect ?? 1));
    shade.copy(point).sub(style.centre).normalize().add(tmp.set(0, 0.35, 0)).normalize();
    const h = THREE.MathUtils.clamp((point.y - style.bottom) / (style.top - style.bottom), 0, 1);
    const light = (0.55 + 0.55 * h) * (0.8 + 0.2 * depth) * (0.9 + rand(style.seed, index, k, 8) * 0.2);
    col.copy(style.base).lerp(style.sunlit, h * 0.6 + rand(style.seed, index, k, 9) * 0.22).multiplyScalar(light);
    const sway = 0.05 + h * 0.12;
    b.card(point, right, up, shade, col.clone().multiplyScalar(0.84), col.clone().multiplyScalar(1.06), sway, sway * 1.5, rand(style.seed, index, k, 10), 1, style.uv);
  }
}
