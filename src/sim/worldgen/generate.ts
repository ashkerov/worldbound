// Конвейер генерации мира из seed (ARCHITECTURE.md, раздел 8.1):
// каркас рельефа с естественными границами → эрозия → озёрные котловины → климат →
// гидрология (реки, озёра, море) → почвы → залежи → провинции → рельеф 2 м → горизонт.
// Только детерминированная арифметика: один seed даёт побитно одинаковый мир в любом движке.

import { clamp, clamp01, smoothstep } from '../../shared/dmath';
import { Rng } from '../../shared/rng';
import { CELL_SIZE, HEIGHT_SPACING, WORLD_SIZES, type ClimateName, type WorldConfig } from '../../shared/worldConfig';
import { SOILS, SOIL } from '../env/soils';
import { StateHasher } from '../core/hash';
import { DX8, DZ8, priorityFlood } from './flood';
import { DepositKind, EdgeKind, WaterKind, type Edges, type Geo, type Lake, type Province, type ProvinceKind } from './geo';
import { provinceName } from './names';
import { Fbm, Noise2, Ridged, hashNoise } from './noise';

/** Версия генератора. Меняется при любом изменении результата генерации — старые сохранения тогда не открываются как «тот же мир». */
export const WORLDGEN_VERSION = 1;

export type ProgressFn = (stage: string, fraction: number) => void;

const DIAG = 1.4142135623730951;
/** Длина года по умолчанию в игровых часах — нормировка расхода для геометрии рек (не зависит от настройки сезона). */
const REF_HOURS_PER_YEAR = 480;

const CLIMATE: Record<ClimateName, { t0: number; amp: number; precip: number }> = {
  cold: { t0: 1.5, amp: 13, precip: 560 },
  temperate: { t0: 8.5, amp: 10.5, precip: 760 },
  warm: { t0: 15.5, amp: 7.5, precip: 880 },
};

interface ShapeNoise {
  warpX: Fbm;
  warpZ: Fbm;
  base: Fbm;
  hillMask: Fbm;
  hills: Ridged;
  bend: Fbm[];
  wobble: Fbm[];
  wobbleFine: Fbm[];
  range: Ridged[];
}

interface Shape {
  seed: number;
  size: number;
  edges: Edges;
  seaBand: number;
  mountainBand: number;
  noise: ShapeNoise;
}

function shapeNoise(seed: number): ShapeNoise {
  const per = <T>(make: (e: number) => T) => [0, 1, 2, 3].map(make);
  return {
    warpX: new Fbm(seed, 1, 3),
    warpZ: new Fbm(seed, 2, 3),
    base: new Fbm(seed, 3, 5),
    hillMask: new Fbm(seed, 4, 3),
    hills: new Ridged(seed, 5, 4),
    bend: per((e) => new Fbm(seed, 18 + e, 2)),
    wobble: per((e) => new Fbm(seed, 10 + e, 3)),
    wobbleFine: per((e) => new Fbm(seed, 14 + e, 3)),
    range: per((e) => new Ridged(seed, 20 + e, 5)),
  };
}

function chooseEdges(rng: Rng): Edges {
  // Хотя бы один край — море (реки должны куда-то впадать) и хотя бы один — горы.
  const patterns: EdgeKind[][] = [
    [EdgeKind.Sea, EdgeKind.Mountains, EdgeKind.Mountains, EdgeKind.Mountains],
    [EdgeKind.Sea, EdgeKind.Sea, EdgeKind.Mountains, EdgeKind.Mountains],
    [EdgeKind.Sea, EdgeKind.Mountains, EdgeKind.Sea, EdgeKind.Mountains],
    [EdgeKind.Sea, EdgeKind.Sea, EdgeKind.Sea, EdgeKind.Mountains],
  ];
  const weights = [3, 4, 1, 1];
  let pick = rng.next() * 9;
  let p = 0;
  while (pick >= weights[p]!) pick -= weights[p++]!;
  const base = patterns[p]!;
  const rot = rng.int(4);
  return [base[rot % 4]!, base[(rot + 1) % 4]!, base[(rot + 2) % 4]!, base[(rot + 3) % 4]!] as const;
}

