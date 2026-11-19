// Текстуры растительности, нарисованные кодом (собственная работа проекта, без внешних ассетов):
//  • атлас листвы — плитки 256 × 256 в оттенках серого (цвет дают вершины и экземпляры);
//  • атлас импосторов — силуэты деревьев сбоку и сверху, в листве и без неё.

import * as THREE from 'three/webgpu';
import { rand } from './geometry';

/** Плитки атласа листвы (4 × 2). */
export const LEAF_TILE = {
  oak: 0,
  birch: 1,
  linden: 2,
  alder: 3,
  willow: 4,
  spruce: 5,
  pine: 6,
  juniper: 7,
} as const;
export type LeafTile = (typeof LEAF_TILE)[keyof typeof LEAF_TILE];

const COLS = 4;
const ROWS = 2;

/** Область плитки в uv: [u0, v0, u1, v1] (v вверх; canvas рисуется сверху вниз — учтено flipY). */
export function tileUv(tile: LeafTile): [number, number, number, number] {
  const cx = tile % COLS;
  const cy = Math.floor(tile / COLS);
  const pad = 2 / 1024;
  return [cx / COLS + pad, 1 - (cy + 1) / ROWS + pad, (cx + 1) / COLS - pad, 1 - cy / ROWS - pad];
}

function canvas(w: number, h: number): [HTMLCanvasElement | OffscreenCanvas, CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D] {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')!];
  }
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext('2d')!];
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function grey(v: number, a = 1): string {
  const g = Math.round(255 * Math.min(1, v));
  return `rgba(${g},${g},${g},${a})`;
}

/** Лист заданной формы в локальных координатах (длина по оси y). */
function leafShape(ctx: Ctx, x: number, y: number, len: number, wid: number, angle: number, shade: number, shape: 'ovate' | 'heart' | 'lobed' | 'round' | 'narrow'): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const g = ctx.createLinearGradient(0, -len / 2, 0, len / 2);
  g.addColorStop(0, grey(shade));
  g.addColorStop(1, grey(shade * 0.76));
  ctx.fillStyle = g;
  ctx.beginPath();
  const l = len / 2;
  if (shape === 'heart') {
    ctx.moveTo(0, -l);
    ctx.bezierCurveTo(wid * 1.1, -l * 0.4, wid * 1.0, l * 0.75, 0.12 * wid, l * 0.9);
    ctx.lineTo(0, l * 0.7);
    ctx.lineTo(-0.12 * wid, l * 0.9);
    ctx.bezierCurveTo(-wid * 1.0, l * 0.75, -wid * 1.1, -l * 0.4, 0, -l);
  } else if (shape === 'lobed') {
    // Дубовый лист: волнистый край из нескольких лопастей.
    ctx.moveTo(0, -l);
    const lobes = 4;
    for (let k = 0; k <= lobes; k++) {
      const t = -l + (2 * l * k) / lobes;
      const w = wid * (0.55 + 0.45 * Math.sin((k / lobes) * Math.PI));
      ctx.quadraticCurveTo(w * 1.25, t - l / lobes / 2, w * 0.7, t);
    }
    ctx.lineTo(0, l);
    for (let k = lobes; k >= 0; k--) {
      const t = -l + (2 * l * k) / lobes;
      const w = wid * (0.55 + 0.45 * Math.sin((k / lobes) * Math.PI));
      ctx.quadraticCurveTo(-w * 1.25, t + l / lobes / 2, -w * 0.7, t);
    }
  } else if (shape === 'round') {
    ctx.ellipse(0, 0, wid, l * 0.92, 0, 0, Math.PI * 2);
  } else {
    const w = shape === 'narrow' ? wid * 0.45 : wid;
    ctx.moveTo(0, -l);
    ctx.bezierCurveTo(w, -l / 3, w * 0.85, l / 3, 0, l);
    ctx.bezierCurveTo(-w * 0.85, l / 3, -w, -l / 3, 0, -l);
  }
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, -l * 0.85);
  ctx.lineTo(0, l * 0.9);
  ctx.stroke();
  ctx.restore();
}

