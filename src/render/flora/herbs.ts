// Травы и цветы каталога (собственная работа проекта): у каждого вида своя форма пучка.
// part = 2 — цветки и соцветия: они видны только в окно цветения вида (сезон берётся из времени мира).
// Цвет листьев пучка — из вершин, множитель по сезону — из экземпляра.

import * as THREE from 'three/webgpu';
import { C, GeoBuilder, V, rand } from './geometry';

const UP = V(0, 1, 0);

export interface HerbProfile {
  id: string;
  /** Пучки (варианты геометрии). Экземпляр выбирает вариант по номеру. */
  build(): THREE.BufferGeometry[];
  /** Сколько граммов биомассы на один пучок (плотность пучков = биомасса / это число на м²). */
  gramsPerTuft: number;
  /** Высота пучка при биомассе 50 и 400 г/м² (м) — по тому, насколько травостой развит. */
  heightLow: number;
  heightHigh: number;
  /** Окно цветения в долях года (весна — 0..0,25, лето — 0,25..0,5, осень — 0,5..0,75). */
  bloom: [number, number] | null;
  /** Осенний цвет травы (множитель к цвету вершин). */
  autumn: THREE.Color;
  wind: number;
}

/** Изогнутая лента-лист из трёх сегментов (основание → изгиб → кончик). */
function blade(b: GeoBuilder, ox: number, oz: number, dir: number, h: number, w: number, lean: number, base: THREE.Color, tip: THREE.Color, rnd: number, part = 1): void {
  const fx = Math.cos(dir);
  const fz = Math.sin(dir);
  const px = -fz;
  const pz = fx;
  const pts: THREE.Vector3[] = [];
  const segs = 3;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const bend = lean * t * t;
    pts.push(V(ox + fx * bend * h, h * t * (1 - 0.25 * lean * t), oz + fz * bend * h));
  }
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs;
    const t1 = (k + 1) / segs;
    const w0 = w * (1 - t0 * 0.85);
    const w1 = w * (1 - t1 * 0.85);
    const a = pts[k]!;
    const c = pts[k + 1]!;
    const c0 = base.clone().lerp(tip, t0);
    const c1 = base.clone().lerp(tip, t1);
    const al = V(a.x - px * w0, a.y, a.z - pz * w0);
    const ar = V(a.x + px * w0, a.y, a.z + pz * w0);
    const cl = V(c.x - px * w1, c.y, c.z - pz * w1);
    const cr = V(c.x + px * w1, c.y, c.z + pz * w1);
    if (k === segs - 1) {
      b.tri(al, ar, c, UP, [c0, c0, c1], [0, t0, 1, t0, 0.5, 1], [t0 * t0, t0 * t0, 1], part, rnd);
    } else {
      b.tri(al, ar, cr, UP, [c0, c0, c1], [0, t0, 1, t0, 1, t1], [t0 * t0, t0 * t0, t1 * t1], part, rnd);
      b.tri(al, cr, cl, UP, [c0, c1, c1], [0, t0, 1, t1, 0, t1], [t0 * t0, t1 * t1, t1 * t1], part, rnd);
    }
  }
}

/** Плоский цветок из лепестков на высоте y. */
function flower(b: GeoBuilder, x: number, y: number, z: number, r: number, petals: number, petal: THREE.Color, core: THREE.Color, rnd: number, cup = 0): void {
  for (let k = 0; k < petals; k++) {
    const a = (k / petals) * Math.PI * 2;
    const a2 = a + (Math.PI * 2) / petals * 0.8;
    b.tri(V(x, y, z), V(x + Math.cos(a) * r, y + cup + 0.01, z + Math.sin(a) * r), V(x + Math.cos(a2) * r, y + cup + 0.01, z + Math.sin(a2) * r), UP, [petal, petal, petal], [0, 0, 1, 0, 0.5, 1], [1, 1, 1], 2, rnd);
  }
  const cr = r * 0.32;
  b.tri(V(x - cr, y + 0.012, z), V(x + cr, y + 0.012, z), V(x, y + 0.02, z + cr), UP, [core, core, core], [0, 0, 1, 0, 0.5, 1], [1, 1, 1], 2, rnd);
}

function stem(b: GeoBuilder, x: number, z: number, h: number, w: number, color: THREE.Color, lean = 0, dir = 0): THREE.Vector3 {
  const top = V(x + Math.cos(dir) * lean * h, h, z + Math.sin(dir) * lean * h);
  b.tri(V(x - w, 0, z), V(x + w, 0, z), top, UP, [color, color, color], [0, 0, 1, 0, 0.5, 1], [0, 0, 1], 1, 0);
  b.tri(V(x, 0, z - w), V(x, 0, z + w), top, UP, [color, color, color], [0, 0, 1, 0, 0.5, 1], [0, 0, 1], 1, 0);
  return top;
}

