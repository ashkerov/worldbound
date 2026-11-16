// Растительность и природные детали диорамы. Всё процедурное (собственная работа проекта):
// дуб, ель, берёза, кусты, трава, цветы двух форм, камыш, кувшинки, грибы, камни, брёвна.

import * as THREE from 'three/webgpu';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, min, mix, mx_noise_float, normalLocal, positionWorld, step, texture, transformNormalToView, uv, vec3 } from 'three/tsl';
import { GeoBuilder, canvasTexture, windPosition } from './kit';
import { HALF, HOUSE, POOL_S, ground, isClear, noise2, plateauDistance, rand, river, riverHalfWidth, slopeAt, waterLevel } from './layout';
import type { SkyUniforms } from './sky';
import { grassColor } from './terrain';

export interface FloraQuality {
  grass: number;
  flowers: number;
  leafDensity: number;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number) => new THREE.Color(hex);
const UP = V(0, 1, 0);
const IDENTITY = new THREE.Matrix4();

// ───────── текстуры листвы ─────────

function leafTexture(kind: 'broad' | 'birch' | 'fir'): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const leaf = (x: number, y: number, len: number, wid: number, angle: number, shade: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      const g = ctx.createLinearGradient(0, -len / 2, 0, len / 2);
      const hi = Math.round(255 * shade);
      const lo = Math.round(255 * shade * 0.78);
      g.addColorStop(0, `rgb(${hi},${hi},${hi})`);
      g.addColorStop(1, `rgb(${lo},${lo},${lo})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -len / 2);
      ctx.bezierCurveTo(wid, -len / 4, wid * 0.8, len / 3, 0, len / 2);
      ctx.bezierCurveTo(-wid * 0.8, len / 3, -wid, -len / 4, 0, -len / 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(0,0,0,0.16)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -len / 2.4);
      ctx.lineTo(0, len / 2.2);
      ctx.stroke();
      ctx.restore();
    };
    if (kind === 'fir') {
      // Еловая лапа: побег вдоль карточки и плотная хвоя по обе стороны.
      ctx.strokeStyle = 'rgb(150,150,150)';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(s / 2, s);
      ctx.lineTo(s / 2, 8);
      ctx.stroke();
      for (let i = 0; i < 150; i++) {
        const y = 10 + rand(201, i) * (s - 14);
        const side = i % 2 === 0 ? 1 : -1;
        const reach = (0.2 + 0.8 * (y / s)) * s * 0.46 * (0.7 + rand(202, i) * 0.4);
        const shade = 0.72 + rand(203, i) * 0.28;
        ctx.strokeStyle = `rgb(${255 * shade},${255 * shade},${255 * shade})`;
        ctx.lineWidth = 5 + rand(204, i) * 4;
        ctx.beginPath();
        ctx.moveTo(s / 2, y);
        ctx.lineTo(s / 2 + side * reach, y - reach * 0.55);
        ctx.stroke();
      }
      return;
    }
    const count = kind === 'birch' ? 16 : 11;
    for (let i = 0; i < count; i++) {
      const x = s * (0.16 + rand(211, i, count) * 0.68);
      const y = s * (0.16 + rand(212, i, count) * 0.68);
      const len = s * (kind === 'birch' ? 0.2 + rand(213, i) * 0.07 : 0.3 + rand(213, i) * 0.12);
      leaf(x, y, len, len * (kind === 'birch' ? 0.42 : 0.36), rand(214, i) * Math.PI * 2, 0.78 + rand(215, i) * 0.22);
    }
  });
}

// ───────── части деревьев ─────────

/** Ветвь переменной толщины вдоль кривой. */
function limb(points: THREE.Vector3[], r0: number, r1: number, sides: number, flare = 0): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const steps = Math.max(4, points.length * 3);
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const tangent = V(0, 1, 0);
  const side = V(1, 0, 0);
  const forward = V(0, 0, 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const centre = curve.getPoint(t);
    curve.getTangent(t, tangent);
    side.crossVectors(tangent, Math.abs(tangent.y) > 0.95 ? V(1, 0, 0) : UP).normalize();
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

interface CrownStyle {
  seed: number;
  cards: number;
  size: number;
  base: THREE.Color;
  sunlit: THREE.Color;
  bottom: number;
  top: number;
  centre: THREE.Vector3;
}

/** Облако листовых карточек на поверхности эллипсоида. */
function blob(b: GeoBuilder, centre: THREE.Vector3, radii: THREE.Vector3, style: CrownStyle, index: number): void {
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
    const depth = 0.72 + rand(style.seed, index, k, 3) * 0.3;
    point.set(centre.x + dir.x * radii.x * depth, centre.y + dir.y * radii.y * depth, centre.z + dir.z * radii.z * depth);
    tmp.set(rand(style.seed, index, k, 4) - 0.5, rand(style.seed, index, k, 5) - 0.5, rand(style.seed, index, k, 6) - 0.5);
    right.crossVectors(dir, tmp).normalize();
    up.crossVectors(right, dir).add(tmp.set(0, 0.55, 0)).normalize();
    const size = style.size * (0.75 + rand(style.seed, index, k, 7) * 0.5);
    right.multiplyScalar(size);
    up.multiplyScalar(size);
    shade.copy(point).sub(style.centre).normalize().add(tmp.set(0, 0.35, 0)).normalize();
    const h = THREE.MathUtils.clamp((point.y - style.bottom) / (style.top - style.bottom), 0, 1);
    const light = (0.5 + 0.62 * h) * (0.78 + 0.22 * depth) * (0.9 + rand(style.seed, index, k, 8) * 0.2);
    col.copy(style.base).lerp(style.sunlit, h * 0.65 + rand(style.seed, index, k, 9) * 0.2).multiplyScalar(light);
    const sway = 0.05 + h * 0.13;
    b.card(point, right, up, shade, col.clone().multiplyScalar(0.84), col.clone().multiplyScalar(1.06), sway, sway * 1.5);
  }
}

interface TreeGeometry {
  wood: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
}

function oak(seed: number, density: number): TreeGeometry {
  const wood = new GeoBuilder();
  const leaves = new GeoBuilder();
  const bark = C(0x5b4532);
  const barkDark = C(0x3d2e22);
  const barkColor = (p: THREE.Vector3) => bark.clone().lerp(barkDark, noise2(seed, p.y * 1.3, (p.x + p.z) * 2.5)).multiplyScalar(0.8 + Math.min(1, p.y / 5) * 0.3);
  const lean = (rand(seed, 1) - 0.5) * 0.9;
  const top = V(lean, 4.6, (rand(seed, 2) - 0.5) * 0.9);
  wood.add(limb([V(0, -0.5, 0), V(lean * 0.2, 1.6, 0.1), V(lean * 0.7, 3.2, top.z * 0.6), top], 0.62, 0.36, 10, 0.75), IDENTITY, barkColor, (p) => Math.max(0, p.y) * 0.006);
  const style: CrownStyle = { seed, cards: Math.round(150 * density), size: 0.95, base: C(0x3f7a32), sunlit: C(0x9cc04a), bottom: 4, top: 11.5, centre: V(lean, 6.6, top.z) };
  const blobs = 6;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + rand(seed, 10 + i) * 0.8;
    const reach = i === 0 ? 0 : 2.3 + rand(seed, 20 + i) * 1.3;
    const centre = V(top.x + Math.cos(a) * reach, (i === 0 ? 9.2 : 6.6 + rand(seed, 30 + i) * 2.0), top.z + Math.sin(a) * reach);
    const radius = i === 0 ? 2.9 : 2.1 + rand(seed, 40 + i) * 0.8;
    if (i > 0) {
      const mid = top.clone().lerp(centre, 0.55).add(V(0, 0.5, 0));
      wood.add(limb([top.clone().add(V(0, -0.5, 0)), mid, centre.clone().add(V(0, -0.4, 0))], 0.26, 0.07, 6), IDENTITY, barkColor, (p) => p.y * 0.008);
    } else {
      wood.add(limb([top.clone().add(V(0, -0.3, 0)), V(top.x, 7, top.z), centre], 0.3, 0.08, 6), IDENTITY, barkColor, (p) => p.y * 0.008);
    }
    blob(leaves, centre, V(radius, radius * 0.82, radius), style, i);
  }
  return { wood: wood.build(), leaves: leaves.build() };
}

function fir(seed: number, density: number): TreeGeometry {
  const wood = new GeoBuilder();
  const leaves = new GeoBuilder();
  const height = 12.5 + rand(seed, 1) * 4;
  const bark = C(0x4a382b);
  wood.add(limb([V(0, -0.5, 0), V(0.05, height * 0.5, 0.03), V(0, height, 0)], 0.42, 0.04, 8, 0.5), IDENTITY, (p) => bark.clone().multiplyScalar(0.75 + noise2(seed, p.y * 2, p.x * 6) * 0.5), (p) => Math.max(0, p.y) ** 2 * 0.0007);
  const dark = C(0x24503a);
  const tip = C(0x5c9460);
  const tiers = 11;
  const centre = V(0, 0, 0);
  const right = V(0, 0, 0);
  const up = V(0, 0, 0);
  const shade = V(0, 0, 0);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = 1.9 + t * (height - 2.6);
    const reach = (1 - t) ** 0.85 * (3.5 + rand(seed, 50 + i) * 0.5) + 0.45;
    const boughs = Math.round((7 + (1 - t) * 7) * density);
    for (let j = 0; j < boughs; j++) {
      const a = (j / boughs) * Math.PI * 2 + i * 0.7 + rand(seed, i, j, 1) * 0.3;
      const out = V(Math.cos(a), 0, Math.sin(a));
      const length = reach * (0.8 + rand(seed, i, j, 2) * 0.35);
      const droop = 0.36 + rand(seed, i, j, 3) * 0.2 - t * 0.2;
      const along = out.clone().multiplyScalar(Math.cos(droop)).add(V(0, -Math.sin(droop), 0));
      centre.set(0, y, 0).addScaledVector(along, length * 0.5 + 0.1);
      const tone = 0.62 + t * 0.45 + rand(seed, i, j, 4) * 0.12;
      const low = dark.clone().multiplyScalar(tone * 0.8);
      const high = dark.clone().lerp(tip, 0.75).multiplyScalar(tone * 1.05);
      shade.copy(out).multiplyScalar(0.55).add(V(0, 0.85, 0)).normalize();
      up.copy(along).multiplyScalar(length * 0.5);
      right.set(-out.z, 0, out.x).multiplyScalar(length * 0.34);
      const sway = 0.02 + t * 0.07;
      leaves.card(centre, right, up, shade, low, high, sway, sway + length * 0.03);
      right.crossVectors(along, V(-out.z, 0, out.x)).normalize().multiplyScalar(length * 0.2);
      leaves.card(centre, right, up, shade, low, high, sway, sway + length * 0.03);
    }
  }
  // Верхушка.
  leaves.card(V(0, height + 0.5, 0), V(0.38, 0, 0), V(0, 0.95, 0), V(0, 1, 0), dark, tip, 0.1, 0.14);
  leaves.card(V(0, height + 0.5, 0), V(0, 0, 0.38), V(0, 0.95, 0), V(0, 1, 0), dark, tip, 0.1, 0.14);
  return { wood: wood.build(), leaves: leaves.build() };
}

function birch(seed: number, density: number): TreeGeometry {
  const wood = new GeoBuilder();
  const leaves = new GeoBuilder();
  const height = 8.6 + rand(seed, 1) * 2.2;
  const white = C(0xe8e4d8);
  const mark = C(0x35322d);
  const lean = (rand(seed, 2) - 0.5) * 1.6;
  const barkColor = (p: THREE.Vector3) => {
    const fleck = rand(seed, Math.floor(p.y * 6), Math.floor(Math.atan2(p.z, p.x) * 1.6));
    const base = p.y < 0.9 ? 0.55 + p.y * 0.5 : 1;
    return (fleck < 0.17 ? mark.clone() : white.clone().multiplyScalar(0.9 + fleck * 0.1)).multiplyScalar(base);
  };
  const trunk = [V(0, -0.5, 0), V(lean * 0.25, height * 0.35, 0.1), V(lean * 0.7, height * 0.7, -0.1), V(lean, height, 0)];
  wood.add(limb(trunk, 0.2, 0.035, 8, 0.4), IDENTITY, barkColor, (p) => Math.max(0, p.y) ** 2 * 0.0012);
  const curve = new THREE.CatmullRomCurve3(trunk);
  const style: CrownStyle = { seed, cards: Math.round(70 * density), size: 0.52, base: C(0x6f9f3c), sunlit: C(0xc3d85e), bottom: height * 0.4, top: height + 1, centre: V(lean * 0.7, height * 0.72, 0) };
  const branches = 8;
  for (let i = 0; i < branches; i++) {
    const t = 0.45 + (i / (branches - 1)) * 0.52;
    const from = curve.getPoint(t);
    const a = i * 2.4 + rand(seed, 10 + i) * 0.9;
    const reach = (1.15 - t) * 3.0 + 0.6;
    const tipPoint = from.clone().add(V(Math.cos(a) * reach, 0.5 + rand(seed, 20 + i) * 0.9, Math.sin(a) * reach));
    const sag = tipPoint.clone().add(V(Math.cos(a) * 0.5, -0.9, Math.sin(a) * 0.5));
    wood.add(limb([from, from.clone().lerp(tipPoint, 0.55).add(V(0, 0.35, 0)), tipPoint, sag], 0.06, 0.012, 5), IDENTITY, barkColor, (p) => p.y * 0.012);
    blob(leaves, tipPoint, V(1.25, 1.0, 1.25), style, i);
    blob(leaves, sag, V(0.8, 1.05, 0.8), { ...style, cards: Math.round(style.cards * 0.5) }, i + 20);
  }
  blob(leaves, curve.getPoint(1), V(1.2, 1.3, 1.2), style, 40);
  return { wood: wood.build(), leaves: leaves.build() };
}

function bush(seed: number, density: number): TreeGeometry {
  const wood = new GeoBuilder();
  const leaves = new GeoBuilder();
  const flowering = seed % 2 === 0;
  const style: CrownStyle = { seed, cards: Math.round(70 * density), size: 0.25, base: C(flowering ? 0x4d8a3a : 0x3c7438), sunlit: C(0x9fc65a), bottom: 0, top: 1.8, centre: V(0, 0.4, 0) };
  const berry = C(flowering ? 0xf2e6f0 : 0xc0392b);
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7 + rand(seed, i) * 0.8;
    const reach = i === 0 ? 0 : 0.55 + rand(seed, 10 + i) * 0.3;
    const centre = V(Math.cos(a) * reach, 0.6 + rand(seed, 20 + i) * 0.4, Math.sin(a) * reach);
    const r = 0.62 + rand(seed, 30 + i) * 0.28;
    blob(leaves, centre, V(r, r * 0.85, r), style, i);
    wood.add(limb([V(0, -0.1, 0), centre.clone().multiplyScalar(0.6), centre], 0.05, 0.015, 4), IDENTITY, C(0x4a3a2a), 0.01);
    for (let k = 0; k < 5; k++) {
      const u = rand(seed, i, k, 1) * Math.PI * 2;
      const y = rand(seed, i, k, 2) * 0.9;
      const rr = Math.sqrt(1 - y * y) * r;
      wood.add(new THREE.OctahedronGeometry(flowering ? 0.07 : 0.05, 0), new THREE.Matrix4().makeTranslation(centre.x + Math.cos(u) * rr, centre.y + y * r * 0.85, centre.z + Math.sin(u) * rr), berry, 0.06);
    }
  }
  return { wood: wood.build(), leaves: leaves.build() };
}

// ───────── мелкие формы ─────────

function grassTuft(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  // Оттенки серого: цвет пучку задаёт экземпляр (он берётся из цвета рельефа под ним).
  const base = new THREE.Color(0.5, 0.56, 0.46);
  const tipColor = new THREE.Color(1.12, 1.16, 0.92);
  const mid = base.clone().lerp(tipColor, 0.5);
  for (let k = 0; k < 5; k++) {
    const a = k * 1.7 + 0.4;
    const ox = Math.cos(a * 2.3) * 0.3;
    const oz = Math.sin(a * 1.9) * 0.3;
    const fx = Math.cos(a);
    const fz = Math.sin(a);
    const h = 0.34 + (k % 3) * 0.12;
    const w = 0.032;
    const lean = 0.12 + (k % 4) * 0.03;
    const bl = V(ox - fz * w, 0, oz + fx * w);
    const br = V(ox + fz * w, 0, oz - fx * w);
    const ml = V(ox - fz * w * 0.7 + fx * lean * 0.4, h * 0.55, oz + fx * w * 0.7 + fz * lean * 0.4);
    const mr = V(ox + fz * w * 0.7 + fx * lean * 0.4, h * 0.55, oz - fx * w * 0.7 + fz * lean * 0.4);
    const tp = V(ox + fx * lean, h, oz + fz * lean);
    b.tri(bl, br, mr, UP, [base, base, mid], [0, 0, 1, 0, 1, 0.5], [0, 0, 0.3]);
    b.tri(bl, mr, ml, UP, [base, mid, mid], [0, 0, 1, 0.5, 0, 0.5], [0, 0.3, 0.3]);
    b.tri(ml, mr, tp, UP, [mid, mid, tipColor], [0, 0.5, 1, 0.5, 0.5, 1], [0.3, 0.3, 1]);
  }
  return b.build();
}

/** Цветок-ромашка: лепестки белые (окрашиваются оттенком экземпляра), серединка и стебель — собственного цвета. */
function daisy(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const stem = C(0x4f7f33);
  const white = C(0xffffff);
  const core = C(0xf2c230);
  const h = 0.42;
  b.tri(V(-0.012, 0, 0), V(0.012, 0, 0), V(0, h, 0), UP, [stem, stem, stem], [0, 0, 1, 0, 0.5, 1], [0, 0, 1]);
  b.tri(V(0, 0, -0.012), V(0, 0, 0.012), V(0, h, 0), UP, [stem, stem, stem], [0, 0, 1, 0, 0.5, 1], [0, 0, 1]);
  b.tri(V(0, h * 0.4, 0), V(0.1, h * 0.55, 0.04), V(0.02, h * 0.5, 0.07), UP, [stem, stem, stem], [0, 0, 1, 0, 0.5, 1], [0.4, 0.5, 0.5]);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const a2 = a + 0.5;
    b.tri(V(0, h, 0), V(Math.cos(a) * 0.1, h + 0.035, Math.sin(a) * 0.1), V(Math.cos(a2) * 0.1, h + 0.035, Math.sin(a2) * 0.1), UP, [white, white, white], [0, 0, 1, 0, 0.5, 1], [1, 1, 1]);
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const a2 = a + Math.PI / 2;
    b.tri(V(Math.cos(a) * 0.035, h + 0.012, Math.sin(a) * 0.035), V(Math.cos(a2) * 0.035, h + 0.012, Math.sin(a2) * 0.035), V(0, h + 0.05, 0), UP, [core, core, core], [0, 0, 1, 0, 0.5, 1], [1, 1, 1]);
  }
  return b.build();
}

/** Соцветие-свеча (люпин): стебель и ярусы мелких лепестков. */
function lupine(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const stem = C(0x4a7a35);
  const white = C(0xffffff);
  const h = 0.75;
  b.tri(V(-0.014, 0, 0), V(0.014, 0, 0), V(0, h, 0), UP, [stem, stem, stem], [0, 0, 1, 0, 0.5, 1], [0, 0, 1]);
  b.tri(V(0, 0, -0.014), V(0, 0, 0.014), V(0, h, 0), UP, [stem, stem, stem], [0, 0, 1, 0, 0.5, 1], [0, 0, 1]);
  for (let k = 0; k < 3; k++) {
    const a = k * 2.1;
    b.tri(V(0, 0.08, 0), V(Math.cos(a) * 0.16, 0.2, Math.sin(a) * 0.16), V(Math.cos(a + 0.6) * 0.1, 0.12, Math.sin(a + 0.6) * 0.1), UP, [stem, stem, stem], [0, 0, 1, 0, 0.5, 1], [0.1, 0.3, 0.2]);
  }
  for (let ring = 0; ring < 6; ring++) {
    const y = 0.3 + ring * 0.075;
    const r = 0.075 * (1 - ring / 8);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + ring * 0.9;
      const sway = 0.45 + ring * 0.08;
      b.tri(V(0, y, 0), V(Math.cos(a - 0.45) * r, y + 0.05, Math.sin(a - 0.45) * r), V(Math.cos(a + 0.45) * r, y + 0.05, Math.sin(a + 0.45) * r), UP, [white, white, white], [0, 0, 1, 0, 0.5, 1], [sway, sway, sway]);
    }
  }
  return b.build();
}

function reed(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const base = C(0x4c7036);
  const tipColor = C(0x9db35c);
  const head = C(0x5a3a22);
  for (let k = 0; k < 6; k++) {
    const a = k * 1.1;
    const ox = Math.cos(a) * 0.12;
    const oz = Math.sin(a) * 0.12;
    const h = 1.0 + (k % 3) * 0.3;
    const fx = Math.cos(a + 1);
    const fz = Math.sin(a + 1);
    const w = 0.028;
    b.tri(V(ox - fz * w, 0, oz + fx * w), V(ox + fz * w, 0, oz - fx * w), V(ox + fx * 0.18, h, oz + fz * 0.18), UP, [base, base, tipColor], [0, 0, 1, 0, 0.5, 1], [0, 0, 1.4]);
  }
  for (let k = 0; k < 2; k++) {
    const m = new THREE.Matrix4().makeTranslation(k * 0.1 - 0.05, 1.25 + k * 0.2, k * 0.06);
    b.add(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 6), m, head, 1.2);
    b.add(new THREE.CylinderGeometry(0.008, 0.008, 1.2 + k * 0.2, 4), new THREE.Matrix4().makeTranslation(k * 0.1 - 0.05, 0.6 + k * 0.1, k * 0.06), base, (p) => p.y * 0.9);
  }
  return b.build();
}

function rockGeometry(seed: number, detail = 2): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = BufferGeometryUtils.mergeVertices(g, 1e-4);
  const position = g.getAttribute('position');
  const p = V(0, 0, 0);
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    const n1 = noise2(seed, p.x * 1.3 + p.y * 1.9, p.z * 1.3 - p.y * 0.7) - 0.5;
    const n2 = noise2(seed + 7, p.x * 3.7 - p.y * 2.1, p.z * 3.7 + p.y * 1.3) - 0.5;
    p.multiplyScalar(1 + n1 * 0.55 + n2 * 0.16);
    // Срезанные грани — камень, а не шар.
    p.y = Math.max(-0.55, Math.min(0.72 + n1 * 0.2, p.y)) * 0.78;
    position.setXYZ(i, p.x, p.y, p.z * 0.86);
  }
  g.computeVertexNormals();
  const b = new GeoBuilder();
  const grey = C(0xa7a195);
  const dark = C(0x7b756b);
  const moss = C(0x5d7a3a);
  b.add(g, IDENTITY, (q, n) => {
    const c = grey.clone().lerp(dark, noise2(seed + 3, q.x * 2.2 + q.y, q.z * 2.2 - q.y));
    return c.lerp(moss, THREE.MathUtils.smoothstep(n.y + noise2(seed + 4, q.x * 3, q.z * 3) * 0.3, 0.66, 0.97) * 0.6);
  });
  return b.build();
}

function mushroom(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.035, 0.05, 0.14, 7), new THREE.Matrix4().makeTranslation(0, 0.07, 0), C(0xefe6d2));
  const cap = new THREE.SphereGeometry(0.11, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  b.add(cap, new THREE.Matrix4().makeTranslation(0, 0.13, 0).multiply(new THREE.Matrix4().makeScale(1, 0.75, 1)), (p) => (rand(77, Math.round(p.x * 40), Math.round(p.z * 40)) < 0.16 ? C(0xfff6e6) : C(0xc8402c)));
  return b.build();
}

function logGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const bark = C(0x5a4230);
  const ring = C(0xcaa873);
  b.add(new THREE.CylinderGeometry(0.34, 0.38, 3.6, 12), new THREE.Matrix4().makeRotationZ(Math.PI / 2), (_p, n) => (Math.abs(n.x) > 0.9 ? ring : bark));
  b.add(new THREE.CylinderGeometry(0.4, 0.46, 0.55, 12), new THREE.Matrix4().makeTranslation(3.4, 0, 1.2), (_p, n) => (n.y > 0.9 ? ring : bark));
  return b.build();
}

// ───────── расстановка ─────────

interface Spot {
  x: number;
  z: number;
  y: number;
  scale: number;
  yaw: number;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, spots: Spot[], opts: { cast?: boolean; receive?: boolean; tint?: (i: number) => THREE.Color; squash?: (i: number) => number; tilt?: number } = {}): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, spots.length));
  mesh.count = spots.length;
  const dummy = new THREE.Object3D();
  spots.forEach((s, i) => {
    dummy.position.set(s.x, s.y, s.z);
    dummy.rotation.set(opts.tilt ? (rand(301, i) - 0.5) * opts.tilt : 0, s.yaw, opts.tilt ? (rand(302, i) - 0.5) * opts.tilt : 0);
    const sq = opts.squash ? opts.squash(i) : 1;
    dummy.scale.set(s.scale, s.scale * sq, s.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (opts.tint) mesh.setColorAt(i, opts.tint(i));
  });
  mesh.castShadow = opts.cast ?? false;
  mesh.receiveShadow = opts.receive ?? true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Случайные точки с отбором: accept возвращает масштаб или 0. */
function scatter(seed: number, attempts: number, limit: number, accept: (x: number, z: number, i: number) => number, minGap = 0, taken: Spot[] = []): Spot[] {
  const out: Spot[] = [];
  for (let i = 0; i < attempts && out.length < limit; i++) {
    const x = (rand(seed, i, 1) * 2 - 1) * (HALF - 1.2);
    const z = (rand(seed, i, 2) * 2 - 1) * (HALF - 1.2);
    const scale = accept(x, z, i);
    if (scale <= 0) continue;
    if (minGap > 0 && [...taken, ...out].some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < minGap * minGap)) continue;
    out.push({ x, z, y: ground(x, z).h, scale, yaw: rand(seed, i, 3) * Math.PI * 2 });
  }
  return out;
}

export function buildFlora(quality: FloraQuality, sky: SkyUniforms): THREE.Group {
  const group = new THREE.Group();
  const density = quality.leafDensity;

  // Материалы.
  const barkMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  barkMaterial.colorNode = attribute('color', 'vec3').mul(mx_noise_float(vec3(positionWorld.x.mul(4), positionWorld.y.mul(0.7), positionWorld.z.mul(4))).mul(0.2).add(1));
  barkMaterial.positionNode = windPosition(1);
  const leafMaterial = (kind: 'broad' | 'birch' | 'fir') => {
    const map = leafTexture(kind);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.78, alphaTest: 0.42, side: THREE.DoubleSide });
    // Своя нормаль: без переворота на обратной стороне карточки.
    m.normalNode = transformNormalToView(normalLocal);
    const texel = texture(map, uv());
    const tinted = texel.rgb.mul(attribute('color', 'vec3'));
    m.colorNode = tinted;
    m.opacityNode = texel.a;
    m.emissiveNode = tinted.mul(sky.sunColor).mul(sky.sunStrength.mul(0.07));
    m.positionNode = windPosition(1);
    return m;
  };
  const broad = leafMaterial('broad');
  const birchLeaves = leafMaterial('birch');
  const firNeedles = leafMaterial('fir');
  const solid = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  solid.colorNode = attribute('color', 'vec3').mul(mx_noise_float(positionWorld.mul(5)).mul(0.1).add(1));

  // ── Деревья ──
  const onPlateau = (x: number, z: number) => plateauDistance(x, z);
  const treeOk = (x: number, z: number, margin: number) => {
    const g = ground(x, z);
    return g.riverD > g.riverW + 2.6 && isClear(x, z, margin) && slopeAt(x, z) < 0.22;
  };
  const taken: Spot[] = [];
  const firs = scatter(501, 2400, 64, (x, z, i) => {
    const pd = onPlateau(x, z);
    const corner = x > 28 && z < -38;
    if (!(pd > 3 || corner) || !treeOk(x, z, 1)) return 0;
    return 0.9 + rand(502, i) * 0.6;
  }, 3.6, taken);
  taken.push(...firs);
  const oaks: Spot[] = [{ x: HOUSE.x + 10.5, z: HOUSE.z - 9.5, y: ground(HOUSE.x + 10.5, HOUSE.z - 9.5).h, scale: 1.4, yaw: 1.1 }];
  oaks.push(
    ...scatter(503, 2600, 17, (x, z, i) => {
      if (onPlateau(x, z) > -6 || !treeOk(x, z, 2.5)) return 0;
      const meadowEdge = x < -52 || z > 50 || x > 44 || (x > 8 && z > -2 && z < 34) || noise2(516, x / 16, z / 16) > 0.7;
      if (!meadowEdge) return 0;
      return 0.95 + rand(504, i) * 0.5;
    }, 8, [...taken, ...oaks]),
  );
  taken.push(...oaks);
  const birches = scatter(505, 2600, 22, (x, z, i) => {
    const g = ground(x, z);
    const shore = g.riverD - g.riverW;
    if (onPlateau(x, z) > -5 || shore < 3 || shore > 13 || !isClear(x, z, 1.2) || slopeAt(x, z) > 0.22) return 0;
    return 0.95 + rand(506, i) * 0.4;
  }, 4.4, taken);
  taken.push(...birches);

  const plant = (spots: Spot[], variants: TreeGeometry[], leaves: THREE.Material, tintSeed: number, hueSpread: number) => {
    variants.forEach((variant, v) => {
      const mine = spots.filter((_s, i) => i % variants.length === v);
      const tint = (i: number) => new THREE.Color().setHSL(0, 0, 1).offsetHSL(0, 0, 0).multiplyScalar(0.9 + rand(tintSeed, v, i) * 0.2).lerp(new THREE.Color(1, 0.95, 0.75), rand(tintSeed + 1, v, i) * hueSpread);
      group.add(instanced(variant.wood, barkMaterial, mine, { cast: true }));
      group.add(instanced(variant.leaves, leaves, mine, { cast: true, tint, squash: (i) => 0.92 + rand(tintSeed + 2, v, i) * 0.16 }));
    });
  };
  plant(oaks, [oak(601, density), oak(602, density)], broad, 611, 0.25);
  plant(firs, [fir(603, density), fir(604, density), fir(605, density)], firNeedles, 612, 0.1);
  plant(birches, [birch(606, density), birch(607, density)], birchLeaves, 613, 0.3);

  // ── Кусты ──
  const bushes = scatter(507, 3200, 72, (x, z, i) => {
    const g = ground(x, z);
    if (g.riverD < g.riverW + 1.6 || !isClear(x, z, 0.4) || slopeAt(x, z) > 0.3) return 0;
    const nearTree = taken.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 36);
    if (!nearTree && rand(508, i) > 0.3) return 0;
    return 0.9 + rand(509, i) * 0.9;
  }, 2.2, taken);
  const bushKinds = [bush(620, density), bush(621, density)];
  bushKinds.forEach((kind, v) => {
    const mine = bushes.filter((_s, i) => i % 2 === v);
    group.add(instanced(kind.wood, solid, mine, { cast: true }));
    group.add(instanced(kind.leaves, broad, mine, { cast: true, tint: (i) => new THREE.Color(1, 1, 1).multiplyScalar(0.85 + rand(622, v, i) * 0.25) }));
  });

  // ── Трава ──
  const openGround = (x: number, z: number) => {
    const g = ground(x, z);
    if (g.riverD < g.riverW + 0.35 || g.trailD < 1.15) return false;
    if (Math.hypot(x - HOUSE.x, z - HOUSE.z) < 6.2) return false;
    return slopeAt(x, z) < 0.24;
  };
  const grassMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 1, side: THREE.DoubleSide });
  grassMaterial.colorNode = attribute('color', 'vec3');
  grassMaterial.normalNode = transformNormalToView(vec3(0, 1, 0));
  grassMaterial.positionNode = windPosition(0.16);
  const grassSpots = scatter(510, quality.grass * 3, quality.grass, (x, z, i) => {
    if (!openGround(x, z)) return 0;
    const lush = noise2(511, x / 9, z / 9);
    if (rand(512, i) > 0.45 + lush * 0.7) return 0;
    return 0.7 + lush * 0.5 + rand(513, i) * 0.35;
  });
  group.add(
    instanced(grassTuft(), grassMaterial, grassSpots, {
      tint: (i) => {
        const s = grassSpots[i]!;
        return grassColor(s.x, s.z, ground(s.x, s.z).plateau, new THREE.Color()).multiplyScalar(1.02 + rand(514, i) * 0.34);
      },
      squash: (i) => 0.75 + rand(515, i) * 0.8,
    }),
  );

  // ── Цветы: пятнами, каждый экземпляр со своим оттенком лепестков ──
  const flowerMaterial = () => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, side: THREE.DoubleSide });
    const c = attribute('color', 'vec3');
    const isPetal = step(0.95, min(c.r, min(c.g, c.b)));
    m.colorNode = mix(c, attribute('tint', 'vec3'), isPetal);
    m.normalNode = transformNormalToView(vec3(0, 1, 0));
    m.positionNode = windPosition(0.1);
    return m;
  };
  const flowerField = (geometry: THREE.BufferGeometry, seed: number, count: number, palette: number[], patch: number) => {
    const spots = scatter(seed, count * 14, count, (x, z, i) => {
      if (!openGround(x, z)) return 0;
      if (noise2(seed + 1, x / patch, z / patch) < 0.56) return 0;
      return 0.8 + rand(seed + 2, i) * 0.7;
    });
    const tints = new Float32Array(Math.max(1, spots.length) * 3);
    const c = new THREE.Color();
    spots.forEach((s, i) => {
      const pick = palette[Math.floor(noise2(seed + 3, s.x / (patch * 0.7), s.z / (patch * 0.7)) * palette.length * 0.999)]!;
      c.set(pick).offsetHSL((rand(seed + 4, i) - 0.5) * 0.04, 0, (rand(seed + 5, i) - 0.5) * 0.12);
      tints.set([c.r, c.g, c.b], i * 3);
    });
    geometry.setAttribute('tint', new THREE.InstancedBufferAttribute(tints, 3));
    group.add(instanced(geometry, flowerMaterial(), spots));
  };
  flowerField(daisy(), 520, Math.round(quality.flowers * 0.6), [0xffffff, 0xffe066, 0xf4f1e8, 0xe8554a, 0xffb347], 7);
  flowerField(lupine(), 530, Math.round(quality.flowers * 0.4), [0x7d5bd6, 0x9b6fe0, 0x5f6fd9, 0xd76fb5], 9);

  // ── Камыш и кувшинки ──
  const reeds = scatter(540, 9000, 150, (x, z, i) => {
    const g = ground(x, z);
    const shore = g.riverD - g.riverW;
    if (shore < -0.5 || shore > 0.7 || g.riverS < POOL_S - 3 || g.plateau > 0.01) return 0;
    if (g.trailD < 3 || noise2(541, x / 5, z / 5) < 0.45) return 0;
    return 0.8 + rand(542, i) * 0.6;
  });
  const reedMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, side: THREE.DoubleSide });
  reedMaterial.colorNode = attribute('color', 'vec3');
  reedMaterial.positionNode = windPosition(0.12);
  group.add(instanced(reed(), reedMaterial, reeds));

  const pads: Spot[] = [];
  for (let i = 0; i < 26; i++) {
    const s = POOL_S - 3 + rand(550, i) * 9;
    const c = river.at(s);
    const w = riverHalfWidth(s);
    const off = (rand(551, i) * 2 - 1) * (w - 0.9);
    if (Math.abs(off) < 1.2) continue;
    pads.push({ x: c.x - c.tz * off, z: c.z + c.tx * off, y: waterLevel(s) + 0.025, scale: 0.28 + rand(552, i) * 0.22, yaw: rand(553, i) * 6.28 });
  }
  const padGeometry = new GeoBuilder().add(new THREE.CircleGeometry(1, 14, 0.25, Math.PI * 2 - 0.5).rotateX(-Math.PI / 2), IDENTITY, (p) => C(0x3f7a3a).multiplyScalar(0.8 + p.length() * 0.3)).build();
  group.add(instanced(padGeometry, solid, pads));

  // ── Камни: вдоль обрыва, по берегам, на лугу ──
  const rocks = [rockGeometry(701), rockGeometry(702), rockGeometry(703)];
  const cliffRocks = scatter(560, 9000, 60, (x, z, i) => {
    const pd = plateauDistance(x, z);
    const g = ground(x, z);
    // Осыпь у подножия и валуны на кромке плато; на самой стене камней нет.
    const atFoot = pd > -7.5 && pd < -3.4;
    const onEdge = pd > 3.2 && pd < 5.2;
    if (!(atFoot || onEdge) || g.riverD < g.riverW + 1.2) return 0;
    return (atFoot ? 0.9 : 0.6) + rand(561, i) * (atFoot ? 1.9 : 1.0);
  }, 1.8);
  const shoreRocks = scatter(562, 9000, 110, (x, z, i) => {
    const g = ground(x, z);
    const shore = g.riverD - g.riverW;
    if (shore < -0.9 || shore > 1.3 || g.trailD < 2.2) return 0;
    return 0.22 + rand(563, i) ** 2 * 0.8;
  }, 0.7);
  const fieldRocks = scatter(564, 900, 16, (x, z, i) => {
    const g = ground(x, z);
    if (g.riverD < g.riverW + 3 || !isClear(x, z, 0.6)) return 0;
    return 0.4 + rand(565, i) * 0.9;
  }, 6);
  cliffRocks.forEach((s) => (s.y -= s.scale * 0.3));
  [...shoreRocks, ...fieldRocks].forEach((s) => (s.y -= s.scale * 0.22));
  rocks.forEach((geometry, v) => {
    const mine = [...cliffRocks, ...fieldRocks].filter((_s, i) => i % rocks.length === v);
    group.add(instanced(geometry, solid, mine, { cast: true, tilt: 0.5, squash: (i) => 0.75 + rand(566, v, i) * 0.6 }));
  });
  // Мелкая береговая галька — упрощённая геометрия и без теней.
  [rockGeometry(704, 1), rockGeometry(705, 1)].forEach((geometry, v) => {
    const mine = shoreRocks.filter((_s, i) => i % 2 === v);
    group.add(instanced(geometry, solid, mine, { tilt: 0.6, squash: (i) => 0.7 + rand(567, v, i) * 0.6 }));
  });

  // ── Грибы у елей, брёвна на лугу ──
  const mushrooms = scatter(570, 6000, 34, (x, z, i) => {
    if (!firs.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 9) || !openGround(x, z)) return 0;
    return 0.8 + rand(571, i) * 1.1;
  }, 0.5);
  group.add(instanced(mushroom(), solid, mushrooms, { cast: true }));
  const logs: Spot[] = [
    { x: -30, z: 22, y: ground(-30, 22).h + 0.28, scale: 1, yaw: 0.6 },
    { x: 12, z: 42, y: ground(12, 42).h + 0.28, scale: 0.85, yaw: 2.2 },
  ];
  group.add(instanced(logGeometry(), solid, logs, { cast: true }));

  return group;
}