function drawLeafTile(ctx: Ctx, tile: LeafTile, ox: number, oy: number, s: number): void {
  const R = (i: number, k: number) => rand(900 + tile, i, k);
  if (tile === LEAF_TILE.spruce || tile === LEAF_TILE.pine || tile === LEAF_TILE.juniper) {
    // Хвойная лапа: побег и хвоя по обе стороны (ель — короткая густая, сосна — длинные пучки, можжевельник — чешуйки).
    const needles = tile === LEAF_TILE.spruce ? 170 : tile === LEAF_TILE.pine ? 90 : 220;
    ctx.strokeStyle = grey(0.55);
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(ox + s / 2, oy + s);
    ctx.lineTo(ox + s / 2, oy + 10);
    ctx.stroke();
    for (let i = 0; i < needles; i++) {
      const y = 10 + R(i, 1) * (s - 14);
      const side = i % 2 === 0 ? 1 : -1;
      const along = 0.25 + 0.75 * (y / s);
      const reach = tile === LEAF_TILE.pine ? s * 0.42 * (0.75 + R(i, 2) * 0.3) : tile === LEAF_TILE.juniper ? s * 0.2 * along : s * 0.44 * along * (0.7 + R(i, 2) * 0.4);
      const shade = 0.7 + R(i, 3) * 0.3;
      ctx.strokeStyle = grey(shade);
      ctx.lineWidth = tile === LEAF_TILE.pine ? 2.6 : tile === LEAF_TILE.juniper ? 6 : 4.5 + R(i, 4) * 3;
      ctx.beginPath();
      const x0 = ox + s / 2 + (tile === LEAF_TILE.juniper ? (R(i, 5) - 0.5) * s * 0.5 : 0);
      ctx.moveTo(x0, oy + y);
      const lift = tile === LEAF_TILE.pine ? 0.9 : 0.55;
      ctx.lineTo(x0 + side * reach, oy + y - reach * lift);
      ctx.stroke();
    }
    return;
  }
  const shapes: Record<number, ['ovate' | 'heart' | 'lobed' | 'round' | 'narrow', number, number, number]> = {
    [LEAF_TILE.oak]: ['lobed', 11, 0.3, 0.17],
    [LEAF_TILE.birch]: ['ovate', 17, 0.19, 0.12],
    [LEAF_TILE.linden]: ['heart', 12, 0.25, 0.2],
    [LEAF_TILE.alder]: ['round', 12, 0.24, 0.17],
    [LEAF_TILE.willow]: ['narrow', 18, 0.32, 0.17],
  };
  const [shape, count, lenK, widK] = shapes[tile]!;
  // Листья собраны в округлую гроздь с неровным краем: у карточки нет квадратных углов, и вдали
  // (в уменьшенных мипах) крона остаётся облаком, а не набором квадратов. Внутренние листья темнее.
  const n = Math.round(count * 1.6);
  for (let i = 0; i < n; i++) {
    const a = R(i, 1) * Math.PI * 2;
    const r = Math.sqrt(R(i, 2)) * 0.36 * (0.85 + 0.25 * Math.sin(a * 3 + tile));
    const x = ox + s * (0.5 + Math.cos(a) * r);
    const y = oy + s * (0.5 + Math.sin(a) * r);
    const len = s * lenK * (0.8 + R(i, 3) * 0.3);
    const inner = 1 - r / 0.36;
    leafShape(ctx, x, y, len, s * widK * (0.85 + R(i, 4) * 0.3), a + Math.PI / 2 + (R(i, 5) - 0.5) * 1.6, (0.72 + R(i, 6) * 0.2) * (1 - inner * 0.18), shape);
  }
}

