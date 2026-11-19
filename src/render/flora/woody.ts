// Процедурные модели деревьев и кустарников каталога (собственная работа проекта; приёмы — прототип 1A).
// У каждого вида свой ствол, ветвление, форма и плотность кроны, лист (плитка атласа), цвета по сезонам.
// Уровни детализации: LOD0 — ветви и сотни листовых карточек; LOD1 — тот же силуэт из крупных карточек
// и простого ствола; дальше — импостор (flora/textures.ts), ещё дальше — цвет полога в материале рельефа.
// Модель строится в «эталонном» размере; экземпляр растягивается до высоты и радиуса кроны из симуляции.

import * as THREE from 'three/webgpu';
import { C, GeoBuilder, V, blob, limb, noise2, rand, type CrownStyle } from './geometry';
import { LEAF_TILE, tileUv, type ImpostorStyle, type LeafTile } from './textures';

export interface WoodyProfile {
  id: string;
  evergreen: boolean;
  tile: LeafTile;
  /** Цвет листвы летом (основной и освещённый), весной и осенью (множители к цвету вершин). */
  summer: THREE.Color;
  spring: THREE.Color;
  autumn: THREE.Color;
  /** Цветение (rgb) и окно цветения в долях года; плоды осенью. */
  blossom?: { color: THREE.Color; from: number; to: number; fruit?: THREE.Color };
  /** Амплитуда качания на ветру (берёза и ива — гибкие, дуб — жёсткий). */
  wind: number;
  impostor: ImpostorStyle;
  build(seed: number, lod: 0 | 1): THREE.BufferGeometry;
}

const IDENTITY = new THREE.Matrix4();

function barkSway(k: number) {
  return (p: THREE.Vector3) => Math.max(0, p.y) ** 2 * k;
}

/** Плотность карточек и их размер для уровня детализации: на LOD1 карточек в 4 раза меньше, они крупнее. */
function detail(lod: 0 | 1, cards: number, size: number): { cards: number; size: number } {
  // LOD0: на 25 % меньше карточек, чем в прототипе 1A, и они на 15 % крупнее — то же заполнение кроны
  // при бюджете кадра ≤ 1 млн треугольников (раздел 16.4 PHASE3_PLAN). LOD1 — в 4,5 раза меньше карточек.
  return lod === 0 ? { cards: Math.max(4, Math.round(cards * 0.75)), size: size * 1.15 } : { cards: Math.max(4, Math.round(cards * 0.2)), size: size * 1.9 };
}

// ───────── деревья ─────────