// Высоты пучков даны для эталона 1 м: экземпляр растягивается по высоте травостоя.

function meadowGrass(): THREE.BufferGeometry[] {
  return [0, 1].map((v) => {
    const b = new GeoBuilder();
    const base = C(0x4c7a34);
    const tip = C(0xa8c868);
    const blades = 9;
    for (let k = 0; k < blades; k++) {
      const a = k * 2.39 + v;
      const r = 0.06 + rand(1, v, k) * 0.1;
      blade(b, Math.cos(a) * r, Math.sin(a) * r, a + rand(2, v, k), 0.55 + rand(3, v, k) * 0.45, 0.022, 0.35 + rand(4, v, k) * 0.3, base, tip, 0);
    }
    // Метёлки мятлика — летом.
    for (let k = 0; k < 2; k++) {
      const a = k * 3.1 + v;
      const top = stem(b, Math.cos(a) * 0.05, Math.sin(a) * 0.05, 1.0, 0.006, C(0x8aa860), 0.12, a);
      for (let j = 0; j < 5; j++) {
        const t = j / 5;
        const y = top.y - 0.22 + t * 0.22;
        const s = 0.07 * (1 - t);
        const aa = j * 1.9;
        b.tri(V(top.x, y, top.z), V(top.x + Math.cos(aa) * s, y - 0.05, top.z + Math.sin(aa) * s), V(top.x + Math.cos(aa + 0.4) * s, y - 0.03, top.z + Math.sin(aa + 0.4) * s), UP, [C(0xb8a878), C(0xc8b888), C(0xc8b888)], [0, 0, 1, 0, 0.5, 1], [1, 1, 1], 2, 0.3 + j * 0.1);
      }
    }
    return b.build();
  });
}

function featherGrass(): THREE.BufferGeometry[] {
  return [0, 1].map((v) => {
    const b = new GeoBuilder();
    const base = C(0x7a8a4c);
    const tip = C(0xb8bc84);
    for (let k = 0; k < 10; k++) {
      const a = k * 2.39 + v * 0.7;
      blade(b, Math.cos(a) * 0.05, Math.sin(a) * 0.05, a, 0.45 + rand(11, v, k) * 0.2, 0.01, 0.5, base, tip, 0);
    }
    // Длинные серебристые перистые ости, дугой — главный признак ковыля.
    const plume = C(0xeeeee0);
    for (let k = 0; k < 6; k++) {
      const a = k * 1.05 + v;
      blade(b, Math.cos(a) * 0.03, Math.sin(a) * 0.03, a, 0.95 + rand(12, v, k) * 0.15, 0.03, 1.1, C(0xc8c8a8), plume, 0.2 + k * 0.1, 2);
    }
    return b.build();
  });
}

function sedge(): THREE.BufferGeometry[] {
  return [0].map((v) => {
    const b = new GeoBuilder();
    const base = C(0x3a6030);
    const tip = C(0x7c9a50);
    for (let k = 0; k < 12; k++) {
      const a = k * 2.39;
      blade(b, Math.cos(a) * 0.06, Math.sin(a) * 0.06, a, 0.75 + rand(21, v, k) * 0.35, 0.03, 0.18 + rand(22, v, k) * 0.15, base, tip, 0);
    }
    // Бурые колоски.
    for (let k = 0; k < 3; k++) {
      const a = k * 2.1;
      const top = stem(b, Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0.95, 0.006, C(0x5a6a3a), 0.06, a);
      b.add(new THREE.CylinderGeometry(0.022, 0.016, 0.14, 5), new THREE.Matrix4().makeTranslation(top.x, top.y, top.z), C(0x6a4a2a), 1, 2, 0.4);
    }
    return b.build();
  });
}