/** Высота каркаса в точке (м). Определена и за границей мира — для горизонта. */
export function macroHeight(s: Shape, x: number, z: number): number {
  const nz = s.noise;
  const wx = x + 320 * nz.warpX.at(x / 2100, z / 2100);
  const wz = z + 320 * nz.warpZ.at(x / 2100 + 7.7, z / 2100 - 3.1);
  let h = 16 + 22 * nz.base.at(wx / 1500, wz / 1500);
  const hillMask = smoothstep(-0.2, 0.45, nz.hillMask.at(wx / 2600, wz / 2600));
  h += hillMask * (30 + 70 * nz.hills.at(wx / 950, wz / 950));
  const size = s.size;
  // Общий уклон суши к морю: вода находит путь к побережью, а не застаивается в огромных котловинах.
  let seaD = Infinity;
  for (let e = 0; e < 4; e++) {
    if (s.edges[e] !== EdgeKind.Sea) continue;
    const d = e === 0 ? z : e === 1 ? size - x : e === 2 ? size - z : x;
    if (d < seaD) seaD = d;
  }
  h += seaD < 4500 ? seaD * 0.011 : 49.5;
  // Сначала горы, затем море: горный край может обрываться в море, но не наоборот.
  for (let pass = 0; pass < 2; pass++) {
    for (let e = 0; e < 4; e++) {
      const kind = s.edges[e]!;
      if ((pass === 0) !== (kind === EdgeKind.Mountains)) continue;
      const d = e === 0 ? z : e === 1 ? size - x : e === 2 ? size - z : x;
      // Дальше полосы с учётом максимального изгиба край не влияет — шум не считается.
      if (d > (kind === EdgeKind.Sea ? s.seaBand : s.mountainBand) + 1300) continue;
      const along = e === 0 || e === 2 ? x : z;
      const bend = kind === EdgeKind.Sea ? 650 * nz.bend[e]!.at(along / 2600, 1.3 * e) : 0;
      const dn = d + bend + 420 * nz.wobble[e]!.at(along / 1700, 0.37 * e + 0.5) + 120 * nz.wobbleFine[e]!.at(along / 420, d / 420);
      if (kind === EdgeKind.Mountains) {
        const t = smoothstep(s.mountainBand, -s.mountainBand * 0.15, dn);
        const m = nz.range[e]!.at(wx / 720, wz / 720);
        h += t * t * (210 + 520 * m) + (dn < 0 ? -dn * 0.22 : 0);
      } else {
        // Суша плавно уходит под воду: берег проходит там, где рельеф пересекает уровень моря, —
        // низины становятся заливами, холмы — мысами.
        if (dn < s.seaBand) {
          // Квадратичный спуск без излома: берег проходит дальше от края там, где суша ниже.
          const k = s.seaBand - dn;
          h -= (0.13 * k * k) / s.seaBand;
        }
        const floor = -22 - (dn < 0 ? -dn * 0.03 : 0);
        if (h < floor) h = floor + (h - floor) * 0.15;
      }
    }
  }
  return h;
}

/** Хамферное преобразование расстояния (м) от ячеек с mask = 1. */
function distanceField(n: number, mask: Uint8Array, cell: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) d[i] = mask[i] === 1 ? 0 : INF;
  const a = cell;
  const b = cell * DIAG;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + a);
      if (z > 0) {
        v = Math.min(v, d[i - n]! + a);
        if (x > 0) v = Math.min(v, d[i - n - 1]! + b);
        if (x < n - 1) v = Math.min(v, d[i - n + 1]! + b);
      }
      d[i] = v;
    }
  }
  for (let z = n - 1; z >= 0; z--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = z * n + x;
      let v = d[i]!;
      if (x < n - 1) v = Math.min(v, d[i + 1]! + a);
      if (z < n - 1) {
        v = Math.min(v, d[i + n]! + a);
        if (x < n - 1) v = Math.min(v, d[i + n + 1]! + b);
        if (x > 0) v = Math.min(v, d[i + n - 1]! + b);
      }
      d[i] = v;
    }
  }
  return d;
}

function oceanMask(n: number, h: Float64Array, edges: Edges): Uint8Array {
  const ocean = new Uint8Array(n * n);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  const seedCell = (i: number) => {
    if (ocean[i] === 0 && h[i]! < 0) {
      ocean[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let k = 0; k < n; k++) {
    if (edges[0] === EdgeKind.Sea) seedCell(k);
    if (edges[1] === EdgeKind.Sea) seedCell(k * n + n - 1);
    if (edges[2] === EdgeKind.Sea) seedCell((n - 1) * n + k);
    if (edges[3] === EdgeKind.Sea) seedCell(k * n);
  }
  while (head < tail) {
    const c = queue[head++]!;
    const cx = c % n;
    const cz = (c - cx) / n;
    if (cx > 0) seedCell(c - 1);
    if (cx < n - 1) seedCell(c + 1);
    if (cz > 0) seedCell(c - n);
    if (cz < n - 1) seedCell(c + n);
  }
  return ocean;
}

function accumulate(n: number, receiver: Int32Array, order: Int32Array, local: Float64Array): Float64Array {
  const acc = Float64Array.from(local);
  for (let k = n * n - 1; k >= 0; k--) {
    const c = order[k]!;
    const r = receiver[c]!;
    if (r >= 0) acc[r]! += acc[c]!;
  }
  return acc;
}

/** Потоковая эрозия (неявная схема Braun–Willett, m = 0.5, n = 1) и сглаживание склонов. */
function erode(n: number, h: Float64Array, ocean: Uint8Array, iterations: number, progress: (f: number) => void): void {
  const cellArea = CELL_SIZE * CELL_SIZE;
  const kdt = 0.0042;
  const local = new Float64Array(n * n).fill(cellArea);
  const tmp = new Float64Array(n * n);
  for (let it = 0; it < iterations; it++) {
    const { receiver, order } = priorityFlood(n, h, ocean, 0.01);
    const area = accumulate(n, receiver, order, local);
    for (let k = 0; k < n * n; k++) {
      const c = order[k]!;
      if (ocean[c] === 1) continue;
      const r = receiver[c]!;
      if (r < 0) continue;
      const hr = h[r]!;
      const hc = h[c]!;
      if (hc <= hr) continue;
      const diagonal = c % n !== r % n && (c - (c % n)) / n !== (r - (r % n)) / n;
      const f = (kdt * Math.sqrt(area[c]!)) / (diagonal ? CELL_SIZE * DIAG : CELL_SIZE);
      h[c] = (hc + f * hr) / (1 + f);
    }
    if (it % 2 === 1) {
      for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) {
          const i = z * n + x;
          if (ocean[i] === 1 || x === 0 || z === 0 || x === n - 1 || z === n - 1) {
            tmp[i] = h[i]!;
            continue;
          }
          const avg = (h[i - 1]! + h[i + 1]! + h[i - n]! + h[i + n]!) * 0.25;
          tmp[i] = h[i]! + 0.18 * (avg - h[i]!);
        }
      }
      h.set(tmp);
    }
    progress((it + 1) / iterations);
  }
}

