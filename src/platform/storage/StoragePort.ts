// Абстракция хранилища (ARCHITECTURE.md, раздел 11.1).
// Реализации: OPFS (браузер, воркер), память (тесты); позже — файловая система (инструменты, десктоп).

export interface StoragePort {
  /** Имя реализации — для диагностики. */
  readonly backend: string;
  /** Содержимое файла или null, если файла нет. */
  read(path: string): Promise<Uint8Array | null>;
  /** Создаёт или целиком перезаписывает файл; недостающие каталоги создаются. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** true, если файл существовал и удалён. */
  remove(path: string): Promise<boolean>;
  /** Имена файлов и подкаталогов непосредственно в каталоге (подкаталоги — с «/» на конце). */
  list(dir: string): Promise<string[]>;
}

/** Нормализует путь: без ведущих/замыкающих «/», без пустых сегментов и «..». */
export function splitPath(path: string): string[] {
  const parts = path.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error(`Недопустимый путь: ${path}`);
  return parts;
}