function birch(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const height = 10 + rand(seed, 1) * 1.5;
  const lean = (rand(seed, 2) - 0.5) * 1.1;
  const white = C(0xe9e5da);
  const mark = C(0x2f2c28);
  const barkColor = (p: THREE.Vector3) => {
    const fleck = rand(seed, Math.floor(p.y * 5), Math.floor(Math.atan2(p.z, p.x) * 1.7));
    const foot = p.y < 1.1 ? 0.5 + p.y * 0.45 : 1;
    return (fleck < 0.16 ? mark.clone() : white.clone().multiplyScalar(0.9 + fleck * 0.1)).multiplyScalar(foot);
  };
  const trunk = [V(0, -0.4, 0), V(lean * 0.25, height * 0.35, 0.08), V(lean * 0.7, height * 0.7, -0.08), V(lean, height, 0)];
  b.add(limb(trunk, 0.2, 0.03, lod === 0 ? 8 : 5, 0.35), IDENTITY, barkColor, barkSway(0.0012));
  const curve = new THREE.CatmullRomCurve3(trunk);
  const d = detail(lod, 34, 0.5);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x6e9e3c), sunlit: C(0xc6da62), bottom: height * 0.4, top: height + 1, centre: V(lean * 0.7, height * 0.72, 0), uv: tileUv(LEAF_TILE.birch) };
  const branches = lod === 0 ? 8 : 5;
  for (let i = 0; i < branches; i++) {
    const t = 0.42 + (i / (branches - 1)) * 0.52;
    const from = curve.getPoint(t);
    const a = i * 2.4 + rand(seed, 10 + i) * 0.9;
    const reach = (1.15 - t) * 2.8 + 0.6;
    const tip = from.clone().add(V(Math.cos(a) * reach, 0.5 + rand(seed, 20 + i) * 0.8, Math.sin(a) * reach));
    // Плакучие концы ветвей — признак берёзы.
    const sag = tip.clone().add(V(Math.cos(a) * 0.5, -1.0, Math.sin(a) * 0.5));
    // Ветви есть и на LOD1 (упрощённые): зимой голая крона должна читаться как дерево, а не как шест.
    b.add(limb([from, from.clone().lerp(tip, 0.55).add(V(0, 0.35, 0)), tip, sag], lod === 0 ? 0.055 : 0.07, 0.012, lod === 0 ? 4 : 3, 0, lod === 0 ? 0 : 4), IDENTITY, barkColor, (p) => p.y * 0.012);
    if (lod === 0) for (let k = 0; k < 3; k++) {
      // Тонкие веточки — гуще голая крона.
      const t2 = 0.3 + k * 0.25;
      const at = from.clone().lerp(tip, t2);
      const aa = a + (k - 1) * 0.9;
      const end = at.clone().add(V(Math.cos(aa) * 0.9, 0.2 - k * 0.3, Math.sin(aa) * 0.9));
      b.add(limb([at, end], 0.018, 0.005, 3, 0, 2), IDENTITY, barkColor, (p) => p.y * 0.014);
    }
    blob(b, tip, V(1.2, 0.95, 1.2), style, i);
    blob(b, sag, V(0.75, 1.1, 0.75), { ...style, cards: Math.round(style.cards * 0.55) }, i + 20);
  }
  blob(b, curve.getPoint(1), V(1.1, 1.25, 1.1), style, 40);
  return b.build();
}

function pine(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const height = 14 + rand(seed, 1) * 2;
  const lean = (rand(seed, 2) - 0.5) * 0.8;
  // Кора: внизу серо-бурая с трещинами, выше — медно-оранжевая.
  const low = C(0x5a4636);
  const high = C(0xb5683a);
  const barkColor = (p: THREE.Vector3) => low.clone().lerp(high, THREE.MathUtils.smoothstep(p.y, height * 0.3, height * 0.6)).multiplyScalar(0.8 + noise2(seed, p.y * 3, Math.atan2(p.z, p.x) * 3) * 0.35);
  const trunk = [V(0, -0.4, 0), V(lean * 0.2, height * 0.4, 0.1), V(lean * 0.6, height * 0.75, -0.1), V(lean, height, 0)];
  b.add(limb(trunk, 0.3, 0.05, lod === 0 ? 8 : 5, 0.4), IDENTITY, barkColor, barkSway(0.0006));
  const curve = new THREE.CatmullRomCurve3(trunk);
  const d = detail(lod, 26, 0.62);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x2f5a3a), sunlit: C(0x7aa060), bottom: height * 0.55, top: height + 1, centre: V(lean * 0.8, height * 0.82, 0), uv: tileUv(LEAF_TILE.pine), aspect: 0.75 };
  // Зонтичная крона: несколько плоских «облаков» хвои на верхней трети ствола.
  const clumps = lod === 0 ? 7 : 5;
  for (let i = 0; i < clumps; i++) {
    const t = 0.62 + (i / clumps) * 0.36 + rand(seed, 30 + i) * 0.04;
    const from = curve.getPoint(Math.min(1, t));
    const a = i * 2.2 + rand(seed, 31 + i) * 1.2;
    const reach = i === clumps - 1 ? 0.2 : 1.4 + rand(seed, 32 + i) * 1.4;
    const tip = from.clone().add(V(Math.cos(a) * reach, 0.4 + rand(seed, 33 + i) * 0.5, Math.sin(a) * reach));
    if (reach > 0.5) b.add(limb([from, from.clone().lerp(tip, 0.5).add(V(0, 0.25, 0)), tip], 0.09, 0.03, lod === 0 ? 4 : 3, 0, lod === 0 ? 0 : 3), IDENTITY, barkColor, (p) => p.y * 0.004);
    blob(b, tip, V(1.6, 0.75, 1.6), style, i);
    if (lod === 0) blob(b, tip.clone().add(V(0, -0.35, 0)), V(1.1, 0.5, 1.1), { ...style, cards: Math.round(style.cards * 0.6) }, i + 50);
  }
  return b.build();
}

