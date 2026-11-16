import { splitPath, type StoragePort } from './StoragePort';

/** Хранилище в памяти: тесты и запасной путь, когда OPFS недоступна. */
export class MemoryStorage implements StoragePort {
  readonly backend = 'memory';
  private readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    const data = this.files.get(splitPath(path).join('/'));
    return data ? data.slice() : null;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const parts = splitPath(path);
    if (parts.length === 0) throw new Error('Пустой путь');
    this.files.set(parts.join('/'), data.slice());
  }

  /** Удаляет файл или каталог целиком (как OPFS removeEntry с recursive). */
  async remove(path: string): Promise<boolean> {
    const key = splitPath(path).join('/');
    let removed = this.files.delete(key);
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(key + '/')) removed = this.files.delete(k) || removed;
    }
    return removed;
  }

  async list(dir: string): Promise<string[]> {
    const prefix = splitPath(dir).join('/');
    const base = prefix.length > 0 ? prefix + '/' : '';
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(base)) continue;
      const rest = key.slice(base.length);
      const slash = rest.indexOf('/');
      names.add(slash < 0 ? rest : rest.slice(0, slash + 1));
    }
    return [...names].sort();
  }
}
