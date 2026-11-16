import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/platform/storage/memory';
import { storageSelfTest } from '../../src/platform/storage/selfTest';
import { splitPath } from '../../src/platform/storage/StoragePort';

describe('StoragePort: реализация в памяти', () => {
  it('проходит общий самотест хранилища', async () => {
    expect(await storageSelfTest(new MemoryStorage())).toMatchObject({ ok: true, backend: 'memory' });
  });

  it('хранит копию данных, а не ссылку на буфер вызывающего', async () => {
    const storage = new MemoryStorage();
    const data = new Uint8Array([1, 2, 3]);
    await storage.write('a/b.bin', data);
    data[0] = 99;
    const read = (await storage.read('a/b.bin'))!;
    expect(Array.from(read)).toEqual([1, 2, 3]);
    read[1] = 77;
    expect(Array.from((await storage.read('a/b.bin'))!)).toEqual([1, 2, 3]);
  });

  it('list показывает только непосредственное содержимое каталога', async () => {
    const storage = new MemoryStorage();
    await storage.write('worlds/w1/manifest.json', new Uint8Array(1));
    await storage.write('worlds/w1/terrain/0_0.bin', new Uint8Array(1));
    await storage.write('worlds/w2/manifest.json', new Uint8Array(1));
    expect(await storage.list('worlds')).toEqual(['w1/', 'w2/']);
    expect(await storage.list('worlds/w1')).toEqual(['manifest.json', 'terrain/']);
    expect(await storage.list('nowhere')).toEqual([]);
  });

  it('чтение и удаление отсутствующего файла не бросают исключений', async () => {
    const storage = new MemoryStorage();
    expect(await storage.read('missing.bin')).toBeNull();
    expect(await storage.remove('missing.bin')).toBe(false);
  });

  it('пути с «..» отклоняются', () => {
    expect(() => splitPath('worlds/../secret')).toThrow();
    expect(splitPath('/worlds//w1/./a.bin/')).toEqual(['worlds', 'w1', 'a.bin']);
  });
});