function clover(): THREE.BufferGeometry[] {
  return [0, 1].map((v) => {
    const b = new GeoBuilder();
    const leaf = C(0x4a8a3a);
    // Тройчатые листья низко у земли.
    for (let k = 0; k < 7; k++) {
      const a = k * 2.39 + v;
      const r = 0.05 + rand(31, v, k) * 0.12;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = 0.25 + rand(32, v, k) * 0.2;
      stem(b, x, z, y, 0.004, C(0x5a8a40));
      for (let j = 0; j < 3; j++) {
        const aa = a + (j / 3) * Math.PI * 2;
        const s = 0.06;
        const cx = x + Math.cos(aa) * s * 0.6;
        const cz = z + Math.sin(aa) * s * 0.6;
        b.tri(V(x, y, z), V(cx + Math.cos(aa + 1) * s * 0.5, y + 0.01, cz + Math.sin(aa + 1) * s * 0.5), V(cx + Math.cos(aa) * s * 0.7, y + 0.015, cz + Math.sin(aa) * s * 0.7), UP, [leaf, leaf, leaf.clone().multiplyScalar(1.2)], [0, 0, 1, 0, 0.5, 1], [0.6, 0.7, 0.7], 1, 0);
        b.tri(V(x, y, z), V(cx + Math.cos(aa) * s * 0.7, y + 0.015, cz + Math.sin(aa) * s * 0.7), V(cx + Math.cos(aa - 1) * s * 0.5, y + 0.01, cz + Math.sin(aa - 1) * s * 0.5), UP, [leaf, leaf.clone().multiplyScalar(1.2), leaf], [0, 0, 1, 0, 0.5, 1], [0.6, 0.7, 0.7], 1, 0);
      }
    }
    // Шаровидные головки: розовые и белые.
    const head = v === 0 ? C(0xd8709a) : C(0xf0eef0);
    for (let k = 0; k < 3; k++) {
      const a = k * 2.0 + v * 0.5;
      const top = stem(b, Math.cos(a) * 0.08, Math.sin(a) * 0.08, 0.5 + k * 0.06, 0.004, C(0x5a8a40));
      b.add(new THREE.IcosahedronGeometry(0.045, 0), new THREE.Matrix4().makeTranslation(top.x, top.y + 0.02, top.z), head, 1, 2, 0.2 + k * 0.2);
    }
    return b.build();
  });
}

/** Луговые цветы — смесь: ромашка, лютик, василёк, колокольчик (вариант выбирает экземпляр). */
function meadowFlowers(): THREE.BufferGeometry[] {
  const kinds: [THREE.Color, THREE.Color, number, number, number][] = [
    [C(0xffffff), C(0xf2c230), 9, 0.07, 0], // ромашка
    [C(0xf8d02a), C(0xe0a020), 5, 0.045, 0.015], // лютик
    [C(0x4c6ee0), C(0x30307a), 8, 0.05, 0.005], // василёк
    [C(0x9a70d8), C(0x6a48a8), 5, 0.04, 0.035], // колокольчик
  ];
  return kinds.map(([petal, core, petals, r, cup], v) => {
    const b = new GeoBuilder();
    const leaf = C(0x4f8a3a);
    for (let k = 0; k < 5; k++) {
      const a = k * 2.39 + v;
      blade(b, Math.cos(a) * 0.04, Math.sin(a) * 0.04, a, 0.3 + rand(41, v, k) * 0.15, 0.025, 0.6, leaf, leaf.clone().multiplyScalar(1.25), 0);
    }
    const heads = 3;
    for (let k = 0; k < heads; k++) {
      const a = k * 2.2 + v;
      const h = 0.65 + rand(42, v, k) * 0.35;
      const top = stem(b, Math.cos(a) * 0.07, Math.sin(a) * 0.07, h, 0.006, C(0x4e7f34), 0.08, a);
      flower(b, top.x, top.y, top.z, r * 1.3, petals, petal, core, 0.15 + k * 0.25, cup);
    }
    return b.build();
  });
}

function fireweed(): THREE.BufferGeometry[] {
  return [0, 1].map((v) => {
    const b = new GeoBuilder();
    const leafC = C(0x3f6e34);
    const pink = C(0xd64c9a);
    // Высокий прямой стебель с ланцетными листьями и пурпурной кистью наверху.
    const stems = 2 + v;
    for (let s = 0; s < stems; s++) {
      const a = s * 2.4 + v;
      const x = Math.cos(a) * 0.06;
      const z = Math.sin(a) * 0.06;
      const top = stem(b, x, z, 1.0, 0.008, C(0x6a3a3a), 0.03, a);
      for (let k = 0; k < 7; k++) {
        const y = 0.15 + k * 0.09;
        const aa = k * 2.39 + s;
        // Лист — лента, отходящая в сторону.
        const len = 0.16 * (1 - k * 0.08);
        b.tri(V(x, y, z), V(x + Math.cos(aa) * len, y + 0.04, z + Math.sin(aa) * len), V(x + Math.cos(aa + 0.25) * len * 0.5, y + 0.015, z + Math.sin(aa + 0.25) * len * 0.5), UP, [leafC, leafC.clone().multiplyScalar(1.2), leafC], [0, 0, 1, 0, 0.5, 1], [y, y + 0.1, y], 1, 0);
      }
      for (let k = 0; k < 9; k++) {
        const t = k / 9;
        const y = top.y - 0.3 + t * 0.3;
        const aa = k * 2.3 + s;
        const r = 0.05 * (1 - t * 0.6);
        b.tri(V(top.x, y, top.z), V(top.x + Math.cos(aa) * r, y + 0.03, top.z + Math.sin(aa) * r), V(top.x + Math.cos(aa + 0.8) * r, y + 0.03, top.z + Math.sin(aa + 0.8) * r), UP, [pink, pink, pink.clone().multiplyScalar(1.15)], [0, 0, 1, 0, 0.5, 1], [1, 1, 1], 2, t * 0.9);
      }
    }
    return b.build();
  });
}

