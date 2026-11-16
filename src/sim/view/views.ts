// Представления состояния для рендера и интерфейса: строятся из авторитетных данных только для чтения.
// Ничего из этого не меняет мир — запросы карточек и слоёв не влияют на ход симуляции (это проверяется тестом).

import { clamp01, smoothstep } from '../../shared/dmath';
import type { CellInfo, LayerId, LegendEntry, WorldStaticMessage } from '../../shared/protocol';
import { CHUNK_SIZE } from '../../shared/worldConfig';
import { cellAt, type World } from '../core/world';
import { cellLight, cellTemperature, chunkSample, timeContext, type TimeContext } from '../env/climate';
import { SOILS } from '../env/soils';
import { SNOW_THRESHOLD } from '../env/water';
import { windAt } from '../env/weather';
import { DEPOSIT_NAMES, WaterKind } from '../worldgen/geo';

const ctx: TimeContext = { seasonal: 0, diurnal: 0, anomaly: 0, sun: { x: 0, y: 1, z: 0 } };

function nowContext(world: World): TimeContext {
  return timeContext(world.seed, world.tick, world.config.daysPerSeason, ctx);
}

/** Статика мира для рендера: копии массивов, оригиналы остаются в воркере. */
export function buildStatic(world: World, worldId: string): { message: WorldStaticMessage; transfer: ArrayBuffer[] } {
  const geo = world.geo;
  const n = geo.n;
  const flow = new Int8Array(n * n * 2);
  for (let i = 0; i < n * n; i++) {
    const r = geo.receiver[i]!;
    if (r < 0) continue;
    flow[i * 2] = (r % n) - (i % n);
    flow[i * 2 + 1] = (r - (r % n)) / n - (i - (i % n)) / n;
  }
  const copy = (a: Float32Array | Uint8Array | Int8Array) => a.slice().buffer as ArrayBuffer;
  const message: WorldStaticMessage = {
    type: 'worldStatic',
    worldId,
    config: world.config,
    worldSize: world.worldSize,
    n,
    cellSize: geo.cellSize,
    terrain: { samples: geo.terrain.samples, spacing: geo.terrain.spacing, heights: copy(geo.terrain.heights) },
    horizon: { samples: geo.horizon.samples, spacing: geo.horizon.spacing, heights: copy(geo.horizon.heights), originX: geo.horizon.originX, originZ: geo.horizon.originZ },
    cellHeight: copy(geo.height),
    waterKind: copy(geo.waterKind),
    waterLevel: copy(geo.waterLevel),
    flow: flow.buffer,
    meanDischarge: copy(geo.meanDischarge),
    soil: copy(geo.soil),
    soilIds: SOILS.map((s) => s.id),
    precipFactor: copy(world.derived.pFactor),
    provinces: geo.provinces.map((p) => ({ id: p.id, name: p.name, x: p.x, z: p.z })),
  };
  const transfer = [message.terrain.heights, message.horizon.heights, message.cellHeight, message.waterKind, message.waterLevel, message.flow, message.meanDischarge, message.soil, message.precipFactor];
  return { message, transfer };
}

/** Поверхность для материала рельефа: RGBA8 n² (снег, влага, зелень, осадки сейчас). */
export function buildSurface(world: World): Uint8Array {
  const geo = world.geo;
  const env = world.env;
  const w = env.weather;
  const count = geo.n * geo.n;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    out[o] = Math.round(clamp01(env.snow[i]! / 120) * 255);
    out[o + 1] = Math.round(clamp01(env.moisture[i]! / world.derived.capacity[i]!) * 255);
    out[o + 2] = Math.round(clamp01(env.greenness[i]!) * 255);
    out[o + 3] = Math.round(clamp01((chunkSample(w, w.chunkRate, geo, i) * world.derived.pFactor[i]!) / 4) * 255);
  }
  // У воды нет покрова; чтобы фильтрация текстуры не растягивала «голую почву» на берега,
  // водные ячейки получают зелень соседней суши (на вид воды это не влияет — её рисует вода).
  const n = geo.n;
  for (let i = 0; i < count; i++) {
    const kind = geo.waterKind[i]!;
    if (kind === WaterKind.None || kind === WaterKind.Sea) continue;
    const x = i % n;
    let best = 0;
    for (const j of [i - 1, i + 1, i - n, i + n]) {
      if (j < 0 || j >= count || (j === i - 1 && x === 0) || (j === i + 1 && x === n - 1)) continue;
      if (geo.waterKind[j] === WaterKind.None && out[j * 4 + 2]! > best) best = out[j * 4 + 2]!;
    }
    out[i * 4 + 2] = best;
    out[i * 4 + 1] = 255;
  }
  return out;
}