/** Атлас листвы 1024 × 512 (4 × 2 плитки). Прозрачность — форма листьев; цвет — от вершин и экземпляров. */
export function leafAtlas(): THREE.Texture {
  const [c, ctx] = canvas(1024, 512);
  ctx.clearRect(0, 0, 1024, 512);
  for (let t = 0; t < COLS * ROWS; t++) drawLeafTile(ctx, t as LeafTile, (t % COLS) * 256, Math.floor(t / COLS) * 256, 256);
  const texture = new THREE.CanvasTexture(c as HTMLCanvasElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

// ───────── импосторы ─────────

export interface ImpostorStyle {
  /** Форма кроны сбоку: конус (ель), зонтик (сосна), овал (берёза, ольха), шар (дуб, липа), куст. */
  shape: 'cone' | 'umbrella' | 'oval' | 'round' | 'bush' | 'column';
  /** Доля высоты, где начинается крона. */
  crownBase: number;
  trunk: string;
  leaf: [number, number, number];
  bare: boolean;
}

/**
 * Атлас импосторов: по виду — столбец 256 px шириной; строки: 0 — сбоку в листве, 1 — сбоку без листвы,
 * 2 — сверху в листве, 3 — сверху без листвы. Цвет — полный (импостор вдали не освещается по нормалям карточек).
 */
export function impostorAtlas(styles: ImpostorStyle[]): { texture: THREE.Texture; columns: number } {
  const columns = styles.length;
  const [c, ctx] = canvas(256 * columns, 1024);
  ctx.clearRect(0, 0, 256 * columns, 1024);
  styles.forEach((st, k) => {
    for (let row = 0; row < 4; row++) {
      const leafy = row % 2 === 0;
      const top = row >= 2;
      const ox = k * 256;
      const oy = row * 256;
      if (top) drawTopView(ctx, ox, oy, st, leafy, k);
      else drawSideView(ctx, ox, oy, st, leafy, k);
    }
  });
  const texture = new THREE.CanvasTexture(c as HTMLCanvasElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture, columns };
}

function rgb(c: [number, number, number], k: number, a = 1): string {
  return `rgba(${Math.round(Math.min(255, c[0] * k))},${Math.round(Math.min(255, c[1] * k))},${Math.round(Math.min(255, c[2] * k))},${a})`;
}

function drawSideView(ctx: Ctx, ox: number, oy: number, st: ImpostorStyle, leafy: boolean, seed: number): void {
  const s = 256;
  const cx = ox + s / 2;
  const base = oy + s - 2;
  const topY = oy + 6;
  const crownBottom = base - (base - topY) * st.crownBase;
  const evergreen = !st.bare;
  // Ствол.
  ctx.fillStyle = st.trunk;
  const trunkTop = st.shape === 'cone' || st.shape === 'column' ? topY + 10 : crownBottom - (crownBottom - topY) * 0.35;
  const tw = st.shape === 'bush' ? 0 : s * 0.035;
  if (tw > 0) {
    ctx.beginPath();
    ctx.moveTo(cx - tw, base);
    ctx.lineTo(cx - tw * 0.35, trunkTop);
    ctx.lineTo(cx + tw * 0.35, trunkTop);
    ctx.lineTo(cx + tw, base);
    ctx.fill();
  }
  if (!leafy && !evergreen) {
    // Голые ветви листопадных.
    ctx.strokeStyle = st.trunk;
    for (let i = 0; i < 26; i++) {
      const t = rand(950, seed, i, 1);
      const y0 = crownBottom - (crownBottom - topY) * t * 0.85;
      const a = (rand(950, seed, i, 2) - 0.5) * 2.2;
      const len = s * (0.12 + 0.22 * (1 - t)) * (st.shape === 'oval' ? 0.7 : 1);
      ctx.lineWidth = 1.5 + (1 - t) * 2.5;
      ctx.beginPath();
      ctx.moveTo(cx, y0);
      ctx.quadraticCurveTo(cx + Math.sin(a) * len * 0.5, y0 - len * 0.5, cx + Math.sin(a) * len, y0 - Math.cos(a) * len * 0.7);
      ctx.stroke();
    }
    return;
  }
  // Крона из множества пятен листвы: светлее сверху, темнее снизу и в глубине.
  const blobs = 70;
  for (let i = 0; i < blobs; i++) {
    const u = rand(960, seed, i, 1);
    const v = rand(960, seed, i, 2);
    let x: number;
    let y: number;
    let r: number;
    const h = crownBottom - topY;
    if (st.shape === 'cone') {
      y = topY + v * h;
      const half = (v * 0.42 + 0.04) * s;
      x = (u * 2 - 1) * half;
      r = s * (0.05 + 0.04 * v);
    } else if (st.shape === 'column') {
      y = topY + v * h;
      x = (u * 2 - 1) * s * (0.13 + 0.06 * Math.sin(v * Math.PI));
      r = s * 0.06;
    } else if (st.shape === 'umbrella') {
      y = topY + v * h * 0.55;
      x = (u * 2 - 1) * s * (0.2 + 0.18 * Math.sin(v * Math.PI));
      r = s * 0.07;
    } else {
      const a = u * Math.PI * 2;
      const rr = Math.sqrt(v);
      const wide = st.shape === 'round' ? 0.4 : st.shape === 'bush' ? 0.44 : 0.3;
      const tall = st.shape === 'bush' ? 0.42 : 0.5;
      x = Math.cos(a) * rr * s * wide;
      y = topY + h * tall + Math.sin(a) * rr * h * tall;
      r = s * (st.shape === 'bush' ? 0.09 : 0.075);
    }
    const light = 0.62 + 0.5 * (1 - (y - topY) / Math.max(1, base - topY)) + rand(960, seed, i, 3) * 0.12;
    ctx.fillStyle = rgb(st.leaf, light, 0.95);
    ctx.beginPath();
    ctx.ellipse(cx + x, y, r, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTopView(ctx: Ctx, ox: number, oy: number, st: ImpostorStyle, leafy: boolean, seed: number): void {
  const s = 256;
  const cx = ox + s / 2;
  const cy = oy + s / 2;
  if (!leafy && st.bare) {
    ctx.strokeStyle = st.trunk;
    for (let i = 0; i < 14; i++) {
      const a = rand(970, seed, i) * Math.PI * 2;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * s * 0.42, cy + Math.sin(a) * s * 0.42);
      ctx.stroke();
    }
    return;
  }
  for (let i = 0; i < 60; i++) {
    const a = rand(971, seed, i, 1) * Math.PI * 2;
    const rr = Math.sqrt(rand(971, seed, i, 2)) * s * (st.shape === 'cone' || st.shape === 'column' ? 0.36 : 0.4);
    const light = 0.75 + 0.35 * (1 - rr / (s * 0.42)) + rand(971, seed, i, 3) * 0.1;
    ctx.fillStyle = rgb(st.leaf, light, 0.95);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, s * 0.085, 0, Math.PI * 2);
    ctx.fill();
  }
}