function spruce(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const height = 14 + rand(seed, 1) * 3;
  const bark = C(0x463629);
  b.add(limb([V(0, -0.4, 0), V(0.04, height * 0.5, 0.02), V(0, height, 0)], 0.32, 0.03, lod === 0 ? 7 : 4, 0.45), IDENTITY, (p) => bark.clone().multiplyScalar(0.75 + noise2(seed, p.y * 2, p.x * 6) * 0.5), barkSway(0.0005));
  const dark = C(0x1f4a35);
  const tip = C(0x58905c);
  const uv = tileUv(LEAF_TILE.spruce);
  const tiers = lod === 0 ? 12 : 6;
  const centre = V(0, 0, 0);
  const right = V(0, 0, 0);
  const up = V(0, 0, 0);
  const shade = V(0, 0, 0);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = 1.2 + t * (height - 1.9);
    const reach = (1 - t) ** 0.9 * (3.2 + rand(seed, 50 + i) * 0.5) + 0.35;
    const boughs = Math.round((lod === 0 ? 7 + (1 - t) * 6 : 4 + (1 - t) * 3));
    for (let j = 0; j < boughs; j++) {
      const a = (j / boughs) * Math.PI * 2 + i * 0.7 + rand(seed, i, j, 1) * 0.3;
      const out = V(Math.cos(a), 0, Math.sin(a));
      const length = reach * (0.8 + rand(seed, i, j, 2) * 0.35);
      const droop = 0.4 + rand(seed, i, j, 3) * 0.2 - t * 0.22;
      const along = out.clone().multiplyScalar(Math.cos(droop)).add(V(0, -Math.sin(droop), 0));
      centre.set(0, y, 0).addScaledVector(along, length * 0.5 + 0.1);
      const tone = 0.62 + t * 0.45 + rand(seed, i, j, 4) * 0.12;
      const lo = dark.clone().multiplyScalar(tone * 0.8);
      const hi = dark.clone().lerp(tip, 0.75).multiplyScalar(tone * 1.05);
      shade.copy(out).multiplyScalar(0.55).add(V(0, 0.85, 0)).normalize();
      up.copy(along).multiplyScalar(length * 0.5);
      right.set(-out.z, 0, out.x).multiplyScalar(length * (lod === 0 ? 0.34 : 0.5));
      const sway = 0.02 + t * 0.06;
      b.card(centre, right, up, shade, lo, hi, sway, sway + length * 0.03, rand(seed, i, j, 5), 1, uv);
      if (lod === 0) {
        right.crossVectors(along, V(-out.z, 0, out.x)).normalize().multiplyScalar(length * 0.2);
        b.card(centre, right, up, shade, lo, hi, sway, sway + length * 0.03, rand(seed, i, j, 6), 1, uv);
      }
    }
  }
  b.card(V(0, height + 0.45, 0), V(0.36, 0, 0), V(0, 0.9, 0), V(0, 1, 0), dark, tip, 0.08, 0.12, 0.1, 1, uv);
  b.card(V(0, height + 0.45, 0), V(0, 0, 0.36), V(0, 0.9, 0), V(0, 1, 0), dark, tip, 0.08, 0.12, 0.2, 1, uv);
  return b.build();
}

