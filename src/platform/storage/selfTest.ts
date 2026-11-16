import type { StoragePort } from './StoragePort';

export interface StorageSelfTestResult {
  ok: boolean;
  backend: string;
  detail: string;
}

/** Запись → чтение → сравнение → список → удаление. Общая проверка любой реализации StoragePort. */
export async function storageSelfTest(storage: StoragePort): Promise<StorageSelfTestResult> {
  const path = 'selftest/probe.bin';
  try {
    const data = new Uint8Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    await storage.write(path, data);
    const back = await storage.read(path);
    if (!back || back.length !== data.length) throw new Error('длина прочитанного не совпала');
    for (let i = 0; i < data.length; i++) {
      if (back[i] !== data[i]) throw new Error(`расхождение в байте ${i}`);
    }
    // Перезапись более коротким содержимым не должна оставлять «хвост».
    await storage.write(path, data.subarray(0, 10));
    const short = await storage.read(path);
    if (!short || short.length !== 10) throw new Error('перезапись не усекла файл');
    const listed = await storage.list('selftest');
    if (!listed.includes('probe.bin')) throw new Error('файл не найден в списке каталога');
    if (!(await storage.remove(path))) throw new Error('удаление вернуло false');
    if ((await storage.read(path)) !== null) throw new Error('файл читается после удаления');
    await storage.remove('selftest');
    return { ok: true, backend: storage.backend, detail: 'запись, чтение, перезапись, список и удаление прошли' };
  } catch (error) {
    return { ok: false, backend: storage.backend, detail: error instanceof Error ? error.message : String(error) };
  }
}