function bilberry(): THREE.BufferGeometry[] {
  return [0].map(() => {
    const b = new GeoBuilder();
    const leaf = C(0x3e7a36);
    // Низкий кустарничек: ветвистые зелёные побеги с мелкими овальными листьями, синие ягоды к концу лета.
    for (let k = 0; k < 6; k++) {
      const a = k * 1.05;
      const top = stem(b, Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0.8, 0.008, C(0x4a7a30), 0.35, a);
      for (let j = 0; j < 5; j++) {
        const t = 0.3 + j * 0.14;
        const x = top.x * t;
        const z = top.z * t;
        const y = top.y * t;
        const aa = j * 2.39 + k;
        const s = 0.07;
        b.tri(V(x, y, z), V(x + Math.cos(aa) * s, y + 0.03, z + Math.sin(aa) * s), V(x + Math.cos(aa + 0.6) * s, y + 0.02, z + Math.sin(aa + 0.6) * s), UP, [leaf, leaf.clone().multiplyScalar(1.25), leaf], [0, 0, 1, 0, 0.5, 1], [t, t, t], 1, 0);
      }
      b.add(new THREE.IcosahedronGeometry(0.03, 0), new THREE.Matrix4().makeTranslation(top.x * 0.7, top.y * 0.62, top.z * 0.7), C(0x2a3a7a), 0.4, 2, k / 6);
    }
    return b.build();
  });
}

function moss(): THREE.BufferGeometry[] {
  return [0].map(() => {
    const b = new GeoBuilder();
    // Подушки мха: низкие купола из коротких «щёточек».
    for (let k = 0; k < 5; k++) {
      const a = k * 2.39;
      const r = k === 0 ? 0 : 0.12;
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const dome = new THREE.SphereGeometry(0.11, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
      const tone = 0.85 + rand(61, k) * 0.3;
      b.add(dome, new THREE.Matrix4().makeTranslation(cx, -0.02, cz).multiply(new THREE.Matrix4().makeScale(1, 0.6, 1)), C(0x5e8c34).multiplyScalar(tone), 0.05, 1, 0);
    }
    return b.build();
  });
}

const H = (hex: number) => C(hex);

export const HERB_PROFILES: Record<string, HerbProfile> = {
  'meadow-grass': { id: 'meadow-grass', build: meadowGrass, gramsPerTuft: 7, heightLow: 0.25, heightHigh: 0.7, bloom: [0.3, 0.5], autumn: H(0xd8c070), wind: 1.0 },
  'feather-grass': { id: 'feather-grass', build: featherGrass, gramsPerTuft: 9, heightLow: 0.35, heightHigh: 0.85, bloom: [0.27, 0.6], autumn: H(0xe0d090), wind: 1.3 },
  sedge: { id: 'sedge', build: sedge, gramsPerTuft: 10, heightLow: 0.35, heightHigh: 0.9, bloom: [0.2, 0.55], autumn: H(0xb8a860), wind: 0.7 },
  clover: { id: 'clover', build: clover, gramsPerTuft: 5, heightLow: 0.12, heightHigh: 0.3, bloom: [0.25, 0.58], autumn: H(0xb0a860), wind: 0.5 },
  'meadow-flowers': { id: 'meadow-flowers', build: meadowFlowers, gramsPerTuft: 7, heightLow: 0.25, heightHigh: 0.6, bloom: [0.15, 0.55], autumn: H(0xc8b068), wind: 0.9 },
  fireweed: { id: 'fireweed', build: fireweed, gramsPerTuft: 18, heightLow: 0.5, heightHigh: 1.4, bloom: [0.32, 0.58], autumn: H(0xc85a3a), wind: 0.8 },
  bilberry: { id: 'bilberry', build: bilberry, gramsPerTuft: 9, heightLow: 0.15, heightHigh: 0.32, bloom: [0.45, 0.66], autumn: H(0xc0503a), wind: 0.35 },
  moss: { id: 'moss', build: moss, gramsPerTuft: 6, heightLow: 0.6, heightHigh: 1.0, bloom: null, autumn: H(0xf0f0e0), wind: 0 },
};