function oak(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const bark = C(0x55412f);
  const barkDark = C(0x382a1f);
  const barkColor = (p: THREE.Vector3) => bark.clone().lerp(barkDark, noise2(seed, p.y * 1.4, Math.atan2(p.z, p.x) * 2.5)).multiplyScalar(0.8 + Math.min(1, p.y / 5) * 0.3);
  const lean = (rand(seed, 1) - 0.5) * 0.8;
  const fork = V(lean, 3.6, (rand(seed, 2) - 0.5) * 0.8);
  b.add(limb([V(0, -0.4, 0), V(lean * 0.2, 1.4, 0.1), V(lean * 0.7, 2.8, fork.z * 0.6), fork], 0.62, 0.4, lod === 0 ? 10 : 5, 0.7, lod === 0 ? 0 : 5), IDENTITY, barkColor, barkSway(0.0003));
  const d = detail(lod, 70, 0.9);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x3a7030), sunlit: C(0x93ba4a), bottom: 4, top: 12, centre: V(lean, 7.4, fork.z), uv: tileUv(LEAF_TILE.oak) };
  // Несколько мощных боковых ветвей и широкая неровная крона — признак дуба.
  const limbs = lod === 0 ? 6 : 5;
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rand(seed, 10 + i) * 0.8;
    const reach = i === 0 ? 0.3 : 2.6 + rand(seed, 20 + i) * 1.5;
    const centre = V(fork.x + Math.cos(a) * reach, i === 0 ? 9.6 : 6.4 + rand(seed, 30 + i) * 2.2, fork.z + Math.sin(a) * reach);
    const radius = i === 0 ? 2.9 : 2.2 + rand(seed, 40 + i) * 0.9;
    const elbow = fork.clone().lerp(centre, 0.5).add(V(0, i === 0 ? 0.6 : -0.3, 0));
    if (lod === 0 || i > 0) b.add(limb([fork.clone().add(V(0, -0.5, 0)), elbow, centre.clone().add(V(0, -0.5, 0))], lod === 0 ? 0.3 : 0.26, 0.08, lod === 0 ? 6 : 3, 0, lod === 0 ? 0 : 3), IDENTITY, barkColor, (p) => p.y * 0.006);
    blob(b, centre, V(radius, radius * 0.78, radius), style, i);
  }
  return b.build();
}

function linden(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const height = 12.5 + rand(seed, 1) * 1.5;
  const bark = C(0x4e4337);
  const barkColor = (p: THREE.Vector3) => bark.clone().multiplyScalar(0.8 + noise2(seed, p.y * 4, Math.atan2(p.z, p.x) * 2) * 0.35);
  const trunk = [V(0, -0.4, 0), V(0.05, height * 0.3, 0), V(0.1, height * 0.62, 0.05)];
  b.add(limb(trunk, 0.42, 0.18, lod === 0 ? 8 : 5, 0.5), IDENTITY, barkColor, barkSway(0.0004));
  const d = detail(lod, 60, 0.72);
  const top = V(0.1, height * 0.62, 0.05);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x467e34), sunlit: C(0xa6c652), bottom: height * 0.28, top: height + 0.5, centre: V(0.1, height * 0.64, 0.05), uv: tileUv(LEAF_TILE.linden) };
  // Густая правильная яйцевидная крона: блоки уложены по эллипсоиду.
  const pieces = lod === 0 ? 9 : 6;
  for (let i = 0; i < pieces; i++) {
    const a = (i / pieces) * Math.PI * 2 + rand(seed, 60 + i) * 0.5;
    const ring = i % 3;
    const y = height * (0.45 + ring * 0.17) + rand(seed, 61 + i) * 0.6;
    const r = (ring === 2 ? 1.4 : 2.3) + rand(seed, 62 + i) * 0.5;
    const centre = V(top.x + Math.cos(a) * r, y, top.z + Math.sin(a) * r);
    b.add(limb([top, top.clone().lerp(centre, 0.6).add(V(0, 0.4, 0)), centre], 0.16, 0.05, lod === 0 ? 5 : 3, 0, lod === 0 ? 0 : 3), IDENTITY, barkColor, (p) => p.y * 0.006);
    blob(b, centre, V(2.0, 1.9, 2.0), style, i);
  }
  blob(b, V(top.x, height * 0.92, top.z), V(1.9, 1.5, 1.9), style, 30);
  return b.build();
}