/** Температура в центрах чанков — для выбора «дождь или снег» в частицах осадков. */
export function chunkTemperatures(world: World): Float32Array {
  const c = world.env.weather.chunks;
  const out = new Float32Array(c * c);
  const t = nowContext(world);
  for (let cz = 0; cz < c; cz++) {
    for (let cx = 0; cx < c; cx++) {
      const cell = cellAt(world, (cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE);
      out[cz * c + cx] = cellTemperature(world.geo, cell, t, world.env.weather.chunkCloud[cz * c + cx]!);
    }
  }
  return out;
}

const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

export function cellInfo(world: World, x: number, z: number): CellInfo | null {
  if (!(x >= 0 && z >= 0 && x <= world.worldSize && z <= world.worldSize)) return null;
  const geo = world.geo;
  const env = world.env;
  const w = env.weather;
  const i = cellAt(world, x, z);
  const t = nowContext(world);
  const cloud = chunkSample(w, w.chunkCloud, geo, i);
  const temperature = cellTemperature(geo, i, t, cloud);
  const kind = geo.waterKind[i]!;
  const precipNow = chunkSample(w, w.chunkRate, geo, i) * world.derived.pFactor[i]!;
  const wind = windAt(world, world.tick);
  // Откуда дует: противоположно направлению движения воздуха. Север — −Z.
  const angle = Math.atan2(-wind.x, wind.z);
  const sector = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  const province = geo.provinces[geo.province[i]! - 1];
  const cap = world.derived.capacity[i]!;
  return {
    x,
    z,
    province: province ? province.name : kind === WaterKind.Sea ? 'Открытое море' : '—',
    height: geo.height[i]!,
    slopeDeg: (Math.atan(geo.slope[i]!) * 180) / Math.PI,
    water: ['Суша', 'Река', 'Озеро', 'Море'][kind]!,
    waterDepth: kind === WaterKind.None ? 0 : Math.max(0, geo.waterLevel[i]! - geo.height[i]!),
    dischargeNow: kind === WaterKind.Sea ? 0 : env.discharge[i]!,
    dischargeMean: kind === WaterKind.Sea ? 0 : geo.meanDischarge[i]!,
    soil: SOILS[geo.soil[i]!]!.name,
    fertility: geo.fertility[i]!,
    moistureMm: env.moisture[i]!,
    moistureRel: kind === WaterKind.None ? env.moisture[i]! / cap : 1,
    snowMm: env.snow[i]!,
    temperature,
    tMean: geo.tMean[i]!,
    tSummer: geo.tMean[i]! + geo.tAmp[i]!,
    tWinter: geo.tMean[i]! - geo.tAmp[i]!,
    precipYear: geo.precip[i]!,
    precipNow,
    precipType: precipNow < 0.05 ? 'нет' : temperature < SNOW_THRESHOLD ? 'снег' : 'дождь',
    cloud,
    light: cellLight(t, cloud),
    greenness: env.greenness[i]!,
    windSpeed: wind.speed,
    windFrom: COMPASS[sector]!,
    deposit: DEPOSIT_NAMES[geo.deposit[i]!]!,
    depositRichness: geo.depositRichness[i]! / 255,
  };
}

// ───────── Слои-карты ─────────

type Stop = [number, number, number, number];

function ramp(stops: Stop[], v: number, out: Uint8Array, o: number): void {
  let k = 0;
  while (k < stops.length - 2 && v > stops[k + 1]![0]) k++;
  const a = stops[k]!;
  const b = stops[k + 1]!;
  const t = clamp01((v - a[0]) / (b[0] - a[0]));
  out[o] = Math.round(a[1] + (b[1] - a[1]) * t);
  out[o + 1] = Math.round(a[2] + (b[2] - a[2]) * t);
  out[o + 2] = Math.round(a[3] + (b[3] - a[3]) * t);
  out[o + 3] = 255;
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
const legendOf = (stops: Stop[], format: (v: number) => string): LegendEntry[] => stops.map(([v, r, g, b]) => ({ label: format(v), color: hex(r, g, b) }));

const HEIGHT: Stop[] = [
  [-30, 28, 62, 110],
  [0, 70, 130, 170],
  [0.01, 86, 140, 76],
  [60, 150, 170, 90],
  [150, 196, 176, 104],
  [300, 150, 118, 86],
  [500, 160, 156, 150],
  [800, 245, 245, 245],
];
const MOISTURE: Stop[] = [
  [0, 150, 100, 50],
  [0.25, 214, 180, 90],
  [0.5, 120, 180, 80],
  [0.75, 50, 150, 140],
  [1, 30, 90, 180],
];
const TEMPERATURE: Stop[] = [
  [-20, 60, 60, 170],
  [-5, 120, 170, 230],
  [0, 235, 240, 245],
  [10, 240, 220, 110],
  [20, 240, 150, 60],
  [32, 190, 40, 40],
];
const PRECIP: Stop[] = [
  [300, 220, 190, 130],
  [600, 170, 200, 120],
  [900, 80, 170, 160],
  [1300, 50, 100, 190],
  [1800, 90, 50, 160],
];
const SNOW: Stop[] = [
  [0, 120, 120, 110],
  [5, 170, 190, 210],
  [40, 220, 230, 245],
  [150, 255, 255, 255],
];
const SOIL_COLORS: [number, number, number][] = [
  [140, 134, 124],
  [214, 196, 140],
  [128, 98, 62],
  [166, 104, 72],
  [92, 72, 48],
  [58, 46, 36],
];
const WATER_RGB: [number, number, number] = [40, 90, 150];

export function layerImage(world: World, layer: LayerId): { image: Uint8Array; legend: LegendEntry[] } {
  const geo = world.geo;
  const env = world.env;
  const n = geo.n;
  const count = n * n;
  const out = new Uint8Array(count * 4);
  const water = (i: number) => {
    out.set(WATER_RGB, i * 4);
    out[i * 4 + 3] = 255;
  };
  switch (layer) {
    case 'height':
      for (let i = 0; i < count; i++) ramp(HEIGHT, geo.waterKind[i] === WaterKind.Sea ? Math.min(-0.5, geo.height[i]!) : Math.max(0.01, geo.waterLevel[i]!), out, i * 4);
      return { image: out, legend: legendOf(HEIGHT.filter((s) => s[0] !== 0.01), (v) => `${v} м`) };
    case 'moisture':
      for (let i = 0; i < count; i++) {
        if (geo.waterKind[i] !== WaterKind.None) water(i);
        else ramp(MOISTURE, env.moisture[i]! / world.derived.capacity[i]!, out, i * 4);
      }
      return { image: out, legend: [...legendOf(MOISTURE, (v) => `${Math.round(v * 100)} %`), { label: 'Вода', color: hex(...WATER_RGB) }] };
    case 'temperature': {
      const t = nowContext(world);
      const w = env.weather;
      for (let i = 0; i < count; i++) ramp(TEMPERATURE, cellTemperature(geo, i, t, chunkSample(w, w.chunkCloud, geo, i)), out, i * 4);
      return { image: out, legend: legendOf(TEMPERATURE, (v) => `${v} °C`) };
    }
    case 'precipitation':
      for (let i = 0; i < count; i++) {
        if (geo.waterKind[i] === WaterKind.Sea) water(i);
        else ramp(PRECIP, geo.precip[i]!, out, i * 4);
      }
      return { image: out, legend: legendOf(PRECIP, (v) => `${v} мм/год`) };
    case 'snow':
      for (let i = 0; i < count; i++) {
        if (geo.waterKind[i] !== WaterKind.None) water(i);
        else ramp(SNOW, env.snow[i]!, out, i * 4);
      }
      return { image: out, legend: legendOf(SNOW, (v) => `${v} мм`) };
    case 'soil':
      for (let i = 0; i < count; i++) {
        if (geo.waterKind[i] !== WaterKind.None) water(i);
        else {
          out.set(SOIL_COLORS[geo.soil[i]!] ?? [255, 0, 255], i * 4);
          out[i * 4 + 3] = 255;
        }
      }
      return { image: out, legend: SOILS.map((s, k) => ({ label: s.name, color: hex(...(SOIL_COLORS[k] ?? [255, 0, 255])) })) };
    case 'provinces':
      for (let i = 0; i < count; i++) {
        const id = geo.province[i]!;
        if (id === 0) {
          water(i);
          continue;
        }
        const x = i % n;
        const border = (x > 0 && geo.province[i - 1] !== id) || (i >= n && geo.province[i - n] !== id);
        const h = Math.imul(id, 2654435761) >>> 0;
        const r = 120 + (h & 0x7f);
        const g = 120 + ((h >>> 8) & 0x7f);
        const b = 110 + ((h >>> 16) & 0x6f);
        out[i * 4] = border ? 40 : r;
        out[i * 4 + 1] = border ? 36 : g;
        out[i * 4 + 2] = border ? 30 : b;
        out[i * 4 + 3] = 255;
      }
      return { image: out, legend: geo.provinces.map((p) => ({ label: p.name, color: '' })) };
  }
}

/** Слои, меняющиеся со временем: их изображение обновляется раз в игровой час. */
export const DYNAMIC_LAYERS: readonly LayerId[] = ['moisture', 'temperature', 'snow'];

/** Мини-карта в естественных цветах: рельеф с отмывкой, вода, снег, зелень. RGBA8 n². */
export function minimapImage(world: World, shade: Float32Array): Uint8Array {
  const geo = world.geo;
  const env = world.env;
  const count = geo.n * geo.n;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const kind = geo.waterKind[i]!;
    if (kind !== WaterKind.None) {
      const deep = kind === WaterKind.Sea ? smoothstep(0, -25, geo.height[i]!) : 0.3;
      out[o] = Math.round(70 - 35 * deep);
      out[o + 1] = Math.round(140 - 50 * deep);
      out[o + 2] = Math.round(170 - 20 * deep);
      out[o + 3] = 255;
      continue;
    }
    const g = env.greenness[i]!;
    const rock = smoothstep(0.35, 0.8, geo.slope[i]!);
    let r = 150 - 70 * g;
    let gg = 128 + 30 * g;
    let b = 88 - 20 * g;
    r += (138 - r) * rock;
    gg += (130 - gg) * rock;
    b += (120 - b) * rock;
    const snow = smoothstep(2, 30, env.snow[i]!);
    r += (245 - r) * snow;
    gg += (248 - gg) * snow;
    b += (252 - b) * snow;
    const s = shade[i]!;
    out[o] = Math.min(255, Math.round(r * s));
    out[o + 1] = Math.min(255, Math.round(gg * s));
    out[o + 2] = Math.min(255, Math.round(b * s));
    out[o + 3] = 255;
  }
  return out;
}

/** Отмывка рельефа для мини-карты (свет с северо-запада). */
export function hillshade(world: World): Float32Array {
  const geo = world.geo;
  const n = geo.n;
  const out = new Float32Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const h = (xx: number, zz: number) => geo.height[Math.min(n - 1, Math.max(0, zz)) * n + Math.min(n - 1, Math.max(0, xx))]!;
      const dx = (h(x + 1, z) - h(x - 1, z)) / (2 * geo.cellSize);
      const dz = (h(x, z + 1) - h(x, z - 1)) / (2 * geo.cellSize);
      const len = Math.sqrt(dx * dx + 1 + dz * dz);
      const lit = (-dx * -0.6 + 1 * 0.6 + -dz * -0.5) / len;
      out[z * n + x] = 0.55 + 0.6 * lit;
    }
  }
  return out;
}