/** Ледниковые котловины: несколько чаш на водотоках равнин — в них сами собой образуются озёра. */
function digLakeBasins(n: number, size: number, h: Float64Array, ocean: Uint8Array, seed: number, rng: Rng): void {
  const { receiver, order } = priorityFlood(n, h, ocean, 0.01);
  const area = accumulate(n, receiver, order, new Float64Array(n * n).fill(CELL_SIZE * CELL_SIZE));
  const wanted = size >= WORLD_SIZES.M ? 2 + rng.int(2) : 1 + rng.int(2);
  const placed: { x: number; z: number }[] = [];
  const margin = Math.floor(n * 0.18);
  for (let attempt = 0; attempt < 4000 && placed.length < wanted; attempt++) {
    const cx = margin + rng.int(n - 2 * margin);
    const cz = margin + rng.int(n - 2 * margin);
    const i = cz * n + cx;
    const hc = h[i]!;
    if (ocean[i] === 1 || hc < 4 || hc > 150) continue;
    // Чаша ставится на водоток: тогда в озеро впадает и из него вытекает река.
    if (area[i]! < 0.15e6) continue;
    const x = (cx + 0.5) * CELL_SIZE;
    const z = (cz + 0.5) * CELL_SIZE;
    if (placed.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 700 * 700)) continue;
    placed.push({ x, z });
    const radius = 100 + rng.next() * 130;
    const depth = 6 + rng.next() * 7;
    const reach = Math.ceil((radius * 1.5) / CELL_SIZE);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue;
        const px = (gx + 0.5) * CELL_SIZE;
        const pz = (gz + 0.5) * CELL_SIZE;
        const wobble = 0.75 + 0.5 * (hashNoise(seed, 90 + placed.length, px / 160, pz / 160) + 0.7) / 1.4;
        const r = radius * wobble;
        const dd = ((px - x) * (px - x) + (pz - z) * (pz - z)) / (r * r);
        if (dd >= 1) continue;
        const t = 1 - dd;
        h[gz * n + gx]! -= depth * t * t;
      }
    }
  }
}

interface Climate {
  tMean: Float32Array;
  tAmp: Float32Array;
  precip: Float32Array;
  windX: number;
  windZ: number;
}

function computeClimate(n: number, size: number, h: Float64Array, seaDist: Float32Array, edges: Edges, climate: ClimateName, seed: number, rng: Rng): Climate {
  const preset = CLIMATE[climate];
  // Ветер дует с моря: выбираем морской край, поперечная составляющая — небольшой наклон.
  const seaEdges = [0, 1, 2, 3].filter((e) => edges[e] === EdgeKind.Sea);
  const from = seaEdges[rng.int(seaEdges.length)]!;
  const tilt = (rng.next() - 0.5) * 0.7;
  let wx = from === 1 ? -1 : from === 3 ? 1 : tilt;
  let wz = from === 0 ? 1 : from === 2 ? -1 : tilt;
  const wl = Math.sqrt(wx * wx + wz * wz);
  wx /= wl;
  wz /= wl;

  // Осадки: проход воздушной массы по грубой сетке вдоль ветра. Над морем влага восполняется,
  // над сушей тратится; подъём рельефа выжимает влагу (наветренные склоны), за хребтом — дождевая тень.
  const f = 4;
  const m = n / f;
  const coarse = new Float64Array(m * m);
  const seaFrac = new Float64Array(m * m);
  for (let cz = 0; cz < m; cz++) {
    for (let cx = 0; cx < m; cx++) {
      let sum = 0;
      let sea = 0;
      for (let dz = 0; dz < f; dz++) {
        for (let dx = 0; dx < f; dx++) {
          const v = h[(cz * f + dz) * n + cx * f + dx]!;
          sum += v > 0 ? v : 0;
          if (v < 0) sea++;
        }
      }
      coarse[cz * m + cx] = sum / (f * f);
      seaFrac[cz * m + cx] = sea / (f * f);
    }
  }
  const rain = new Float64Array(m * m);
  const step = CELL_SIZE * f;
  const alongX = from === 1 || from === 3;
  for (let line = 0; line < m; line++) {
    let q = 1;
    let prev = -1;
    for (let k = 0; k < m; k++) {
      const s = from === 0 || from === 3 ? k : m - 1 - k;
      const i = alongX ? line * m + s : s * m + line;
      const hc = coarse[i]!;
      if (prev < 0) prev = hc;
      const rise = hc > prev ? hc - prev : 0;
      prev = hc;
      const sea = seaFrac[i]!;
      const r = q * (0.0045 + (0.022 * rise) / step + 0.000012 * hc);
      rain[i] = r * (1 - sea * 0.5);
      q = q - r * (1 - sea) + sea * (1 - q) * 0.08;
      if (q < 0.05) q = 0.05;
    }
  }
  // Размытие (две итерации прямоугольного фильтра) — сглаживает полосы вдоль ветра.
  const blur = (src: Float64Array): Float64Array => {
    const out = new Float64Array(m * m);
    for (let z = 0; z < m; z++) {
      for (let x = 0; x < m; x++) {
        let s = 0;
        let w = 0;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            const zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= m || zz >= m) continue;
            s += src[zz * m + xx]!;
            w++;
          }
        }
        out[z * m + x] = s / w;
      }
    }
    return out;
  };
  const smooth = blur(blur(rain));
  let mean = 0;
  let land = 0;
  for (let i = 0; i < m * m; i++) {
    if (seaFrac[i]! < 0.5) {
      mean += smooth[i]!;
      land++;
    }
  }
  mean = land > 0 ? mean / land : 1;

  const tMean = new Float32Array(n * n);
  const tAmp = new Float32Array(n * n);
  const precip = new Float32Array(n * n);
  const latSpan = size >= WORLD_SIZES.M ? 3.2 : 2;
  const wobbleNoise = new Noise2(seed, 70);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const hc = h[i]! > 0 ? h[i]! : 0;
      // Билинейная выборка грубой сетки.
      const fx = clamp((x + 0.5) / f - 0.5, 0, m - 1.0001);
      const fz = clamp((z + 0.5) / f - 0.5, 0, m - 1.0001);
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const tx = fx - ix;
      const tz = fz - iz;
      const r0 = smooth[iz * m + ix]! * (1 - tx) + smooth[iz * m + ix + 1]! * tx;
      const r1 = smooth[(iz + 1) * m + ix]! * (1 - tx) + smooth[(iz + 1) * m + ix + 1]! * tx;
      const r = (r0 * (1 - tz) + r1 * tz) / mean;
      const wobble = 1 + 0.08 * wobbleNoise.at(x / 40, z / 40);
      precip[i] = preset.precip * clamp(0.5 + 0.55 * r, 0.35, 2.2) * wobble;
      const coastal = 1 / (1 + seaDist[i]! / 500);
      tMean[i] = preset.t0 - latSpan * ((z + 0.5) / n - 0.5) - 0.0065 * hc + 0.6 * coastal;
      tAmp[i] = preset.amp * (1 - 0.3 * coastal);
    }
  }
  return { tMean, tAmp, precip, windX: wx, windZ: wz };
}