function alder(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const height = 10.5 + rand(seed, 1) * 1.5;
  const bark = C(0x4b4640);
  const barkColor = (p: THREE.Vector3) => bark.clone().multiplyScalar(0.75 + noise2(seed, p.y * 3, Math.atan2(p.z, p.x) * 3) * 0.4);
  // Ольха часто растёт в 1–3 ствола.
  const stems = 1 + Math.floor(rand(seed, 2) * 2.4);
  const d = detail(lod, 36, 0.55);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x2f5e2c), sunlit: C(0x77a048), bottom: height * 0.3, top: height + 0.8, centre: V(0, height * 0.65, 0), uv: tileUv(LEAF_TILE.alder) };
  for (let k = 0; k < stems; k++) {
    const a = rand(seed, 3, k) * Math.PI * 2;
    const off = stems === 1 ? 0 : 0.35;
    const h = height * (k === 0 ? 1 : 0.8 + rand(seed, 4, k) * 0.15);
    const base = V(Math.cos(a) * off * 0.4, -0.4, Math.sin(a) * off * 0.4);
    const topP = V(Math.cos(a) * off * 2.4, h, Math.sin(a) * off * 2.4);
    const trunk = [base, base.clone().lerp(topP, 0.5).add(V(0.1, 0, -0.1)), topP];
    b.add(limb(trunk, stems === 1 ? 0.22 : 0.16, 0.03, lod === 0 ? 7 : 4, 0.3), IDENTITY, barkColor, barkSway(0.0009));
    const curve = new THREE.CatmullRomCurve3(trunk);
    const pieces = lod === 0 ? 5 : 3;
    for (let i = 0; i < pieces; i++) {
      const t = 0.42 + (i / pieces) * 0.55;
      const c = curve.getPoint(t);
      const aa = i * 2.5 + rand(seed, 70 + i, k) * 1.0;
      const r = 1.0 * (1.1 - t) + 0.4;
      const end = c.clone().add(V(Math.cos(aa) * r, 0.3, Math.sin(aa) * r));
      b.add(limb([c, c.clone().lerp(end, 0.5).add(V(0, 0.25, 0)), end], 0.06, 0.015, 3, 0, 3), IDENTITY, barkColor, (p) => p.y * 0.01);
      blob(b, end, V(1.45, 1.6, 1.45), style, i + k * 10);
    }
  }
  return b.build();
}

// ───────── кустарники ─────────

function hazel(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const stem = C(0x6b5644);
  const d = detail(lod, 28, 0.42);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x4a7d36), sunlit: C(0x9cc256), bottom: 0.8, top: 4.6, centre: V(0, 2.6, 0), uv: tileUv(LEAF_TILE.linden) };
  // Много стволиков веером из одного места — форма «вазы».
  const stems = lod === 0 ? 8 : 5;
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + rand(seed, i) * 0.6;
    const out = 0.9 + rand(seed, 10 + i) * 0.9;
    const h = 3.4 + rand(seed, 20 + i) * 1.0;
    const tip = V(Math.cos(a) * out * 1.4, h, Math.sin(a) * out * 1.4);
    b.add(limb([V(0, -0.2, 0), V(Math.cos(a) * out * 0.5, h * 0.45, Math.sin(a) * out * 0.5), tip], 0.05, 0.015, lod === 0 ? 4 : 3, 0, lod === 0 ? 0 : 3), IDENTITY, stem, (p) => p.y * 0.02);
    blob(b, tip.clone().add(V(0, -0.5, 0)), V(1.0, 0.9, 1.0), style, i);
  }
  return b.build();
}

