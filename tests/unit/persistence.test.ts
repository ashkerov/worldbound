// Сохранения v1: секции с контрольными суммами, атомарность поколений, сохранить → загрузить → хеш совпал.

import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR } from '../../src/shared/time';
import { MemoryStorage } from '../../src/platform/storage/memory';
import { SectionReader, SectionWriter, crc32 } from '../../src/sim/persistence/binary';
import { WorldStore } from '../../src/worker/worldStore';
import { preparedSimulation, simulation } from '../support/worlds';

const meta = { id: 'wtest', createdAt: '2026-11-16T00:00:00.000Z' };

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

  it('такты во время записи файлов не портят сохранение: такт и хеш — того же мгновения, что и секции', async () => {
    // Как в воркере: пока файлы пишутся (await), цикл продолжает такты (ошибка найдена на этапе 5 фазы 3 на ×8).
    class SteppingStorage extends MemoryStorage {
      onWrite: (() => void) | null = null;
      override async write(path: string, bytes: Uint8Array): Promise<void> {
        this.onWrite?.();
        return super.write(path, bytes);
      }
    }
    const storage = new SteppingStorage();
    const store = new WorldStore(storage);
    const sim = simulation({ seed: 7 }, 20);
    for (let t = 0; t < 500; t++) sim.step();
    storage.onWrite = () => {
      for (let t = 0; t < 40; t++) sim.step();
    };
    await store.save(sim, meta, new Date('2026-11-19T10:00:00Z'));
    storage.onWrite = null;
    const { sim: loaded, manifest } = await store.load(meta.id, 0);
    expect(loaded.world.tick).toBe(manifest.tick);
    expect(manifest.tick).toBeLessThan(sim.world.tick);
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
    expect(files.filter((f) => f.endsWith('.bin')).sort()).toEqual(['agents.g3.bin', 'agents.g4.bin', 'core.g3.bin', 'core.g4.bin', 'env.g3.bin', 'env.g4.bin', 'flora.g3.bin', 'flora.g4.bin']);
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

describe('Совместимость и растения', () => {
  it('сохранение фазы 2 открывается: время и среда те же, травяной ярус восстановлен из индекса зелени', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = 'tests/fixtures/phase2-world';
    const expected = JSON.parse(readFileSync(`${dir}/expected.json`, 'utf-8')) as { tick: number; geoHash: string };
    const storage = new MemoryStorage();
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.bin') || name.startsWith('manifest')) await storage.write(`worlds/phase2/${name}`, new Uint8Array(readFileSync(`${dir}/${name}`)));
    }
    const store = new WorldStore(storage);
    const { sim, manifest, migrations } = await store.load('phase2', 0);
    expect(manifest.formatVersion).toBe(1);
    expect(migrations).toEqual(['flora:from-greenness']);
    expect(sim.world.tick).toBe(expected.tick);
    expect(sim.world.geoHash).toBe(expected.geoHash);
    expect(sim.world.config.scenario).toBe('wild');
    expect(sim.world.config.isolated).toBe(false);
    // Травы появились там, где была зелень; деревьев нет — их в фазе 2 не было.
    const f = sim.world.flora;
    let herbs = 0;
    for (let k = 0; k < f.slotBiomass.length; k++) herbs += f.slotBiomass[k]!;
    expect(herbs).toBeGreaterThan(0);
    expect(f.woody.count).toBe(0);
    // Пересохранение в новом формате и повторная загрузка — без миграций и с совпадением хеша.
    await store.save(sim, { id: 'phase2', createdAt: manifest.createdAt }, new Date('2026-11-17T10:00:00Z'));
    const again = await store.load('phase2', 0);
    expect(again.migrations).toEqual([]);
    expect(again.manifest.formatVersion).toBe(2);
    expect(again.sim.stateHash()).toBe(sim.stateHash());
  }, 60_000);

  it('растения, опад и запас питания переживают сохранение и загрузку побитно', async () => {
    const store = new WorldStore(new MemoryStorage());
    const sim = preparedSimulation({ seed: 42 });
    const w = sim.world.flora.woody;
    expect(w.count).toBeGreaterThan(0);
    // Освободим слот в середине, чтобы проверить и стек свободных слотов.
    w.remove(Math.floor(w.highWater / 2));
    sim.world.flora.litterFast[100] = 12.5;
    for (let t = 0; t < 50; t++) sim.step();
    await store.save(sim, meta, new Date('2026-11-17T10:00:00Z'));
    const { sim: loaded, migrations } = await store.load(meta.id, 0);
    expect(migrations).toEqual([]);
    expect(loaded.stateHash()).toBe(sim.stateHash());
    expect(loaded.world.flora.woody.freeSlots()).toEqual(w.freeSlots());
  }, 60_000);
});