/** Доля стока от осадков (остальное — испарение). */
function runoffFraction(precipMm: number, tMean: number): number {
  return clamp(0.22 + (precipMm - 500) / 2200 - (tMean - 8) * 0.012, 0.12, 0.65);
}

function channelDepth(q: number): number {
  return Math.min(4.5, 1.1 + 1.6 * Math.sqrt(q));
}

export interface GeneratedWorld {
  geo: Geo;
  /** Хеш всех статических данных — основа проверки «один seed → один мир». */
  hash: string;
}

export function generateWorld(config: WorldConfig, progress: ProgressFn = () => {}): GeneratedWorld {
  const size = WORLD_SIZES[config.size];
  const seed = config.seed >>> 0;
  const n = size / CELL_SIZE;
  const rng = new Rng(seed, 101);
  const edges = chooseEdges(rng);
  const shape: Shape = { seed, size, edges, seaBand: 0.17 * size + 220, mountainBand: 0.13 * size + 260, noise: shapeNoise(seed) };

  // 1. Каркас.
  progress('Рельеф', 0);
  const h = new Float64Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) h[z * n + x] = macroHeight(shape, (x + 0.5) * CELL_SIZE, (z + 0.5) * CELL_SIZE);
    if ((z & 63) === 0) progress('Рельеф', z / n);
  }
  let ocean = oceanMask(n, h, edges);

  // 2. Эрозия.
  erode(n, h, ocean, 10, (f) => progress('Эрозия', f));

  // 3. Озёрные котловины.
  progress('Озёра', 0);
  digLakeBasins(n, size, h, ocean, seed, rng);
  ocean = oceanMask(n, h, edges);

  // 4. Климат.
  progress('Климат', 0);
  const seaDist = distanceField(n, ocean, CELL_SIZE);
  const climate = computeClimate(n, size, h, seaDist, edges, config.climate, seed, rng);

  // 5. Гидрология: дерево стока, озёра, реки.
  progress('Реки и озёра', 0);
  const flood = priorityFlood(n, h, ocean, 0.002);
  const { filled, receiver, order } = flood;
  const runoff = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (ocean[i] === 1) continue;
    runoff[i] = ((climate.precip[i]! * runoffFraction(climate.precip[i]!, climate.tMean[i]!)) / 1000) * CELL_SIZE * CELL_SIZE;
  }
  const volume = accumulate(n, receiver, order, runoff);
  const meanDischarge = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) meanDischarge[i] = volume[i]! / (REF_HOURS_PER_YEAR * 3600);

  const waterKind = new Uint8Array(n * n);
  const waterLevel = new Float32Array(n * n);
  const lakeId = new Int16Array(n * n).fill(-1);
  const lakes: Lake[] = [];
  // Озёра: впадины глубже 0.4 м и не меньше 6 ячеек; мелкие лужи засыпаются.
  const candidate = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if (ocean[i] === 0 && filled[i]! - h[i]! > 0.4) candidate[i] = 1;
  const popIndex = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) popIndex[order[k]!] = k;
  const component = new Int32Array(n * n).fill(-1);
  const stack: number[] = [];
  for (let start = 0; start < n * n; start++) {
    if (candidate[start] === 0 || component[start]! >= 0) continue;
    const cells: number[] = [];
    stack.push(start);
    component[start] = start;
    while (stack.length > 0) {
      const c = stack.pop()!;
      cells.push(c);
      const cx = c % n;
      const cz = (c - cx) / n;
      for (let d = 0; d < 8; d++) {
        const x = cx + DX8[d]!;
        const z = cz + DZ8[d]!;
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const i = z * n + x;
        if (candidate[i] === 1 && component[i]! < 0) {
          component[i] = start;
          stack.push(i);
        }
      }
    }
    if (cells.length < 6 || lakes.length >= 32000) {
      for (const c of cells) h[c] = filled[c]!;
      continue;
    }
    let level = -Infinity;
    let outlet = -1;
    let outletPop = Infinity;
    for (const c of cells) {
      if (filled[c]! > level) level = filled[c]!;
      const r = receiver[c]!;
      if ((r < 0 || component[r] !== start) && popIndex[c]! < outletPop) {
        outletPop = popIndex[c]!;
        outlet = r;
      }
    }
    const id = lakes.length;
    lakes.push({ id, level, cells: cells.length, outlet });
    for (const c of cells) {
      waterKind[c] = WaterKind.Lake;
      waterLevel[c] = level;
      lakeId[c] = id;
    }
  }
  // Реки: порог расхода зависит от размера мира, чтобы и в малом мире были реки.
  const riverQ = size >= WORLD_SIZES.M ? 0.09 : 0.06;
  const wideQ = 0.7;
  for (let k = n * n - 1; k >= 0; k--) {
    const c = order[k]!;
    if (ocean[c] === 1) {
      waterKind[c] = WaterKind.Sea;
      waterLevel[c] = 0;
      continue;
    }
    if (waterKind[c] === WaterKind.Lake) continue;
    const q = meanDischarge[c]!;
    if (q < riverQ) {
      if (waterKind[c] === WaterKind.None) waterLevel[c] = h[c]!;
      continue;
    }
    const depth = channelDepth(q);
    const bed = filled[c]! - depth;
    const level = bed + depth * 0.55;
    waterKind[c] = WaterKind.River;
    waterLevel[c] = level;
    if (h[c]! > bed) h[c] = bed;
    // Крупные реки шире одной ячейки: боковые соседи поперёк течения тоже становятся руслом.
    if (q >= wideQ) {
      const r = receiver[c]!;
      if (r < 0) continue;
      const cx = c % n;
      const cz = (c - cx) / n;
      const fx = (r % n) - cx;
      const fz = (r - (r % n)) / n - cz;
      for (const side of [-1, 1]) {
        const x = cx - fz * side;
        const z = cz + fx * side;
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const i = z * n + x;
        if (ocean[i] === 1 || waterKind[i] !== WaterKind.None) continue;
        if (filled[i]! > level + 3) continue;
        // Расширяется только та ячейка, что сама стекает в это же русло, — иначе уровень воды
        // по течению перестал бы убывать.
        if (receiver[i] !== c && receiver[i] !== r) continue;
        waterKind[i] = WaterKind.River;
        waterLevel[i] = level;
        const sideBed = level - depth * 0.35;
        if (h[i]! > sideBed) h[i] = sideBed;
        if (meanDischarge[i]! < q * 0.5) meanDischarge[i] = q * 0.5;
      }
    }
  }
  for (let i = 0; i < n * n; i++) if (waterKind[i] === WaterKind.None) waterLevel[i] = h[i]!;

  const waterMask = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) waterMask[i] = waterKind[i] !== WaterKind.None ? 1 : 0;
  const waterDist = distanceField(n, waterMask, CELL_SIZE);
  const finalSeaDist = distanceField(n, ocean, CELL_SIZE);

  // Уклон.
  const slope = new Float32Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const hx = (h[z * n + Math.min(n - 1, x + 1)]! - h[z * n + Math.max(0, x - 1)]!) / (2 * CELL_SIZE);
      const hz = (h[Math.min(n - 1, z + 1) * n + x]! - h[Math.max(0, z - 1) * n + x]!) / (2 * CELL_SIZE);
      slope[i] = Math.sqrt(hx * hx + hz * hz);
    }
  }

  // 6. Почвы и залежи.
  progress('Почвы', 0);
  const soil = new Uint8Array(n * n);
  const fertility = new Float32Array(n * n);
  const deposit = new Uint8Array(n * n);
  const depositRichness = new Uint8Array(n * n);
  const patchNoise = new Noise2(seed, 60);
  const patch2Noise = new Noise2(seed, 61);
  const veinNoise = new Noise2(seed, 62);
  const oreRidges = new Ridged(seed, 63, 2);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const px = (x + 0.5) * CELL_SIZE;
      const pz = (z + 0.5) * CELL_SIZE;
      const hc = h[i]!;
      const s = slope[i]!;
      const wd = waterDist[i]!;
      const sd = finalSeaDist[i]!;
      const patch = patchNoise.at(px / 260, pz / 260);
      const patch2 = patch2Noise.at(px / 140, pz / 140);
      const kind = waterKind[i]!;
      let t: number;
      if (kind === WaterKind.Sea) t = SOIL.sand;
      else if (kind === WaterKind.River) t = SOIL.alluvial;
      else if (kind === WaterKind.Lake) t = SOIL.clay;
      else if (s > 0.55 || hc > 430) t = SOIL.rock;
      else if (sd < 48 && hc < 5) t = SOIL.sand;
      else if (wd < 28 + 4 * Math.sqrt(meanDischarge[i]!) && s < 0.12) t = SOIL.alluvial;
      else if (s < 0.035 && (climate.precip[i]! > 820 || wd < 90) && patch > 0.15) t = SOIL.peat;
      else if (s < 0.07 && hc < 70 && patch2 > 0.12) t = SOIL.clay;
      else if (s > 0.32 && patch2 < -0.25) t = SOIL.rock;
      else if (sd < 160 && patch < -0.3) t = SOIL.sand;
      else t = SOIL.loam;
      soil[i] = t;
      fertility[i] = clamp01(SOILS[t]!.fertility * (1 - 0.5 * smoothstep(0.2, 0.6, s)) * (0.88 + 0.24 * (patch2 + 0.7) / 1.4));

      if (kind !== WaterKind.None) continue;
      const vein = veinNoise.at(px / 90, pz / 90);
      if (hc > 220 && vein > 0.42 && oreRidges.at(px / 300, pz / 300) > 0.55) {
        deposit[i] = DepositKind.Ore;
        depositRichness[i] = Math.round(clamp01((vein - 0.42) * 3) * 255);
      } else if (t === SOIL.rock && s > 0.4 && vein > 0) {
        deposit[i] = DepositKind.Stone;
        depositRichness[i] = Math.round(clamp01(s) * 255);
      } else if (t === SOIL.clay && vein > 0.25) {
        deposit[i] = DepositKind.Clay;
        depositRichness[i] = Math.round(clamp01((vein - 0.25) * 2.5) * 255);
      } else if ((t === SOIL.sand || (t === SOIL.alluvial && wd <= CELL_SIZE)) && vein > 0.3) {
        deposit[i] = DepositKind.Sand;
        depositRichness[i] = Math.round(clamp01((vein - 0.3) * 2.5) * 255);
      }
    }
  }

  // 7. Провинции.
  progress('Провинции', 0);
  const { province, provinces } = buildProvinces(n, size, h, ocean, waterKind, slope, meanDischarge, finalSeaDist, lakeId, climate, rng);

  // 8. Рельеф 2 м.
  progress('Детализация рельефа', 0);
  const terrain = buildFineTerrain(n, size, h, slope, waterDist, waterKind, seed, (f) => progress('Детализация рельефа', f));
  carveChannels(terrain, n, h, waterKind, waterLevel, receiver, meanDischarge);

  // 9. Горизонт за границей мира.
  progress('Горизонт', 0);
  const horizon = buildHorizon(shape, terrain);

  const upstreamOrder = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) upstreamOrder[k] = order[n * n - 1 - k]!;

  const height32 = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) height32[i] = h[i]!;

  const geo: Geo = {
    n,
    cellSize: CELL_SIZE,
    edges,
    height: height32,
    slope,
    waterKind,
    waterLevel,
    waterDist,
    seaDist: finalSeaDist,
    receiver,
    upstreamOrder,
    meanDischarge,
    lakeId,
    lakes,
    tMean: climate.tMean,
    tAmp: climate.tAmp,
    precip: climate.precip,
    soil,
    fertility,
    deposit,
    depositRichness,
    province,
    provinces,
    windX: climate.windX,
    windZ: climate.windZ,
    terrain,
    horizon,
  };
  progress('Готово', 1);
  return { geo, hash: hashGeo(geo) };
}

