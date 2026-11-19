// Представление растительности для рендера (этап 5 фазы 3): только чтение авторитетного состояния флоры.
// Древесные — по чанкам (FLORA_CHUNK_CELLS ячеек по стороне), с передачей только изменившихся чанков;
// травяной ярус и полог — поле по ячейкам. Ничего здесь не меняет мир (проверяется тестом: хеш не меняется).

import { FLORA_CHUNK_CELLS, FLORA_WOODY_STRIDE, HERB_FIELD_MAX, type FloraFieldMessage, type FloraWoodyMessage } from '../../shared/protocol';
import type { World } from '../core/world';
import { NO_SPECIES, SPECIES } from '../flora/species';
import { SLOTS } from '../flora/state';
import { crownRadius, woodyHeight } from '../flora/system';

/** Округление для сравнения чанков: высота и крона — до 5 см, облиственность — до 1/32. */
const HEIGHT_Q = 20;
const LEAF_Q = 32;

/**
 * Источник данных растительности для одного открытого мира. Помнит контрольные суммы отправленных чанков,
 * чтобы в следующий раз отправить только изменившиеся.
 */
export class FloraFeed {
  private sums: Uint32Array | null = null;
  /** Сколько чанков было в последней посылке и сколько всего (для отчёта о доле изменившихся). */
  lastSent = 0;
  lastTotal = 0;

  constructor(private readonly world: World) {}

  /** Древесные растения по чанкам. full — отправить все чанки (после открытия мира). */
  woody(full: boolean): { message: FloraWoodyMessage; transfer: ArrayBuffer[] } {
    const world = this.world;
    const n = world.geo.n;
    const cpsd = Math.ceil(n / FLORA_CHUNK_CELLS);
    const chunks = cpsd * cpsd;
    const w = world.flora.woody;
    const high = w.highWater;
    // Сортировка подсчётом: номер чанка каждого растения.
    const counts = new Int32Array(chunks + 1);
    const chunkOf = new Int32Array(high).fill(-1);
    for (let i = 0; i < high; i++) {
      if (w.alive[i] !== 1) continue;
      const c = w.cell[i]!;
      const x = c % n;
      const z = (c - x) / n;
      const k = Math.floor(z / FLORA_CHUNK_CELLS) * cpsd + Math.floor(x / FLORA_CHUNK_CELLS);
      chunkOf[i] = k;
      counts[k + 1]!++;
    }
    for (let k = 0; k < chunks; k++) counts[k + 1]! += counts[k]!;
    const total = counts[chunks]!;
    const rows = new Float32Array(total * FLORA_WOODY_STRIDE);
    const fill = counts.slice(0, chunks);
    for (let i = 0; i < high; i++) {
      const k = chunkOf[i]!;
      if (k < 0) continue;
      const s = w.species[i]!;
      const b = w.biomass[i]!;
      const o = fill[k]!++ * FLORA_WOODY_STRIDE;
      rows[o] = w.x[i]!;
      rows[o + 1] = w.z[i]!;
      rows[o + 2] = woodyHeight(s, b);
      rows[o + 3] = crownRadius(s, b);
      rows[o + 4] = s;
      rows[o + 5] = w.leaf[i]!;
      rows[o + 6] = (w.idOf(i) >>> 0) % 16777216;
      rows[o + 7] = w.health[i]!;
    }
    // Контрольные суммы чанков (FNV-1a по округлённым значениям) — порядок растений в чанке устойчив (по индексу).
    const sums = new Uint32Array(chunks);
    for (let k = 0; k < chunks; k++) {
      let h = 2166136261;
      for (let r = counts[k]!; r < counts[k + 1]!; r++) {
        const o = r * FLORA_WOODY_STRIDE;
        h = mix(h, Math.round(rows[o]! * 4));
        h = mix(h, Math.round(rows[o + 1]! * 4));
        h = mix(h, Math.round(rows[o + 2]! * HEIGHT_Q));
        h = mix(h, Math.round(rows[o + 3]! * HEIGHT_Q));
        h = mix(h, rows[o + 4]!);
        h = mix(h, Math.round(rows[o + 5]! * LEAF_Q));
        h = mix(h, rows[o + 6]!);
      }
      sums[k] = h;
    }
    const prev = full ? null : this.sums;
    const changed: number[] = [];
    for (let k = 0; k < chunks; k++) if (!prev || prev[k] !== sums[k]) changed.push(k);
    this.sums = sums;
    let size = 0;
    for (const k of changed) size += counts[k + 1]! - counts[k]!;
    const data = new Float32Array(size * FLORA_WOODY_STRIDE);
    const offsets = new Int32Array(changed.length + 1);
    let at = 0;
    changed.forEach((k, j) => {
      offsets[j] = at;
      const from = counts[k]! * FLORA_WOODY_STRIDE;
      const to = counts[k + 1]! * FLORA_WOODY_STRIDE;
      data.set(rows.subarray(from, to), at * FLORA_WOODY_STRIDE);
      at += counts[k + 1]! - counts[k]!;
    });
    offsets[changed.length] = at;
    this.lastSent = changed.length;
    this.lastTotal = chunks;
    const chunkIds = Int32Array.from(changed);
    const message: FloraWoodyMessage = { type: 'floraWoody', tick: world.tick, full, chunksPerSide: cpsd, chunkIds: chunkIds.buffer, offsets: offsets.buffer, data: data.buffer, total };
    return { message, transfer: [chunkIds.buffer, offsets.buffer, data.buffer] };
  }

