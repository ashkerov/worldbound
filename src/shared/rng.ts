// Детерминированная случайность WORLDBOUND.
// Только целочисленная арифметика (Math.imul, сдвиги) — результат одинаков
// во всех движках JS. Math.random в ядре симуляции запрещён линтером.

/** Перемешивание 32-битного целого (финализатор murmur3). */
export function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Хеш четырёх целых в одно 32-битное беззнаковое. */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = mix32((a | 0) ^ 0x9e3779b9);
  h = mix32(h ^ Math.imul(b | 0, 0x85ebca6b));
  h = mix32(h ^ Math.imul(c | 0, 0xc2b2ae35));
  h = mix32(h ^ Math.imul(d | 0, 0x27d4eb2f));
  return h;
}

const INV_2_32 = 1 / 4294967296;

/**
 * Счётчиковый генератор: значение в [0, 1) зависит только от аргументов.
 * Не зависит от порядка обхода и от того, какие ещё чанки сейчас активны —
 * основа независимости случайности от уровня детализации симуляции.
 */
export function counterRandom(seed: number, system: number, key: number, tick: number): number {
  return hash4(seed, system, key, tick) * INV_2_32;
}

/** Потоковый генератор sfc32 — для последовательных процессов (генерация мира). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number, stream = 0) {
    this.a = hash4(seed, stream, 1, 0);
    this.b = hash4(seed, stream, 2, 0);
    this.c = hash4(seed, stream, 3, 0);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Вещественное в [0, 1). */
  next(): number {
    return this.nextU32() * INV_2_32;
  }

  /** Вещественное в [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Целое в [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Строковый seed → 32-битное число (FNV-1a). */
export function seedFromString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