export function hashGeo(geo: Geo): string {
  const hasher = new StateHasher()
    .addInt(WORLDGEN_VERSION)
    .addInt(geo.n)
    .addInt(geo.edges[0] | (geo.edges[1] << 2) | (geo.edges[2] << 4) | (geo.edges[3] << 6))
    .addArray(geo.height)
    .addArray(geo.waterKind)
    .addArray(geo.waterLevel)
    .addArray(geo.receiver)
    .addArray(geo.meanDischarge)
    .addArray(geo.tMean)
    .addArray(geo.tAmp)
    .addArray(geo.precip)
    .addArray(geo.soil)
    .addArray(geo.fertility)
    .addArray(geo.deposit)
    .addArray(geo.province)
    .addArray(geo.terrain.heights)
    .addArray(geo.horizon.heights);
  for (const p of geo.provinces) {
    hasher.addInt(p.cells);
    for (let i = 0; i < p.name.length; i++) hasher.addInt(p.name.charCodeAt(i));
  }
  return hasher.digest();
}

function buildProvinces(
  n: number,
  size: number,
  h: Float64Array,
  ocean: Uint8Array,
  waterKind: Uint8Array,
  slope: Float32Array,
  discharge: Float32Array,
  seaDist: Float32Array,
  lakeId: Int16Array,
  climate: Climate,
  rng: Rng,
): { province: Uint16Array; provinces: Province[] } {
  const land: number[] = [];
  for (let i = 0; i < n * n; i++) if (ocean[i] === 0) land.push(i);
  const cellArea = CELL_SIZE * CELL_SIZE;
  const count = clamp(Math.round((land.length * cellArea) / 0.45e6), 3, 48);
  // Лучший кандидат Митчелла: равномерно разнесённые центры.
  const seeds: number[] = [];
  for (let k = 0; k < count && land.length > 0; k++) {
    let best = -1;
    let bestD = -1;
    for (let t = 0; t < 16; t++) {
      const c = land[rng.int(land.length)]!;
      const cx = c % n;
      const cz = (c - cx) / n;
      let d = Infinity;
      for (const s of seeds) {
        const sx = s % n;
        const sz = (s - sx) / n;
        const dd = (sx - cx) * (sx - cx) + (sz - cz) * (sz - cz);
        if (dd < d) d = dd;
      }
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best >= 0 && !seeds.includes(best)) seeds.push(best);
  }
  // Рост областей по стоимости: подъёмы (водоразделы) и крупные реки — естественные границы.
  const cost = new Float64Array(n * n).fill(Infinity);
  const province = new Uint16Array(n * n);
  const heapKey = cost;
  const heap: number[] = [];
  const less = (a: number, b: number) => heapKey[a]! < heapKey[b]! || (heapKey[a] === heapKey[b] && a < b);
  const push = (i: number) => {
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!less(heap[k]!, heap[p]!)) break;
      [heap[k], heap[p]] = [heap[p]!, heap[k]!];
      k = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === k) break;
        [heap[k], heap[m]] = [heap[m]!, heap[k]!];
        k = m;
      }
    }
    return top;
  };
  seeds.forEach((s, k) => {
    cost[s] = 0;
    province[s] = k + 1;
    push(s);
  });
  const done = new Uint8Array(n * n);
  while (heap.length > 0) {
    const c = pop();
    if (done[c] === 1) continue;
    done[c] = 1;
    const cx = c % n;
    const cz = (c - cx) / n;
    for (let d = 0; d < 8; d++) {
      const x = cx + DX8[d]!;
      const z = cz + DZ8[d]!;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const i = z * n + x;
      if (ocean[i] === 1 || done[i] === 1) continue;
      const dist = d % 2 === 1 ? DIAG : 1;
      const climb = Math.abs(h[i]! - h[c]!);
      const river = waterKind[i] === WaterKind.River && discharge[i]! > 0.5 ? 25 : 0;
      const nc = cost[c]! + dist * (1 + climb * 0.35) + river;
      if (nc < cost[i]!) {
        cost[i] = nc;
        province[i] = province[c]!;
        push(i);
      }
    }
  }
  const used = new Set<string>();
  const provinces: Province[] = [];
  const stats = seeds.map(() => ({ cells: 0, x: 0, z: 0, h: 0, t: 0, p: 0, slope: 0, coast: 0, lake: 0, river: 0, high: 0 }));
  for (const i of land) {
    const id = province[i]!;
    if (id === 0) continue;
    const st = stats[id - 1]!;
    const x = i % n;
    st.cells++;
    st.x += (x + 0.5) * CELL_SIZE;
    st.z += ((i - x) / n + 0.5) * CELL_SIZE;
    st.h += h[i]! > 0 ? h[i]! : 0;
    st.t += climate.tMean[i]!;
    st.p += climate.precip[i]!;
    st.slope += slope[i]!;
    if (seaDist[i]! < 200) st.coast++;
    if (lakeId[i]! >= 0) st.lake++;
    if (waterKind[i] === WaterKind.River) st.river++;
    if (h[i]! > 260) st.high++;
  }
  stats.forEach((st, k) => {
    const c = Math.max(1, st.cells);
    const meanH = st.h / c;
    let kind: ProvinceKind;
    if (st.high / c > 0.45 || meanH > 300) kind = 'mountains';
    else if (meanH > 160) kind = 'highland';
    else if (st.lake / c > 0.06) kind = 'lakeland';
    else if (st.coast / c > 0.28) kind = 'coast';
    else if (st.river / c > 0.03) kind = 'valley';
    else if (st.slope / c > 0.11) kind = 'hills';
    else kind = 'plain';
    provinces.push({
      id: k + 1,
      name: provinceName(kind, rng, used),
      kind,
      x: st.x / c,
      z: st.z / c,
      cells: st.cells,
      meanHeight: meanH,
      meanTemp: st.t / c,
      meanPrecip: st.p / c,
    });
  });
  void size;
  return { province, provinces };
}

