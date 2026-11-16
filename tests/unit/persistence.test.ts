// Сохранения v1: секции с контрольными суммами, атомарность поколений, сохранить → загрузить → хеш совпал.

import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR } from '../../src/shared/time';
import { MemoryStorage } from '../../src/platform/storage/memory';
import { SectionReader, SectionWriter, crc32 } from '../../src/sim/persistence/binary';
import { WorldStore } from '../../src/worker/worldStore';
import { simulation } from '../support/worlds';

describe('Двоичные секции', () => {
  it('запись и чтение сохраняют значения побитно', () => {
    const f = new Float32Array([1.5, -2.25, Number.MAX_VALUE > 0 ? 3.4e38 : 0]);
    const d = new Float64Array([Math.PI, -0]);
    const u = new Uint8Array([1, 2, 3]);
    const bytes = new SectionWriter().f64(42).array(f).array(d).array(u).finish('test', 3);
    const r = new SectionReader(bytes, 'test');
    expect(r.header.schema).toBe(3);
    expect(r.f64()).toBe(42);
    expect(Array.from(r.into(new Float32Array(3)))).toEqual(Array.from(f));
    expect(Object.is(r.into(new Float64Array(2))[1], -0)).toBe(true);
    expect(Array.from(r.into(new Uint8Array(3)))).toEqual([1, 2, 3]);
  });

  it('повреждение данных и чужая секция обнаруживаются', () => {
    const bytes = new SectionWriter().array(new Float32Array(16).fill(7)).finish('env', 1);
    const broken = bytes.slice();
    broken[40] = broken[40]! ^ 0xff;
    expect(() => new SectionReader(broken, 'env')).toThrow(/контрольная сумма/);
    expect(() => new SectionReader(bytes, 'core')).toThrow(/Ожидалась секция core/);
    expect(() => new SectionReader(bytes.subarray(0, 50), 'env')).toThrow();
    expect(() => new SectionReader(bytes, 'env').into(new Float32Array(15))).toThrow(/длина массива/);
  });

  it('CRC-32 совпадает с эталоном', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('Хранилище миров', () => {
  const meta = { id: 'wtest', createdAt: '2026-11-16T00:00:00.000Z' };

  it('сохранить → загрузить → хеш совпал, и дальнейший ход одинаков', async () => {
    const storage = new MemoryStorage();
    const store = new WorldStore(storage);
    const sim = simulation({ seed: 42 }, 300);
    for (let t = 0; t < 2 * TICKS_PER_HOUR + 123; t++) sim.step();
    sim.enqueue({ type: 'spawnTestAgents', count: 7 });
    sim.step();
    await store.save(sim, meta, new Date('2026-11-16T10:00:00Z'));
    const { sim: loaded, manifest } = await store.load(meta.id, 0);
    expect(manifest.tick).toBe(sim.world.tick);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    for (let t = 0; t < TICKS_PER_HOUR + 50; t++) {
      sim.step();
      loaded.step();
    }
    expect(loaded.stateHash()).toBe(sim.stateHash());
  }, 60_000);

  it('список миров, повторные сохранения хранят только два поколения, удаление', async () => {
    const storage = new MemoryStorage();
    const store = new WorldStore(storage);
    const sim = simulation({ seed: 42, name: 'Долина' });
    for (let g = 0; g < 4; g++) {
      sim.step();
      await store.save(sim, meta, new Date(Date.UTC(2026, 10, 16, 10, g)));
    }
    const files = await storage.list(`worlds/${meta.id}`);
    expect(files.filter((f) => f.endsWith('.bin')).sort()).toEqual(['agents.g3.bin', 'agents.g4.bin', 'core.g3.bin', 'core.g4.bin', 'env.g3.bin', 'env.g4.bin']);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: meta.id, name: 'Долина', tick: sim.world.tick });
    expect(list[0]!.bytes).toBeGreaterThan(100_000);
    expect(await store.remove(meta.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  }, 60_000);

  it('сбой посреди записи нового поколения оставляет целым предыдущее', async () => {
    const storage = new MemoryStorage();
    const store = new WorldStore(storage);
    const sim = simulation({ seed: 42 });
    for (let t = 0; t < 100; t++) sim.step();
    await store.save(sim, meta, new Date('2026-11-16T10:00:00Z'));
    const hashGen1 = sim.stateHash();
    for (let t = 0; t < 400; t++) sim.step();
    await store.save(sim, meta, new Date('2026-11-16T10:05:00Z'));
    // Имитация сбоя: секция поколения 2 записана не полностью.
    const env2 = (await storage.read(`worlds/${meta.id}/env.g2.bin`))!;
    await storage.write(`worlds/${meta.id}/env.g2.bin`, env2.subarray(0, env2.length - 1000));
    const { sim: loaded, manifest } = await store.load(meta.id, 0);
    expect(manifest.generation).toBe(1);
    expect(loaded.stateHash()).toBe(hashGen1);
    // Если испорчен и манифест прежнего поколения — целого сохранения нет, мир честно не загружается.
    await storage.write(`worlds/${meta.id}/manifest.1.json`, new TextEncoder().encode('{"format":"worldbound-world"'));
    expect((await store.readManifest(meta.id))).toBeNull();
  }, 60_000);

  it('чужой или испорченный идентификатор мира отклоняется', async () => {
    const store = new WorldStore(new MemoryStorage());
    await expect(store.load('../evil', 0)).rejects.toThrow();
    await expect(store.load('missing', 0)).rejects.toThrow(/не найдено/);
  });
});
