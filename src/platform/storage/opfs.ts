// Хранилище в Origin Private File System. Работает в воркере:
// запись идёт через синхронный дескриптор (createSyncAccessHandle), что быстро
// и не блокирует главный поток.

import { splitPath, type StoragePort } from './StoragePort';

export function isOpfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export class OpfsStorage implements StoragePort {
  readonly backend = 'opfs';

  /** `root` — подкаталог в OPFS, в котором живёт всё хранилище. */
  constructor(private readonly root = 'worldbound') {}

  private async directory(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let dir = await navigator.storage.getDirectory();
    for (const name of [this.root, ...parts]) {
      try {
        dir = await dir.getDirectoryHandle(name, { create });
      } catch (error) {
        if (!create && isNotFound(error)) return null;
        throw error;
      }
    }
    return dir;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const parts = splitPath(path);
    const name = parts.pop();
    if (!name) return null;
    const dir = await this.directory(parts, false);
    if (!dir) return null;
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const parts = splitPath(path);
    const name = parts.pop();
    if (!name) throw new Error('Пустой путь');
    const dir = (await this.directory(parts, true))!;
    const handle = await dir.getFileHandle(name, { create: true });
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(0);
      let written = 0;
      while (written < data.byteLength) {
        written += access.write(data.subarray(written), { at: written });
      }
      access.flush();
    } finally {
      access.close();
    }
  }

  async remove(path: string): Promise<boolean> {
    const parts = splitPath(path);
    const name = parts.pop();
    if (!name) return false;
    const dir = await this.directory(parts, false);
    if (!dir) return false;
    try {
      await dir.removeEntry(name, { recursive: true });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async list(dirPath: string): Promise<string[]> {
    const dir = await this.directory(splitPath(dirPath), false);
    if (!dir) return [];
    const names: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      names.push(handle.kind === 'directory' ? name + '/' : name);
    }
    return names.sort();
  }
}