/** Кубическая интерполяция Катмулла — Рома: гладкий рельеф между центрами ячеек. */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t2 * t);
}

function buildFineTerrain(
  n: number,
  size: number,
  h: Float64Array,
  slope: Float32Array,
  waterDist: Float32Array,
  waterKind: Uint8Array,
  seed: number,
  progress: (f: number) => void,
): Geo['terrain'] {
  const spacing = HEIGHT_SPACING;
  const samples = size / spacing + 1;
  const heights = new Float32Array(samples * samples);
  // Шероховатость по ячейкам: сильнее на крутых склонах, слабее у воды (русла остаются ровными).
  const rough = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const nearWater = smoothstep(6, 26, waterDist[i]!);
    rough[i] = waterKind[i] !== WaterKind.None ? 0.05 : (0.3 + 2.6 * smoothstep(0.06, 0.7, slope[i]!)) * nearWater;
  }
  // Раздельная интерполяция Катмулла — Рома: сначала вдоль x для каждой строки ячеек,
  // затем вдоль z для каждой точки. Строк ячеек в 4 раза меньше, чем строк отсчётов.
  const rowX = new Float64Array(n * samples);
  const colIndex = new Int32Array(samples);
  const colT = new Float64Array(samples);
  for (let ix = 0; ix < samples; ix++) {
    const fx = (ix * spacing) / CELL_SIZE - 0.5;
    colIndex[ix] = Math.floor(fx);
    colT[ix] = fx - Math.floor(fx);
  }
  const at = (x: number, row: number) => h[row + (x < 0 ? 0 : x >= n ? n - 1 : x)]!;
  for (let cz = 0; cz < n; cz++) {
    const row = cz * n;
    for (let ix = 0; ix < samples; ix++) {
      const cx = colIndex[ix]!;
      rowX[cz * samples + ix] = catmull(at(cx - 1, row), at(cx, row), at(cx + 1, row), at(cx + 2, row), colT[ix]!);
    }
  }
  const coarse = new Noise2(seed, 80);
  const fine = new Noise2(seed, 81);
  const clampRow = (z: number) => (z < 0 ? 0 : z >= n ? n - 1 : z) * samples;
  for (let iz = 0; iz < samples; iz++) {
    const pz = iz * spacing;
    const fz = pz / CELL_SIZE - 0.5;
    const cz = Math.floor(fz);
    const tz = fz - cz;
    const r0 = clampRow(cz - 1);
    const r1 = clampRow(cz);
    const r2 = clampRow(cz + 1);
    const r3 = clampRow(cz + 2);
    const rz = clamp(cz, 0, n - 2);
    const ttz = clamp01(fz - rz);
    for (let ix = 0; ix < samples; ix++) {
      let base = catmull(rowX[r0 + ix]!, rowX[r1 + ix]!, rowX[r2 + ix]!, rowX[r3 + ix]!, tz);
      const px = ix * spacing;
      const cx = colIndex[ix]!;
      const rx = clamp(cx, 0, n - 2);
      const ttx = clamp01(colT[ix]! + cx - rx);
      const a = rough[rz * n + rx]! * (1 - ttx) + rough[rz * n + rx + 1]! * ttx;
      const b = rough[(rz + 1) * n + rx]! * (1 - ttx) + rough[(rz + 1) * n + rx + 1]! * ttx;
      const r = a * (1 - ttz) + b * ttz;
      if (r > 0.01) base += r * (coarse.at(px / 46, pz / 46) * 1.7 + fine.at(px / 13, pz / 13) * 0.55);
      heights[iz * samples + ix] = base;
    }
    if ((iz & 127) === 0) progress(iz / samples);
  }
  return { samples, spacing, heights };
}