function wildRose(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const cane = C(0x6d4a36);
  const d = detail(lod, 24, 0.24);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x3e7234), sunlit: C(0x8fb852), bottom: 0, top: 2, centre: V(0, 0.8, 0), uv: tileUv(LEAF_TILE.birch) };
  const blossom = C(0xf08cb0);
  // Дугообразные побеги: низкая плотная «подушка», цветы и плоды по поверхности.
  const canes = lod === 0 ? 7 : 4;
  for (let i = 0; i < canes; i++) {
    const a = (i / canes) * Math.PI * 2 + rand(seed, i) * 0.7;
    const reach = 0.9 + rand(seed, 10 + i) * 0.5;
    const peak = V(Math.cos(a) * reach * 0.5, 1.5 + rand(seed, 20 + i) * 0.4, Math.sin(a) * reach * 0.5);
    const end = V(Math.cos(a) * reach * 1.2, 0.7, Math.sin(a) * reach * 1.2);
    if (lod === 0) b.add(limb([V(0, -0.1, 0), peak, end], 0.025, 0.012, 3), IDENTITY, cane, (p) => p.y * 0.03);
    const c = peak.clone().lerp(end, 0.5);
    blob(b, c, V(0.6, 0.5, 0.6), style, i);
    const flowers = lod === 0 ? 6 : 2;
    for (let k = 0; k < flowers; k++) {
      const u = rand(seed, i, k, 1) * Math.PI * 2;
      const y = rand(seed, i, k, 2) * 0.8;
      const rr = Math.sqrt(1 - y * y) * 0.6;
      const m = new THREE.Matrix4().makeTranslation(c.x + Math.cos(u) * rr, c.y + y * 0.45, c.z + Math.sin(u) * rr);
      b.add(new THREE.OctahedronGeometry(lod === 0 ? 0.06 : 0.1, 0), m, blossom, 0.05, 2, rand(seed, i, k, 3));
    }
  }
  return b.build();
}

function willow(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const rod = C(0x7a5a3c);
  const d = detail(lod, 16, 0.38);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x5d7f4e), sunlit: C(0xb2c58c), bottom: 0.5, top: 3.8, centre: V(0, 2.1, 0), uv: tileUv(LEAF_TILE.willow), aspect: 1.2 };
  // Пучок прямых тонких прутьев, крона округлая, листья узкие серебристые.
  const rods = lod === 0 ? 12 : 6;
  for (let i = 0; i < rods; i++) {
    const a = rand(seed, i, 1) * Math.PI * 2;
    const out = 0.3 + rand(seed, i, 2) * 0.9;
    const h = 2.6 + rand(seed, i, 3) * 1.0;
    const tip = V(Math.cos(a) * out, h, Math.sin(a) * out);
    if (lod === 0 || i % 2 === 0) b.add(limb([V(Math.cos(a) * 0.1, -0.1, Math.sin(a) * 0.1), tip.clone().multiplyScalar(0.5), tip], 0.025, 0.008, 3, 0, lod === 0 ? 0 : 3), IDENTITY, rod, (p) => p.y * 0.04);
    blob(b, tip.clone().add(V(0, -0.6, 0)), V(0.65, 0.95, 0.65), style, i);
  }
  return b.build();
}

function juniper(seed: number, lod: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const height = 2.6 + rand(seed, 1) * 0.6;
  const bark = C(0x5a4636);
  b.add(limb([V(0, -0.2, 0), V(0.05, height * 0.5, 0), V(0, height * 0.85, 0)], 0.09, 0.02, lod === 0 ? 5 : 3), IDENTITY, bark, barkSway(0.004));
  const d = detail(lod, 30, 0.34);
  const style: CrownStyle = { seed, cards: d.cards, size: d.size, base: C(0x27503f), sunlit: C(0x5f8f74), bottom: 0, top: height, centre: V(0, height * 0.5, 0), uv: tileUv(LEAF_TILE.juniper) };
  // Колонновидный или раскидистый — по экземпляру.
  const columnar = rand(seed, 3) < 0.6;
  const pieces = lod === 0 ? 6 : 3;
  for (let i = 0; i < pieces; i++) {
    const t = (i + 0.5) / pieces;
    const spread = columnar ? 0.35 : 0.8;
    const a = i * 2.4 + rand(seed, 40 + i);
    blob(b, V(Math.cos(a) * spread * (1 - t * 0.5), height * t * 0.95, Math.sin(a) * spread * (1 - t * 0.5)), V(columnar ? 0.55 : 0.85, 0.6, columnar ? 0.55 : 0.85).multiplyScalar(1 - t * 0.35), style, i);
  }
  return b.build();
}

