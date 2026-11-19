// Этап 5 фазы 3: данные растительности для рендера — только чтение. Проверки «наблюдатель не меняет мир»:
// сборка снимков не меняет хеш состояния; в снимке ровно растения симуляции; без изменений посылка пуста.

import { describe, expect, it } from 'vitest';
import { FLORA_CHUNK_CELLS, FLORA_WOODY_STRIDE, HERB_FIELD_MAX } from '../../src/shared/protocol';
import { SPECIES } from '../../src/sim/flora/species';
import { herbBiomass } from '../../src/sim/flora/state';
import { woodyHeight } from '../../src/sim/flora/system';
import { FloraFeed } from '../../src/sim/view/flora';
import { plotSimulation, runDays } from '../support/plot';

const PLOT = { n: 48, precip: 720, soil: 'loam' as const, fertility: 0.75, riverColumns: 3 };

function prepared(seed: number) {
  const sim = plotSimulation(PLOT, { scenario: 'wild', seed }, 4);
  while (sim.preparation) sim.advancePreparation(7200);
  return sim;
}

describe('Данные растительности для рендера', () => {
  it.each([1, 2])('seed %i: сборка снимков не меняет мир; ход мира с наблюдателем и без — одинаков', (seed) => {
    const a = prepared(seed);
    const b = prepared(seed);
    const feed = new FloraFeed(a.world);
    const before = a.stateHash();
    feed.woody(true);
    feed.field();
    expect(a.stateHash()).toBe(before);
    for (let day = 0; day < 6; day++) {
      runDays(a, 1);
      feed.woody(false);
      feed.field();
      runDays(b, 1);
    }
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('в снимке — ровно растения симуляции: число, места, виды, высоты', () => {
    const sim = prepared(3);
    const w = sim.world.flora.woody;
    const { message } = new FloraFeed(sim.world).woody(true);
    const data = new Float32Array(message.data);
    const offsets = new Int32Array(message.offsets);
    const ids = new Int32Array(message.chunkIds);
    expect(message.total).toBe(w.count);
    expect(data.length / FLORA_WOODY_STRIDE).toBe(w.count);
    expect(ids.length).toBe(message.chunksPerSide ** 2);
    // Каждое растение лежит в своём чанке и совпадает с данными хранилища.
    const byId = new Map<number, number>();
    for (let i = 0; i < w.highWater; i++) if (w.alive[i]) byId.set((w.idOf(i) >>> 0) % 16777216, i);
    const chunkM = FLORA_CHUNK_CELLS * sim.world.geo.cellSize;
    for (let k = 0; k < ids.length; k++) {
      const cx = ids[k]! % message.chunksPerSide;
      const cz = Math.floor(ids[k]! / message.chunksPerSide);
      for (let r = offsets[k]!; r < offsets[k + 1]!; r++) {
        const o = r * FLORA_WOODY_STRIDE;
        const i = byId.get(data[o + 6]!)!;
        expect(i).toBeDefined();
        expect(data[o]).toBeCloseTo(w.x[i]!, 3);
        expect(data[o + 1]).toBeCloseTo(w.z[i]!, 3);
        expect(data[o + 4]).toBe(w.species[i]);
        expect(data[o + 2]).toBeCloseTo(woodyHeight(w.species[i]!, w.biomass[i]!), 4);
        expect(data[o + 5]).toBeCloseTo(w.leaf[i]!, 5);
        expect(Math.floor(data[o]! / chunkM)).toBe(cx);
        expect(Math.floor(data[o + 1]! / chunkM)).toBe(cz);
      }
    }
  });

  it('без изменений в мире повторная посылка пуста; после суток — только изменившиеся чанки', () => {
    const sim = prepared(1);
    const feed = new FloraFeed(sim.world);
    feed.woody(true);
    expect(new Int32Array(feed.woody(false).message.chunkIds).length).toBe(0);
    runDays(sim, 1);
    const changed = new Int32Array(feed.woody(false).message.chunkIds).length;
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(feed.lastTotal);
  });

  it('поле трав: биомасса видов по ячейкам с точностью квантования', () => {
    const sim = prepared(2);
    const { message } = new FloraFeed(sim.world).field();
    const herbs = new Uint8Array(message.herbs);
    const H = SPECIES.herbs.length;
    const n = sim.world.geo.n;
    for (let c = 0; c < n * n; c += 7) {
      let sum = 0;
      for (let h = 0; h < H; h++) sum += (herbs[c * H + h]! / 255) ** 2 * HERB_FIELD_MAX;
      const real = herbBiomass(sim.world.flora, c);
      expect(Math.abs(sum - real)).toBeLessThan(Math.max(8, real * 0.05));
    }
  });
});