/**
 * Русла в рельефе 2 м: вдоль отрезка от центра речной ячейки к центру её приёмника рельеф опускается
 * ниже уровня воды с профилем корыта; берега поднимаются полого. Без этого узкая река шириной в одну
 * ячейку 8 м после сглаживания превращается в цепочку луж.
 */
function carveChannels(terrain: Geo['terrain'], n: number, h: Float64Array, waterKind: Uint8Array, waterLevel: Float32Array, receiver: Int32Array, discharge: Float32Array): void {
  const sp = terrain.spacing;
  const samples = terrain.samples;
  const heights = terrain.heights;
  for (let c = 0; c < n * n; c++) {
    if (waterKind[c] !== WaterKind.River) continue;
    const r = receiver[c]!;
    const ax = ((c % n) + 0.5) * CELL_SIZE;
    const az = (Math.floor(c / n) + 0.5) * CELL_SIZE;
    const bx = r >= 0 ? ((r % n) + 0.5) * CELL_SIZE : ax;
    const bz = r >= 0 ? (Math.floor(r / n) + 0.5) * CELL_SIZE : az;
    const la = waterLevel[c]!;
    const lb = r >= 0 ? Math.min(la, waterKind[r] === WaterKind.None ? la : waterLevel[r]!) : la;
    const depth = Math.max(0.6, la - h[c]!);
    const half = Math.min(9, 2.6 + 2.2 * Math.sqrt(discharge[c]!));
    const bank = half + 4;
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - bank) / sp));
    const x1 = Math.min(samples - 1, Math.ceil((Math.max(ax, bx) + bank) / sp));
    const z0 = Math.max(0, Math.floor((Math.min(az, bz) - bank) / sp));
    const z1 = Math.min(samples - 1, Math.ceil((Math.max(az, bz) + bank) / sp));
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const px = ix * sp;
        const pz = iz * sp;
        const t = len2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
        const qx = ax + dx * t - px;
        const qz = az + dz * t - pz;
        const dist = Math.sqrt(qx * qx + qz * qz);
        if (dist >= bank) continue;
        const level = la + (lb - la) * t;
        const k = dist / half;
        const target = dist < half ? level - 0.15 - depth * (1 - k * k) : level - 0.15 + (dist - half) * 0.45;
        const o = iz * samples + ix;
        if (heights[o]! > target) heights[o] = target;
      }
    }
  }
}

