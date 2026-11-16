// Данные мира на стороне рендера: копия статики из сообщения протокола и текстуры полей.
// Рендер ничего не вычисляет о мире сам — только показывает то, что прислала симуляция.

import * as THREE from 'three/webgpu';
import type { HeightGrid, WorldStaticMessage } from '../shared/protocol';

/** Цвета почв (sRGB). Порядок задаётся идентификаторами из сообщения, а не индексами. */
const SOIL_COLORS: Record<string, number> = {
  rock: 0x857f75,
  sand: 0xc2b28c,
  loam: 0x6e5a43,
  clay: 0x7d6650,
  alluvial: 0x5a4a38,
  peat: 0x433a2f,
};

export interface Heights {
  samples: number;
  spacing: number;
  heights: Float32Array;
  originX: number;
  originZ: number;
}

export function heightsOf(grid: HeightGrid, originX = 0, originZ = 0): Heights {
  return { samples: grid.samples, spacing: grid.spacing, heights: new Float32Array(grid.heights), originX, originZ };
}

/** Билинейная выборка высоты; за краем — значение края. */
export function sampleHeight(h: Heights, x: number, z: number): number {
  const last = h.samples - 1;
  let fx = (x - h.originX) / h.spacing;
  let fz = (z - h.originZ) / h.spacing;
  fx = fx < 0 ? 0 : fx > last ? last : fx;
  fz = fz < 0 ? 0 : fz > last ? last : fz;
  let ix = Math.floor(fx);
  let iz = Math.floor(fz);
  if (ix >= last) ix = last - 1;
  if (iz >= last) iz = last - 1;
  const tx = fx - ix;
  const tz = fz - iz;
  const a = h.heights;
  const r = iz * h.samples + ix;
  return (a[r]! * (1 - tx) + a[r + 1]! * tx) * (1 - tz) + (a[r + h.samples]! * (1 - tx) + a[r + h.samples + 1]! * tx) * tz;
}

function dataTexture(data: Uint8Array | Uint16Array, size: number, format: THREE.PixelFormat, type: THREE.TextureDataType, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, format, type);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export class WorldData {
  readonly worldSize: number;
  readonly n: number;
  readonly cellSize: number;
  readonly terrain: Heights;
  readonly horizon: Heights;
  readonly cellHeight: Float32Array;
  readonly waterKind: Uint8Array;
  readonly waterLevel: Float32Array;
  readonly flow: Int8Array;
  readonly meanDischarge: Float32Array;
  readonly precipFactor: Float32Array;
  /** RGBA8: цвет почвы (sRGB) и плодородие. */
  readonly staticTex: THREE.DataTexture;
  /** RGBA8: снег, влага, зелень, осадки сейчас — обновляется раз в игровой час. */
  readonly surfaceTex: THREE.DataTexture;
  /** RGBA8: слой-карта поверх рельефа. */
  readonly layerTex: THREE.DataTexture;
  /** RGBA8 по чанкам: R — облачность, G — осадки. */
  readonly weatherTex: THREE.DataTexture;
  /** R16F: высота дна ячеек — глубина моря и пена у берега. */
  readonly depthTex: THREE.DataTexture;
  /** R16F: высоты горизонта за границей мира. */
  readonly horizonDepthTex: THREE.DataTexture;
  readonly chunks: number;

  constructor(readonly message: WorldStaticMessage) {
    this.worldSize = message.worldSize;
    this.n = message.n;
    this.cellSize = message.cellSize;
    this.terrain = heightsOf(message.terrain);
    this.horizon = heightsOf(message.horizon, message.horizon.originX, message.horizon.originZ);
    this.cellHeight = new Float32Array(message.cellHeight);
    this.waterKind = new Uint8Array(message.waterKind);
    this.waterLevel = new Float32Array(message.waterLevel);
    this.flow = new Int8Array(message.flow);
    this.meanDischarge = new Float32Array(message.meanDischarge);
    this.precipFactor = new Float32Array(message.precipFactor);
    const n = this.n;
    const soil = new Uint8Array(message.soil);
    const st = new Uint8Array(n * n * 4);
    const color = new THREE.Color();
    for (let i = 0; i < n * n; i++) {
      color.setHex(SOIL_COLORS[message.soilIds[soil[i]!] ?? ''] ?? 0xff00ff, THREE.NoColorSpace);
      st[i * 4] = Math.round(color.r * 255);
      st[i * 4 + 1] = Math.round(color.g * 255);
      st[i * 4 + 2] = Math.round(color.b * 255);
      st[i * 4 + 3] = 255;
    }
    this.staticTex = dataTexture(st, n, THREE.RGBAFormat, THREE.UnsignedByteType, true);
    this.surfaceTex = dataTexture(new Uint8Array(n * n * 4), n, THREE.RGBAFormat, THREE.UnsignedByteType, false);
    this.layerTex = dataTexture(new Uint8Array(n * n * 4), n, THREE.RGBAFormat, THREE.UnsignedByteType, true);
    this.chunks = Math.max(2, Math.round(this.worldSize / 128));
    this.weatherTex = dataTexture(new Uint8Array(this.chunks * this.chunks * 4), this.chunks, THREE.RGBAFormat, THREE.UnsignedByteType, false);
    const half = new Uint16Array(n * n);
    for (let i = 0; i < n * n; i++) half[i] = THREE.DataUtils.toHalfFloat(this.cellHeight[i]!);
    this.depthTex = dataTexture(half, n, THREE.RedFormat, THREE.HalfFloatType, false);
    const hs = this.horizon.samples;
    const hh = new Uint16Array(hs * hs);
    for (let i = 0; i < hs * hs; i++) hh[i] = THREE.DataUtils.toHalfFloat(this.horizon.heights[i]!);
    this.horizonDepthTex = dataTexture(hh, hs, THREE.RedFormat, THREE.HalfFloatType, false);
  }

  setSurface(data: ArrayBuffer): void {
    (this.surfaceTex.image.data as Uint8Array).set(new Uint8Array(data));
    this.surfaceTex.needsUpdate = true;
  }

  setLayer(image: ArrayBuffer): void {
    (this.layerTex.image.data as Uint8Array).set(new Uint8Array(image));
    this.layerTex.needsUpdate = true;
  }

  setWeather(cloud: Float32Array, rate: Float32Array): void {
    const data = this.weatherTex.image.data as Uint8Array;
    const c = this.chunks;
    for (let i = 0; i < c * c && i < cloud.length; i++) {
      data[i * 4] = Math.round(Math.min(1, cloud[i]!) * 255);
      data[i * 4 + 1] = Math.round(Math.min(1, rate[i]! / 8) * 255);
      data[i * 4 + 3] = 255;
    }
    this.weatherTex.needsUpdate = true;
  }

  /** Высота поверхности: внутри мира — рельеф 2 м, снаружи — горизонт. */
  groundAt(x: number, z: number): number {
    const s = this.worldSize;
    if (x >= 0 && z >= 0 && x <= s && z <= s) return sampleHeight(this.terrain, x, z);
    return sampleHeight(this.horizon, x, z);
  }

  dispose(): void {
    for (const t of [this.staticTex, this.surfaceTex, this.layerTex, this.weatherTex, this.depthTex, this.horizonDepthTex]) t.dispose();
  }
}