describe('Миграция секции flora схемы 1 → 2', () => {
  // Раскладки схемы 1, записанные сборками этапов 1–2 фазы 3 (824aa8f — без суточных средних и полога; 8a3be81 — с ними).
  async function floraSchema1(full: boolean) {
    const { SectionWriter } = await import('../../src/sim/persistence/binary');
    const sim = simulation({ seed: 42 });
    for (let t = 0; t < 300; t++) sim.step();
    const f = sim.world.flora;
    const w = f.woody;
    const wh = w.highWater;
    const writer = new SectionWriter()
      .f64(f.lastSliceHour)
      .array(f.slotSpecies)
      .array(f.slotBiomass)
      .array(f.litterFast)
      .array(f.litterFastN)
      .array(f.litterWood)
      .array(f.litterWoodN)
      .array(f.nutrient)
      .array(f.accT)
      .array(f.accW)
      .array(f.accRunoff)
      .array(f.accMinT)
      .array(f.accHours);
    if (full) writer.array(f.dayT).array(f.dayW).array(f.capillary).array(f.canopy).array(f.treeCover).array(f.shrubCover).array(f.coniferCover);
    writer.array(f.ledger).f64(wh).f64(w.count).array(w.freeSlots());
    for (const col of [w.x, w.z, w.species, w.age, w.biomass, w.leaf, w.health, w.stage, w.stressW, w.stressL, w.alive, w.generation]) writer.array(col.subarray(0, wh));
    return { sim, bytes: writer.finish('flora', 1) };
  }

  for (const full of [false, true]) {
    it(`раскладка ${full ? '8a3be81' : '824aa8f'}: растения и опад переносятся, банк семян пуст, опад — среднего качества`, async () => {
      const { serializeWorld, applySections } = await import('../../src/sim/persistence/worldState');
      const { sim, bytes } = await floraSchema1(full);
      const sections = { ...serializeWorld(sim.world), flora: bytes };
      const target = simulation({ seed: 42, scenario: 'genesis' });
      const migrations = applySections(target.world, sections);
      expect(migrations).toEqual(['flora:schema1']);
      const a = sim.world.flora;
      const b = target.world.flora;
      expect(Array.from(b.slotBiomass)).toEqual(Array.from(a.slotBiomass));
      expect(b.woody.count).toBe(a.woody.count);
      expect(Array.from(b.woody.biomass.subarray(0, a.woody.highWater))).toEqual(Array.from(a.woody.biomass.subarray(0, a.woody.highWater)));
      expect(Array.from(b.litterFastQ)).toEqual(Array.from(b.litterFast));
      expect(b.seedBank.every((v) => v === 0)).toBe(true);
      // Счётчики древесных по ячейкам пересчитаны по растениям.
      let counted = 0;
      for (let i = 0; i < b.woodyCount.length; i++) counted += b.woodyCount[i]!;
      expect(counted).toBe(b.woody.count);
      // Мир после миграции идёт дальше без ошибок.
      for (let t = 0; t < 600; t++) target.step();
    });
  }
});
