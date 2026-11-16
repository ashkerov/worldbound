// Заполнение впадин (priority-flood, Barnes et al. 2014) с построением дерева стока.
// Обход идёт от моря вверх: каждая ячейка получает «приёмник» — соседа, из которого до неё
// дошла волна. Это и есть направление стока (D8), а порядок извлечения из очереди —
// порядок «сначала вниз по течению». Результат детерминирован: равные высоты упорядочены по индексу.

export interface FloodResult {
  /** Поверхность с заполненными впадинами (уровень, до которого поднялась бы вода). */
  filled: Float64Array;
  /** Ячейка ниже по течению; −1 — сток в море. */
  receiver: Int32Array;
  /** Ячейки в порядке «сначала ниже по течению». Обратный порядок — от истоков к устьям. */
  order: Int32Array;
}

/** Двоичная куча индексов с ключом (высота, индекс). */
class MinHeap {
  private readonly items: Int32Array;
  private size = 0;
  constructor(
    capacity: number,
    private readonly key: Float64Array,
  ) {
    this.items = new Int32Array(capacity);
  }
  get length(): number {
    return this.size;
  }
  private less(a: number, b: number): boolean {
    const ka = this.key[a]!;
    const kb = this.key[b]!;
    return ka < kb || (ka === kb && a < b);
  }
  push(i: number): void {
    const items = this.items;
    let k = this.size++;
    items[k] = i;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (!this.less(items[k]!, items[parent]!)) break;
      const t = items[k]!;
      items[k] = items[parent]!;
      items[parent] = t;
      k = parent;
    }
  }
  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items[--this.size]!;
    if (this.size > 0) {
      items[0] = last;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < this.size && this.less(items[l]!, items[m]!)) m = l;
        if (r < this.size && this.less(items[r]!, items[m]!)) m = r;
        if (m === k) break;
        const t = items[k]!;
        items[k] = items[m]!;
        items[m] = t;
        k = m;
      }
    }
    return top;
  }
}

export const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
export const DZ8 = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * @param height высоты ячеек n×n
 * @param outlet 1 — ячейка моря (сток); вода из суши уходит только в море
 * @param epsilon минимальный уклон заполненной поверхности на шаг — плоские участки тоже стекают
 */
export function priorityFlood(n: number, height: ArrayLike<number>, outlet: Uint8Array, epsilon: number): FloodResult {
  const count = n * n;
  const filled = new Float64Array(count);
  const receiver = new Int32Array(count).fill(-1);
  const order = new Int32Array(count);
  const done = new Uint8Array(count);
  const heap = new MinHeap(count, filled);
  for (let i = 0; i < count; i++) {
    filled[i] = height[i]!;
    if (outlet[i] === 1) {
      done[i] = 1;
      heap.push(i);
    }
  }
  let k = 0;
  while (heap.length > 0) {
    const c = heap.pop();
    order[k++] = c;
    const cx = c % n;
    const cz = (c - cx) / n;
    const fc = filled[c]!;
    for (let d = 0; d < 8; d++) {
      const x = cx + DX8[d]!;
      const z = cz + DZ8[d]!;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const i = z * n + x;
      if (done[i] === 1) continue;
      done[i] = 1;
      const h = height[i]!;
      filled[i] = h > fc + epsilon ? h : fc + epsilon;
      receiver[i] = c;
      heap.push(i);
    }
  }
  // Ячейки, до которых волна не дошла (мир без моря), — собственные стоки.
  if (k < count) {
    for (let i = 0; i < count; i++) if (done[i] === 0) order[k++] = i;
  }
  return { filled, receiver, order };
}
