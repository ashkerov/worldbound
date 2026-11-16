// Предпросмотр генератора мира в Node: время этапов, сводка и PNG-карты (рельеф, осадки, почвы, провинции).
// Использование: npm run worldgen -- [--seed 42] [--size M|S] [--climate temperate] [--out dir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { generateWorld } from '../src/sim/worldgen/generate';
import { WaterKind } from '../src/sim/worldgen/geo';
import { normalizeConfig, type ClimateName, type WorldSizeName } from '../src/shared/worldConfig';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const config = normalizeConfig({
  seed: Number(arg('seed', '42')),
  size: arg('size', 'M') as WorldSizeName,
  climate: arg('climate', 'temperate') as ClimateName,
});
const out = arg('out', 'tmp-worldgen');
mkdirSync(out, { recursive: true });

const stages: Record<string, number> = {};
let last = performance.now();
let stage = '';
const start = last;
const { geo, hash } = generateWorld(config, (name) => {
  const now = performance.now();
  if (name !== stage) {
    if (stage) stages[stage] = +((stages[stage] ?? 0) + now - last).toFixed(0);
    stage = name;
    last = now;
  }
});
const total = performance.now() - start;

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(path: string, w: number, h: number, rgb: Uint8Array): void {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  writeFileSync(path, Buffer.concat(parts));
}

const n = geo.n;
const map = new Uint8Array(n * n * 3);
const precip = new Uint8Array(n * n * 3);
const soils = new Uint8Array(n * n * 3);
const prov = new Uint8Array(n * n * 3);
const SOIL_RGB = [
  [140, 134, 124],
  [214, 196, 140],
  [128, 98, 62],
  [150, 98, 70],
  [92, 72, 48],
  [60, 48, 36],
];
for (let i = 0; i < n * n; i++) {
  const x = i % n;
  const z = (i - x) / n;
  const hx = geo.height[z * n + Math.min(n - 1, x + 1)]! - geo.height[z * n + Math.max(0, x - 1)]!;
  const hz = geo.height[Math.min(n - 1, z + 1) * n + x]! - geo.height[Math.max(0, z - 1) * n + x]!;
  const shade = Math.max(0.35, Math.min(1.3, 1 - (hx - hz) * 0.06));
  const hgt = geo.height[i]!;
  let r: number;
  let g: number;
  let b: number;
  const kind = geo.waterKind[i]!;
  if (kind === WaterKind.Sea) [r, g, b] = [40, 80, 130];
  else if (kind === WaterKind.Lake) [r, g, b] = [50, 110, 160];
  else if (kind === WaterKind.River) [r, g, b] = [60, 130, 190];
  else if (hgt > 300) [r, g, b] = [150, 140, 125];
  else if (hgt > 120) [r, g, b] = [120, 135, 80];
  else [r, g, b] = [95, 140, 70];
  const s = kind === WaterKind.None ? shade : 1;
  map.set([Math.min(255, r * s), Math.min(255, g * s), Math.min(255, b * s)], i * 3);
  const p = Math.min(1, (geo.precip[i]! - 300) / 1200);
  precip.set(kind === WaterKind.Sea ? [30, 30, 40] : [255 * (1 - p), 200 * (1 - p) + 55, 120 + 135 * p], i * 3);
  const sc = SOIL_RGB[geo.soil[i]!]!;
  soils.set(kind === WaterKind.None ? sc : [40, 80, 130], i * 3);
  const id = geo.province[i]!;
  const border = x > 0 && geo.province[i - 1] !== id;
  const hue = (id * 2654435761) >>> 0;
  prov.set(id === 0 ? [30, 50, 80] : border ? [0, 0, 0] : [hue & 255, (hue >>> 8) & 255, (hue >>> 16) & 255], i * 3);
}
const name = `${out}/world-${config.seed}-${config.size}`;
png(`${name}-map.png`, n, n, map);
png(`${name}-precip.png`, n, n, precip);
png(`${name}-soils.png`, n, n, soils);
png(`${name}-provinces.png`, n, n, prov);

const count = (k: number) => geo.waterKind.reduce((a, v) => a + (v === k ? 1 : 0), 0);
let maxQ = 0;
for (const q of geo.meanDischarge) if (q > maxQ) maxQ = q;
let minH = Infinity;
let maxH = -Infinity;
for (const v of geo.height) {
  minH = Math.min(minH, v);
  maxH = Math.max(maxH, v);
}
console.log(
  JSON.stringify(
    {
      config,
      hash,
      totalMs: +total.toFixed(0),
      stagesMs: stages,
      edges: geo.edges,
      wind: [+geo.windX.toFixed(2), +geo.windZ.toFixed(2)],
      height: [+minH.toFixed(1), +maxH.toFixed(1)],
      cells: { sea: count(WaterKind.Sea), lake: count(WaterKind.Lake), river: count(WaterKind.River) },
      lakes: geo.lakes.map((l) => ({ cells: l.cells, level: +l.level.toFixed(1) })),
      maxDischarge: +maxQ.toFixed(2),
      provinces: geo.provinces.map((p) => `${p.name} (${p.kind}, ${p.cells}, ${p.meanTemp.toFixed(1)}°C, ${p.meanPrecip.toFixed(0)} мм)`),
    },
    null,
    2,
  ),
);