/** Окрестность за границей: тот же каркас без эрозии, плавно сшитый с краем мира. */
function buildHorizon(shape: Shape, terrain: Geo['terrain']): Geo['horizon'] {
  const size = shape.size;
  const extent = Math.max(3000, size * 0.9);
  const spacing = 32;
  const samples = Math.round((size + 2 * extent) / spacing) + 1;
  const originX = -extent;
  const originZ = -extent;
  const heights = new Float32Array(samples * samples);
  const ts = terrain.samples;
  const edgeHeight = (x: number, z: number) => {
    const ix = Math.round(clamp(x, 0, size) / terrain.spacing);
    const iz = Math.round(clamp(z, 0, size) / terrain.spacing);
    return terrain.heights[clamp(iz, 0, ts - 1) * ts + clamp(ix, 0, ts - 1)]!;
  };
  for (let iz = 0; iz < samples; iz++) {
    for (let ix = 0; ix < samples; ix++) {
      const x = originX + ix * spacing;
      const z = originZ + iz * spacing;
      const outside = Math.max(-x, x - size, -z, z - size, 0);
      let v: number;
      if (outside <= 0) v = edgeHeight(x, z);
      else {
        const t = smoothstep(0, 420, outside);
        v = edgeHeight(x, z) * (1 - t) + macroHeight(shape, x, z) * t;
      }
      heights[iz * samples + ix] = v;
    }
  }
  return { samples, spacing, heights, originX, originZ };
}