  /** Травяной ярус по видам и полог по ячейкам. */
  field(): { message: FloraFieldMessage; transfer: ArrayBuffer[] } {
    const world = this.world;
    const f = world.flora;
    const n = world.geo.n;
    const count = n * n;
    const herbsN = SPECIES.herbs.length;
    const herbs = new Uint8Array(count * herbsN);
    const canopy = new Uint8Array(count * 4);
    for (let c = 0; c < count; c++) {
      for (let k = 0; k < SLOTS; k++) {
        const s = f.slotSpecies[c * SLOTS + k]!;
        if (s === NO_SPECIES) continue;
        const h = SPECIES.herbSlot[s]!;
        const v = Math.round(Math.sqrt(Math.min(1, f.slotBiomass[c * SLOTS + k]! / HERB_FIELD_MAX)) * 255);
        const o = c * herbsN + h;
        herbs[o] = Math.min(255, herbs[o]! + v);
      }
      const tree = f.treeCover[c]!;
      canopy[c * 4] = Math.round(Math.min(1, tree) * 255);
      canopy[c * 4 + 1] = tree > 1e-4 ? Math.round(Math.min(1, f.coniferCover[c]! / tree) * 255) : 0;
      canopy[c * 4 + 2] = Math.round(Math.min(1, f.shrubCover[c]!) * 255);
    }
    // Средняя облиственность древесных ячейки.
    const w = f.woody;
    const leafSum = new Float32Array(count);
    const leafN = new Uint16Array(count);
    for (let i = 0; i < w.highWater; i++) {
      if (w.alive[i] !== 1) continue;
      const c = w.cell[i]!;
      leafSum[c] = leafSum[c]! + w.leaf[i]!;
      if (leafN[c]! < 65535) leafN[c] = leafN[c]! + 1;
    }
    for (let c = 0; c < count; c++) canopy[c * 4 + 3] = leafN[c]! > 0 ? Math.round(Math.min(1, leafSum[c]! / leafN[c]!) * 255) : 255;
    const message: FloraFieldMessage = { type: 'floraField', tick: world.tick, n, herbs: herbs.buffer, canopy: canopy.buffer };
    return { message, transfer: [herbs.buffer, canopy.buffer] };
  }
}

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}