/** Профили видов по id каталога. */
export const WOODY_PROFILES: Record<string, WoodyProfile> = {
  birch: { id: 'birch', evergreen: false, tile: LEAF_TILE.birch, summer: C(0xffffff), spring: C(0xd8f0a0), autumn: C(0xf2c23a), wind: 1.35, impostor: { shape: 'oval', crownBase: 0.62, trunk: '#e7e2d6', leaf: [118, 160, 66], bare: true }, build: birch },
  pine: { id: 'pine', evergreen: true, tile: LEAF_TILE.pine, summer: C(0xffffff), spring: C(0xf0ffe8), autumn: C(0xf2f0e0), wind: 0.7, impostor: { shape: 'umbrella', crownBase: 0.4, trunk: '#a8603a', leaf: [62, 100, 64], bare: false }, build: pine },
  spruce: { id: 'spruce', evergreen: true, tile: LEAF_TILE.spruce, summer: C(0xffffff), spring: C(0xf2ffec), autumn: C(0xf0f0e8), wind: 0.55, impostor: { shape: 'cone', crownBase: 0.94, trunk: '#4a3a2c', leaf: [38, 78, 56], bare: false }, build: spruce },
  oak: { id: 'oak', evergreen: false, tile: LEAF_TILE.oak, summer: C(0xffffff), spring: C(0xe4f0a4), autumn: C(0xc8843a), wind: 0.55, impostor: { shape: 'round', crownBase: 0.68, trunk: '#4c3a2b', leaf: [72, 116, 52], bare: true }, build: oak },
  linden: { id: 'linden', evergreen: false, tile: LEAF_TILE.linden, summer: C(0xffffff), spring: C(0xe0f4a0), autumn: C(0xe8c04a), wind: 0.75, impostor: { shape: 'round', crownBase: 0.75, trunk: '#4e4337', leaf: [86, 132, 60], bare: true }, build: linden },
  alder: { id: 'alder', evergreen: false, tile: LEAF_TILE.alder, summer: C(0xffffff), spring: C(0xd8eca0), autumn: C(0x9a9a4a), wind: 0.9, impostor: { shape: 'oval', crownBase: 0.7, trunk: '#4b4640', leaf: [56, 96, 50], bare: true }, build: alder },
  hazel: { id: 'hazel', evergreen: false, tile: LEAF_TILE.linden, summer: C(0xffffff), spring: C(0xe0f0a0), autumn: C(0xe6c450), wind: 1.0, impostor: { shape: 'bush', crownBase: 0.85, trunk: '#6b5644', leaf: [84, 128, 60], bare: true }, build: hazel },
  'wild-rose': { id: 'wild-rose', evergreen: false, tile: LEAF_TILE.birch, summer: C(0xffffff), spring: C(0xe4f2b0), autumn: C(0xd06a3a), blossom: { color: C(0xf08cb0), from: 0.2, to: 0.45, fruit: C(0xc0282a) }, wind: 0.8, impostor: { shape: 'bush', crownBase: 0.9, trunk: '#6d4a36', leaf: [72, 116, 58], bare: true }, build: wildRose },
  'willow-shrub': { id: 'willow-shrub', evergreen: false, tile: LEAF_TILE.willow, summer: C(0xffffff), spring: C(0xe4f2b8), autumn: C(0xd8c66a), wind: 1.4, impostor: { shape: 'bush', crownBase: 0.85, trunk: '#7a5a3c', leaf: [118, 140, 98], bare: true }, build: willow },
  juniper: { id: 'juniper', evergreen: true, tile: LEAF_TILE.juniper, summer: C(0xffffff), spring: C(0xf0fff4), autumn: C(0xf0f0ee), wind: 0.4, impostor: { shape: 'column', crownBase: 0.98, trunk: '#5a4636', leaf: [44, 82, 66], bare: false }, build: juniper },
};

/** Размер модели (для растяжения до размеров из симуляции): высота верхушки и радиус кроны. */
export function modelExtent(g: THREE.BufferGeometry): { height: number; crown: number } {
  const pos = g.getAttribute('position');
  const extra = g.getAttribute('extra');
  let height = 0;
  let crown = 0;
  for (let i = 0; i < pos.count; i++) {
    height = Math.max(height, pos.getY(i));
    if (extra.getY(i) >= 1) crown = Math.max(crown, Math.hypot(pos.getX(i), pos.getZ(i)));
  }
  return { height, crown: crown * 0.85 };
}
