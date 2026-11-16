// Прототип 1C: согласованность уровней симуляции.
// Одноразовый исследовательский код (DEVELOPMENT_PLAN.md, фаза 1). В проект переносятся выводы.
//
// Мир: сетка чанков 128 м (16×16 ячеек по 8 м). Три трофических уровня:
// трава (поле по ячейкам) → кролики → лисы.
// Чанк считается одним из способов:
//   S0          — пространственный: 24 шага в сутки, особи ходят, ищут корм и добычу;
//   far=meanfield — особи сохраняются, но раз в сутки обновляются «в среднем по чанку»;
//   far=cohort    — особи свёрнуты в счётчики по стадиям и суммарную энергию.
// Биология (энергетический бюджет, размножение, старение) — общие функции для всех способов.

import { counterRandom } from '../../src/shared/rng';
import { StateHasher } from '../../src/sim/core/hash';

export const CELLS = 16;
export const CELL_M = 8;
export const CHUNK_M = CELLS * CELL_M;
export const HOURS = 24;
const DT = 1 / HOURS;

export const RABBIT = 0;
export const FOX = 1;
export const CAUSES = ['голод', 'хищник', 'старость', 'случайная'] as const;
const STARVE = 0;
const PREDATION = 1;
const OLD_AGE = 2;
const BASE = 3;

export interface SpeciesParams {
  /** Максимальное потребление в сутки (кролик — единиц травы). */
  intakeMax: number;
  /** Энергия с единицы пищи (лиса — с одного кролика). */
  conv: number;
  metabolism: number;
  eMax: number;
  birthEnergy: number;
  reproThreshold: number;
  reproCost: number;
  litter: number;
  cooldown: number;
  matureDays: number;
  lifespan: number;
  baseMortality: number;
  /** Доля eMax, ниже которой особь голодна (лиса начинает охоту). */
  hungryFrac: number;
}

export const SPECIES: SpeciesParams[] = [
  { intakeMax: 1.2, conv: 1, metabolism: 0.6, eMax: 10, birthEnergy: 4, reproThreshold: 8.5, reproCost: 3.5, litter: 2, cooldown: 10, matureDays: 6, lifespan: 60, baseMortality: 0.004, hungryFrac: 1 },
  { intakeMax: 0, conv: 2.5, metabolism: 0.6, eMax: 12, birthEnergy: 6, reproThreshold: 10, reproCost: 4, litter: 2, cooldown: 25, matureDays: 14, lifespan: 120, baseMortality: 0.002, hungryFrac: 0.75 },
];

/** Территориальность: лиса не размножается, если в её чанке уже столько лис. Правило общее для всех уровней. */
export const FOX_TERRITORY_CAP = 2;
/** Укрытие: в ячейке с травой не ниже этого уровня лиса кролика не замечает. */
export const COVER = 0.6;

export const GRASS = { K: 1, r: 0.5, floor: 0.1 };

/** Таблица зависимости y(x) по равным интервалам с линейной интерполяцией между центрами. */
export class Table {
  constructor(
    readonly lo: number,
    readonly hi: number,
    readonly values: number[],
  ) {}

  at(x: number): number {
    const n = this.values.length;
    const t = ((x - this.lo) / (this.hi - this.lo)) * n - 0.5;
    if (t <= 0) return this.values[0]!;
    if (t >= n - 1) return this.values[n - 1]!;
    const i = Math.floor(t);
    return this.values[i]! + (this.values[i + 1]! - this.values[i]!) * (t - i);
  }
}

/** Двумерная таблица z(x, y) с выборкой по ближайшему интервалу. */
export class Table2 {
  constructor(
    readonly xLo: number,
    readonly xHi: number,
    readonly nx: number,
    readonly yLo: number,
    readonly yHi: number,
    readonly ny: number,
    readonly values: number[],
  ) {}

  at(x: number, y: number): number {
    let i = Math.floor(((x - this.xLo) / (this.xHi - this.xLo)) * this.nx);
    let j = Math.floor(((y - this.yLo) / (this.yHi - this.yLo)) * this.ny);
    if (i < 0) i = 0;
    else if (i >= this.nx) i = this.nx - 1;
    if (j < 0) j = 0;
    else if (j >= this.ny) j = this.ny - 1;
    return this.values[j * this.nx + i]!;
  }
}

/** Параметры «дальнего» уровня. Получаются калибровкой по S0 (см. calibrate.ts). */
export interface FarParams {
  /** Доля желаемого потребления, которую кролик реально получает, от средней травы на ячейку. */
  intake: Table;
  /** Добыч на голодную лису в сутки от числа кроликов в чанке и средней травы (трава — укрытие). */
  kill: Table2;
  /** Вероятность перейти в соседний чанк за сутки, по видам. */
  disperse: [number, number];
  // Замыкания, нужные только когортам (особи неразличимы — нужна зависимость от средней энергии):
  desire: Table;
  hungry: Table;
  starve: [Table, Table];
  repro: [Table, Table];
  /** Смертность взрослых от старости в сутки (возрастная структура в когорте потеряна). */
  oldAge: [number, number];
  /** Для варианта coarse: добыч на голодную лису в сутки от числа кроликов чанка вне укрытия. */
  killExposed: Table;
}

/**
 * unified — единая модель: весь мир всегда считается пространственной моделью, а зона наблюдателя
 * задаёт только «воплощение» (плавное движение, анимация) и на расчёт не влияет.
 */
export type FarMode = 'meanfield' | 'cohort' | 'coarse' | 'unified';

/** Суточная выборка по чанку S0 — сырьё для калибровки. */
export interface ChunkSample {
  grass: number;
  /** Кроликов вне укрытия (в ячейках с травой ниже COVER) на начало суток. */
  exposed: number;
  n: [number, number];
  adults: [number, number];
  energy: [number, number];
  /** Суммарная энергия взрослых — для таблицы размножения. */
  adultEnergy: [number, number];
  desired: number;
  got: number;
  hungryFoxDays: number;
  kills: number;
  starved: [number, number];
  oldAge: [number, number];
  litters: [number, number];
  crossed: [number, number];
}

const P_SPAWN = 11;
const P_MOVE = 12;
const P_CATCH = 13;
const P_LIFE = 14;
const P_FAR = 15;
const P_PLACE = 16;

export class LodWorld {
  readonly nx: number;
  readonly ny: number;
  readonly nChunks: number;
  readonly cellsX: number;
  readonly cellsY: number;
  readonly grass: Float32Array;
  /** 1 — чанк считается на S0. */
  readonly level: Uint8Array;
  /** Для unified: чанки, где особи воплощены для показа. На расчёт не влияет. */
  readonly embodiedZone: Uint8Array;

  readonly cap = 1 << 17;
  readonly sp = new Uint8Array(this.cap);
  readonly alive = new Uint8Array(this.cap);
  readonly x = new Float32Array(this.cap);
  readonly z = new Float32Array(this.cap);
  readonly age = new Float32Array(this.cap);
  readonly life = new Float32Array(this.cap);
  readonly energy = new Float32Array(this.cap);
  readonly cool = new Float32Array(this.cap);
  readonly uid = new Uint32Array(this.cap);
  readonly chunk = new Int32Array(this.cap);
  /** Сутки рождения: новорождённый не проходит суточные события в день появления. */
  readonly born = new Int32Array(this.cap);
  n = 0;
  private readonly free: number[] = [];
  private nextUid = 1;

  // Когорты: индекс = чанк × 2 + вид.
  readonly cJuv: Int32Array;
  readonly cAdult: Int32Array;
  readonly cEJuv: Float64Array;
  readonly cEAdult: Float64Array;

  // Книга учёта.
  readonly births: [number, number] = [0, 0];
  readonly deaths: [number[], number[]] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  day = 0;
  private clock = 0;

  sampler: ((chunk: number, sample: ChunkSample) => void) | null = null;
  private readonly sample: ChunkSample[];

  private readonly cellHead: Int32Array;
  private readonly cellNext = new Int32Array(this.cap);
  private readonly touched: number[] = [];
  private readonly bucketHead: Int32Array;
  private readonly bucketNext = new Int32Array(this.cap);
  private foxInChunk: Int32Array = new Int32Array(0);

  constructor(
    readonly seed: number,
    nx: number,
    ny: number,
    readonly far: FarMode,
    readonly fp: FarParams | null,
    init: { rabbitsPerChunk: number; foxesPerChunk: number } = { rabbitsPerChunk: 8, foxesPerChunk: 0.4 },
  ) {
    this.nx = nx;
    this.ny = ny;
    this.nChunks = nx * ny;
    this.cellsX = nx * CELLS;
    this.cellsY = ny * CELLS;
    this.grass = new Float32Array(this.cellsX * this.cellsY).fill(GRASS.K * 0.8);
    this.level = new Uint8Array(this.nChunks).fill(1);
    this.embodiedZone = new Uint8Array(this.nChunks);
    this.cJuv = new Int32Array(this.nChunks * 2);
    this.cAdult = new Int32Array(this.nChunks * 2);
    this.cEJuv = new Float64Array(this.nChunks * 2);
    this.cEAdult = new Float64Array(this.nChunks * 2);
    this.cellHead = new Int32Array(this.cellsX * this.cellsY).fill(-1);
    this.bucketHead = new Int32Array(this.nChunks * 2).fill(-1);
    this.sample = Array.from({ length: this.nChunks }, () => emptySample());

    // Начальное заселение: все чанки на S0, особи — индивидуальны.
    const w = nx * CHUNK_M;
    const h = ny * CHUNK_M;
    const place = (species: number, total: number) => {
      const p = SPECIES[species]!;
      for (let k = 0; k < total; k++) {
        const key = species * 1000003 + k;
        const i = this.spawn(species, this.rnd(key, P_SPAWN) * w, this.rnd(key, P_SPAWN + 100) * h, p.matureDays + this.rnd(key, P_SPAWN + 200) * (p.lifespan * 0.5), p.eMax * 0.6);
        this.cool[i] = this.rnd(key, P_SPAWN + 300) * p.cooldown;
      }
    };
    place(RABBIT, Math.round(init.rabbitsPerChunk * this.nChunks));
    place(FOX, Math.round(init.foxesPerChunk * this.nChunks));
  }

  // ───────── служебное ─────────

  private rnd(key: number, purpose: number): number {
    return counterRandom(this.seed, purpose, key, this.clock);
  }

  private stochasticRound(value: number, key: number, purpose: number): number {
    const base = Math.floor(value);
    return base + (this.rnd(key, purpose) < value - base ? 1 : 0);
  }

  chunkAt(x: number, z: number): number {
    let cx = Math.floor(x / CHUNK_M);
    let cz = Math.floor(z / CHUNK_M);
    if (cx < 0) cx = 0;
    else if (cx >= this.nx) cx = this.nx - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.ny) cz = this.ny - 1;
    return cz * this.nx + cx;
  }

  private cellAt(x: number, z: number): number {
    let cx = Math.floor(x / CELL_M);
    let cz = Math.floor(z / CELL_M);
    if (cx < 0) cx = 0;
    else if (cx >= this.cellsX) cx = this.cellsX - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.cellsY) cz = this.cellsY - 1;
    return cz * this.cellsX + cx;
  }

  private spawn(species: number, x: number, z: number, age: number, energy: number): number {
    const i = this.free.length > 0 ? this.free.pop()! : this.n++;
    if (i >= this.cap) throw new Error('Переполнение хранилища особей');
    const p = SPECIES[species]!;
    const id = this.nextUid++;
    this.sp[i] = species;
    this.alive[i] = 1;
    this.x[i] = x;
    this.z[i] = z;
    this.age[i] = age;
    this.life[i] = p.lifespan * (0.8 + 0.4 * counterRandom(this.seed, P_LIFE + 50, id, 0));
    this.energy[i] = energy;
    this.cool[i] = 0;
    this.uid[i] = id;
    this.chunk[i] = this.chunkAt(x, z);
    this.born[i] = -1;
    return i;
  }

  private remove(i: number): void {
    this.alive[i] = 0;
    this.free.push(i);
  }

  /** Смерть с записью причины — единственный путь убыли, кроме свёртывания в когорту. */
  private kill(i: number, cause: number): void {
    this.deaths[this.sp[i]!]![cause]!++;
    if (this.level[this.chunk[i]!] === 1) {
      if (cause === STARVE) this.sample[this.chunk[i]!]!.starved[this.sp[i]!]!++;
      else if (cause === OLD_AGE) this.sample[this.chunk[i]!]!.oldAge[this.sp[i]!]!++;
    }
    this.remove(i);
  }

  private randomPointIn(c: number, key: number): [number, number] {
    const cx = c % this.nx;
    const cz = Math.floor(c / this.nx);
    return [(cx + this.rnd(key, P_PLACE)) * CHUNK_M, (cz + this.rnd(key, P_PLACE + 1)) * CHUNK_M];
  }

  private neighbour(c: number, key: number): number {
    const cx = c % this.nx;
    const cz = Math.floor(c / this.nx);
    const dir = Math.floor(this.rnd(key, P_FAR + 7) * 4);
    const tx = cx + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
    const tz = cz + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
    if (tx < 0 || tx >= this.nx || tz < 0 || tz >= this.ny) return c;
    return tz * this.nx + tx;
  }

  // ───────── учёт ─────────

  count(species: number): number {
    let total = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i] === 1 && this.sp[i] === species) total++;
    for (let c = 0; c < this.nChunks; c++) total += this.cJuv[c * 2 + species]! + this.cAdult[c * 2 + species]!;
    return total;
  }

  /** Численность по чанкам (особи + когорты). */
  countByChunk(species: number): Int32Array {
    const out = new Int32Array(this.nChunks);
    for (let i = 0; i < this.n; i++) if (this.alive[i] === 1 && this.sp[i] === species) out[this.chunk[i]!]!++;
    for (let c = 0; c < this.nChunks; c++) out[c]! += this.cJuv[c * 2 + species]! + this.cAdult[c * 2 + species]!;
    return out;
  }

  totalEnergy(species: number): number {
    let total = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i] === 1 && this.sp[i] === species) total += this.energy[i]!;
    for (let c = 0; c < this.nChunks; c++) total += this.cEJuv[c * 2 + species]! + this.cEAdult[c * 2 + species]!;
    return total;
  }

  embodied(species: number): number {
    let total = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i] === 1 && this.sp[i] === species) total++;
    return total;
  }

  /** Хеш авторитетного состояния: трава, особи, когорты, книга учёта. */
  stateHash(): string {
    const h = new StateHasher().addInt(this.day).addInt(this.n).addArray(this.grass);
    h.addArray(this.alive, this.n).addArray(this.sp, this.n).addArray(this.x, this.n).addArray(this.z, this.n);
    h.addArray(this.age, this.n).addArray(this.energy, this.n).addArray(this.chunk, this.n);
    h.addArray(this.cJuv).addArray(this.cAdult);
    for (const species of [RABBIT, FOX]) {
      h.addInt(this.births[species]!);
      for (const d of this.deaths[species]!) h.addInt(d);
    }
    return h.digest();
  }

  grassMean(): number {
    let sum = 0;
    for (let i = 0; i < this.grass.length; i++) sum += this.grass[i]!;
    return sum / this.grass.length;
  }

  // ───────── смена уровня ─────────

  /** Задаёт множество чанков S0; остальные переводятся на дальний уровень. */
  setFocus(focus: (chunk: number) => boolean): void {
    if (this.far === 'unified') {
      for (let c = 0; c < this.nChunks; c++) this.embodiedZone[c] = focus(c) ? 1 : 0;
      return;
    }
    for (let c = 0; c < this.nChunks; c++) {
      const want = focus(c) ? 1 : 0;
      if (want === this.level[c]) continue;
      if (want === 1) this.promote(c);
      else this.demote(c);
    }
  }

  private promote(c: number): void {
    this.level[c] = 1;
    if (this.far === 'coarse') return;
    if (this.far === 'meanfield') {
      // Особи сохранились; на дальнем уровне у них не было координат — раздаём.
      for (let i = 0; i < this.n; i++) {
        if (this.alive[i] !== 1 || this.chunk[i] !== c) continue;
        const [x, z] = this.randomPointIn(c, this.uid[i]!);
        this.x[i] = x;
        this.z[i] = z;
      }
      return;
    }
    for (let species = 0; species < 2; species++) {
      const k = c * 2 + species;
      const p = SPECIES[species]!;
      const juv = this.cJuv[k]!;
      const adult = this.cAdult[k]!;
      const eJuv = juv > 0 ? this.cEJuv[k]! / juv : 0;
      const eAdult = adult > 0 ? this.cEAdult[k]! / adult : 0;
      for (let j = 0; j < juv + adult; j++) {
        const key = this.nextUid;
        const [x, z] = this.randomPointIn(c, key);
        const isJuv = j < juv;
        const u = this.rnd(key, P_PLACE + 2);
        const age = isJuv ? u * p.matureDays : p.matureDays + u * (p.lifespan * 0.8 - p.matureDays);
        const i = this.spawn(species, x, z, age, isJuv ? eJuv : eAdult);
        this.cool[i] = this.rnd(key, P_PLACE + 3) * p.cooldown;
      }
      this.cJuv[k] = 0;
      this.cAdult[k] = 0;
      this.cEJuv[k] = 0;
      this.cEAdult[k] = 0;
    }
  }

  private demote(c: number): void {
    this.level[c] = 0;
    if (this.far !== 'cohort') return;
    for (let i = 0; i < this.n; i++) {
      if (this.alive[i] === 1 && this.chunk[i] === c) this.fold(i, c);
    }
  }

  /** Свёртывание особи в когорту чанка: не смерть, счётчик и энергия переносятся. */
  private fold(i: number, c: number): void {
    const species = this.sp[i]!;
    const k = c * 2 + species;
    if (this.age[i]! >= SPECIES[species]!.matureDays) {
      this.cAdult[k]!++;
      this.cEAdult[k]! += this.energy[i]!;
    } else {
      this.cJuv[k]!++;
      this.cEJuv[k]! += this.energy[i]!;
    }
    this.remove(i);
  }

  // ───────── общая биология ─────────

  /** Суточные события жизни особи. Один и тот же код для S0 и для meanfield. */
  private dailyLife(i: number): void {
    const species = this.sp[i]!;
    const p = SPECIES[species]!;
    const id = this.uid[i]!;
    this.age[i]! += 1;
    if (this.age[i]! > this.life[i]!) return this.kill(i, OLD_AGE);
    if (this.rnd(id, P_LIFE) < p.baseMortality) return this.kill(i, BASE);
    this.cool[i]! -= 1;
    if ((id & 1) === 1 && this.age[i]! >= p.matureDays && this.energy[i]! >= p.reproThreshold && this.cool[i]! <= 0) {
      const c = this.chunk[i]!;
      if (species === FOX) {
        if (this.foxInChunk[c]! >= FOX_TERRITORY_CAP) return;
        this.foxInChunk[c]! += p.litter;
      }
      this.energy[i]! -= p.reproCost;
      this.cool[i] = p.cooldown;
      if (this.level[c] === 1) this.sample[c]!.litters[species]!++;
      for (let k = 0; k < p.litter; k++) {
        const child = this.spawn(species, this.x[i]!, this.z[i]!, 0, p.birthEnergy);
        this.chunk[child] = c;
        this.born[child] = this.day;
        this.births[species]!++;
      }
    }
  }

  // ───────── сутки ─────────

  stepDay(): void {
    this.clock++;
    this.beginSamples();
    this.foxInChunk = this.countByChunk(FOX);
    this.farUpdate();
    for (let hour = 0; hour < HOURS; hour++) {
      this.clock++;
      this.spatialHour();
    }
    this.clock++;
    this.foxInChunk = this.countByChunk(FOX);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      if (this.alive[i] === 1 && this.born[i] !== this.day && this.level[this.chunk[i]!] === 1) this.dailyLife(i);
    }
    this.growGrass();
    this.endSamples();
    this.day++;
  }

  private growGrass(): void {
    const g = this.grass;
    const { K, r, floor } = GRASS;
    for (let i = 0; i < g.length; i++) {
      const v = g[i]!;
      const next = v + r * v * (1 - v / K);
      g[i] = next < floor ? floor : next;
    }
  }

  private chunkGrass(c: number): { sum: number; avail: number } {
    const cx0 = (c % this.nx) * CELLS;
    const cz0 = Math.floor(c / this.nx) * CELLS;
    let sum = 0;
    let avail = 0;
    for (let dz = 0; dz < CELLS; dz++) {
      const row = (cz0 + dz) * this.cellsX + cx0;
      for (let dx = 0; dx < CELLS; dx++) {
        const v = this.grass[row + dx]!;
        sum += v;
        if (v > GRASS.floor) avail += v - GRASS.floor;
      }
    }
    return { sum, avail };
  }

  private grazeChunk(c: number, fraction: number): void {
    const cx0 = (c % this.nx) * CELLS;
    const cz0 = Math.floor(c / this.nx) * CELLS;
    for (let dz = 0; dz < CELLS; dz++) {
      const row = (cz0 + dz) * this.cellsX + cx0;
      for (let dx = 0; dx < CELLS; dx++) {
        const v = this.grass[row + dx]!;
        if (v > GRASS.floor) this.grass[row + dx] = v - (v - GRASS.floor) * fraction;
      }
    }
  }

  // ───────── S0: пространственный час ─────────

  private spatialHour(): void {
    const rabbit = SPECIES[RABBIT]!;
    const fox = SPECIES[FOX]!;
    const n = this.n;
    const maxX = this.cellsX * CELL_M - 0.01;
    const maxZ = this.cellsY * CELL_M - 0.01;

    // 1. Кролики: едят из своей ячейки, смещаются к более богатой.
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1 || this.sp[i] !== RABBIT) continue;
      const c = this.chunk[i]!;
      if (this.level[c] !== 1) continue;
      const id = this.uid[i]!;
      const cell = this.cellAt(this.x[i]!, this.z[i]!);
      let desired = (rabbit.eMax - this.energy[i]!) / rabbit.conv;
      if (desired > rabbit.intakeMax * DT) desired = rabbit.intakeMax * DT;
      if (desired < 0) desired = 0;
      const avail = this.grass[cell]! - GRASS.floor;
      const got = avail <= 0 ? 0 : desired < avail ? desired : avail;
      this.grass[cell]! -= got;
      this.energy[i]! += got * rabbit.conv - rabbit.metabolism * DT;
      const s = this.sample[c]!;
      s.desired += desired;
      s.got += got;
      if (this.energy[i]! <= 0) {
        this.kill(i, STARVE);
        continue;
      }
      const poor = this.grass[cell]! < GRASS.K * 0.3;
      if (poor || this.rnd(id, P_MOVE) < 0.2) {
        const cxCell = cell % this.cellsX;
        const czCell = Math.floor(cell / this.cellsX);
        let bestX = cxCell;
        let bestZ = czCell;
        if (poor) {
          let best = -1;
          for (let k = 0; k < 8; k++) {
            const nxCell = cxCell + DX8[k]!;
            const nzCell = czCell + DZ8[k]!;
            if (nxCell < 0 || nxCell >= this.cellsX || nzCell < 0 || nzCell >= this.cellsY) continue;
            const score = this.grass[nzCell * this.cellsX + nxCell]! + this.rnd(id * 8 + k, P_MOVE + 1) * 0.05;
            if (score > best) {
              best = score;
              bestX = nxCell;
              bestZ = nzCell;
            }
          }
        } else {
          const k = Math.floor(this.rnd(id, P_MOVE + 2) * 8);
          const nxCell = cxCell + DX8[k]!;
          const nzCell = czCell + DZ8[k]!;
          if (nxCell >= 0 && nxCell < this.cellsX && nzCell >= 0 && nzCell < this.cellsY) {
            bestX = nxCell;
            bestZ = nzCell;
          }
        }
        this.x[i] = (bestX + 0.5) * CELL_M;
        this.z[i] = (bestZ + 0.5) * CELL_M;
        this.relocate(i, c);
      }
    }

    // 2. Списки кроликов по ячейкам — для поиска добычи.
    for (const cell of this.touched) this.cellHead[cell] = -1;
    this.touched.length = 0;
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1 || this.sp[i] !== RABBIT || this.level[this.chunk[i]!] !== 1) continue;
      const cell = this.cellAt(this.x[i]!, this.z[i]!);
      if (this.cellHead[cell] === -1) this.touched.push(cell);
      this.cellNext[i] = this.cellHead[cell]!;
      this.cellHead[cell] = i;
    }

    // 3. Лисы: голодная ищет ближайшего кролика в радиусе чутья.
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1 || this.sp[i] !== FOX) continue;
      const c = this.chunk[i]!;
      if (this.level[c] !== 1) continue;
      const id = this.uid[i]!;
      let fx = this.x[i]!;
      let fz = this.z[i]!;
      let moved = false;
      if (this.energy[i]! < fox.hungryFrac * fox.eMax) {
        this.sample[c]!.hungryFoxDays += DT;
        const prey = this.nearestRabbit(fx, fz, SENSE_CELLS);
        if (prey >= 0) {
          const dx = this.x[prey]! - fx;
          const dz = this.z[prey]! - fz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= FOX_RUN) {
            fx = this.x[prey]!;
            fz = this.z[prey]!;
            if (this.rnd(id, P_CATCH) < CATCH_CHANCE) {
              this.sample[this.chunk[prey]!]!.kills++;
              this.kill(prey, PREDATION);
              this.energy[i] = Math.min(fox.eMax, this.energy[i]! + fox.conv);
            }
          } else {
            fx += (dx / dist) * FOX_RUN;
            fz += (dz / dist) * FOX_RUN;
          }
          moved = true;
        }
      }
      if (!moved) {
        const angle = this.rnd(id, P_MOVE + 3) * Math.PI * 2;
        fx += Math.cos(angle) * FOX_WANDER;
        fz += Math.sin(angle) * FOX_WANDER;
      }
      this.x[i] = fx < 0 ? 0 : fx > maxX ? maxX : fx;
      this.z[i] = fz < 0 ? 0 : fz > maxZ ? maxZ : fz;
      this.energy[i]! -= fox.metabolism * DT;
      if (this.energy[i]! <= 0) {
        this.kill(i, STARVE);
        continue;
      }
      this.relocate(i, c);
    }
  }

  /** После перемещения: обновить чанк; при выходе в дальний чанк — уйти с S0. */
  private relocate(i: number, from: number): void {
    const to = this.chunkAt(this.x[i]!, this.z[i]!);
    if (to === from) return;
    this.chunk[i] = to;
    this.sample[from]!.crossed[this.sp[i]!]!++;
    if (this.level[to] !== 1 && this.far === 'cohort') this.fold(i, to);
  }

  private nearestRabbit(x: number, z: number, radius: number): number {
    const cx = Math.floor(x / CELL_M);
    const cz = Math.floor(z / CELL_M);
    let best = -1;
    let bestD = Infinity;
    for (let dz = -radius; dz <= radius; dz++) {
      const zz = cz + dz;
      if (zz < 0 || zz >= this.cellsY) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= this.cellsX) continue;
        if (this.grass[zz * this.cellsX + xx]! >= COVER) continue;
        let j = this.cellHead[zz * this.cellsX + xx]!;
        while (j >= 0) {
          if (this.alive[j] === 1) {
            const ddx = this.x[j]! - x;
            const ddz = this.z[j]! - z;
            const d = ddx * ddx + ddz * ddz;
            if (d < bestD) {
              bestD = d;
              best = j;
            }
          }
          j = this.cellNext[j]!;
        }
      }
    }
    return best;
  }

  // ───────── дальний уровень ─────────

  private farUpdate(): void {
    let anyFar = false;
    for (let c = 0; c < this.nChunks; c++) {
      if (this.level[c] !== 1) {
        anyFar = true;
        break;
      }
    }
    if (!anyFar) return;
    if (!this.fp) throw new Error('Для дальнего уровня нужны калиброванные параметры');
    if (this.far === 'meanfield') this.farMeanfield(this.fp);
    else if (this.far === 'coarse') this.farCoarse(this.fp);
    else this.farCohort(this.fp);
  }

  /** Особи сохраняются; обновление «в среднем по чанку» раз в сутки. */
  private farMeanfield(fp: FarParams): void {
    const rabbit = SPECIES[RABBIT]!;
    const fox = SPECIES[FOX]!;
    this.bucketHead.fill(-1);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1) continue;
      const c = this.chunk[i]!;
      if (this.level[c] === 1) continue;
      const k = c * 2 + this.sp[i]!;
      this.bucketNext[i] = this.bucketHead[k]!;
      this.bucketHead[k] = i;
    }
    const prey: number[] = [];
    for (let c = 0; c < this.nChunks; c++) {
      if (this.level[c] === 1) continue;
      const { sum, avail } = this.chunkGrass(c);
      const grassMean = sum / (CELLS * CELLS);
      const access = fp.intake.at(grassMean);

      // Кролики: потребление по таблице, ограниченное доступной травой чанка.
      let demand = 0;
      prey.length = 0;
      for (let i = this.bucketHead[c * 2 + RABBIT]!; i >= 0; i = this.bucketNext[i]!) {
        prey.push(i);
        let desired = (rabbit.eMax - this.energy[i]! + rabbit.metabolism) / rabbit.conv;
        if (desired > rabbit.intakeMax) desired = rabbit.intakeMax;
        if (desired > 0) demand += desired * access;
      }
      const scale = demand > avail && demand > 0 ? avail / demand : 1;
      for (const i of prey) {
        let desired = (rabbit.eMax - this.energy[i]! + rabbit.metabolism) / rabbit.conv;
        if (desired > rabbit.intakeMax) desired = rabbit.intakeMax;
        if (desired < 0) desired = 0;
        this.energy[i] = Math.min(rabbit.eMax + rabbit.metabolism, this.energy[i]! + desired * access * scale * rabbit.conv);
      }
      if (avail > 0 && demand > 0) this.grazeChunk(c, Math.min(1, (demand * scale) / avail));

      // Лисы: число добыч по таблице от текущего числа кроликов в чанке.
      for (let i = this.bucketHead[c * 2 + FOX]!; i >= 0; i = this.bucketNext[i]!) {
        // Охота как пуассоновский процесс внутри суток: таблица даёт интенсивность добыч
        // на «голодные сутки», после каждой добычи голод проверяется заново — как на S0.
        let t = 0;
        for (let k = 0; k < 8 && prey.length > 0 && this.energy[i]! < fox.hungryFrac * fox.eMax; k++) {
          const rate = fp.kill.at(prey.length, grassMean);
          if (rate <= 0) break;
          t += -Math.log(1 - this.rnd(this.uid[i]! * 8 + k, P_FAR)) / rate;
          if (t >= 1) break;
          const pick = Math.floor(this.rnd(this.uid[i]! * 8 + k, P_FAR + 1) * prey.length);
          this.kill(prey[pick]!, PREDATION);
          prey[pick] = prey[prey.length - 1]!;
          prey.pop();
          this.energy[i] = Math.min(fox.eMax, this.energy[i]! + fox.conv);
        }
      }

      // Обмен веществ, события жизни, расселение — по особям.
      for (let species = 0; species < 2; species++) {
        const p = SPECIES[species]!;
        let i = this.bucketHead[c * 2 + species]!;
        while (i >= 0) {
          const next = this.bucketNext[i]!;
          if (this.alive[i] === 1) {
            this.energy[i]! -= p.metabolism;
            if (this.energy[i]! <= 0) this.kill(i, STARVE);
            else {
              this.dailyLife(i);
              if (this.alive[i] === 1 && this.rnd(this.uid[i]!, P_FAR + 2) < fp.disperse[species]!) {
                const to = this.neighbour(c, this.uid[i]!);
                if (to !== c) {
                  this.chunk[i] = to;
                  if (this.level[to] === 1) {
                    const [x, z] = this.randomPointIn(to, this.uid[i]!);
                    this.x[i] = x;
                    this.z[i] = z;
                  }
                }
              }
            }
          }
          i = next;
        }
      }
    }
  }

  /**
   * Особи сохраняются вместе с положением. Шаг — сутки вместо часа, но ресурсы берутся
   * из конкретных ячеек, а укрытие проверяется по ячейке кролика. Усредняется только поиск добычи.
   */
  private farCoarse(fp: FarParams): void {
    const rabbit = SPECIES[RABBIT]!;
    const fox = SPECIES[FOX]!;
    const maxX = this.cellsX * CELL_M - 0.01;
    const maxZ = this.cellsY * CELL_M - 0.01;
    this.bucketHead.fill(-1);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1) continue;
      const c = this.chunk[i]!;
      if (this.level[c] === 1) continue;
      const k = c * 2 + this.sp[i]!;
      this.bucketNext[i] = this.bucketHead[k]!;
      this.bucketHead[k] = i;
    }
    const exposed: number[] = [];
    for (let c = 0; c < this.nChunks; c++) {
      if (this.level[c] === 1) continue;

      // Кто вне укрытия на начало суток — так же определена таблица добычи.
      exposed.length = 0;
      for (let i = this.bucketHead[c * 2 + RABBIT]!; i >= 0; i = this.bucketNext[i]!) {
        if (this.grass[this.cellAt(this.x[i]!, this.z[i]!)]! < COVER) exposed.push(i);
      }

      // Лисы: охота как пуассоновский процесс внутри суток.
      for (let i = this.bucketHead[c * 2 + FOX]!; i >= 0; i = this.bucketNext[i]!) {
        const id = this.uid[i]!;
        let t = 0;
        let hunted = false;
        for (let k = 0; k < 8 && exposed.length > 0 && this.energy[i]! < fox.hungryFrac * fox.eMax; k++) {
          const rate = fp.killExposed.at(exposed.length);
          if (rate <= 0) break;
          t += -Math.log(1 - this.rnd(id * 8 + k, P_FAR)) / rate;
          if (t >= 1) break;
          const pick = Math.floor(this.rnd(id * 8 + k, P_FAR + 1) * exposed.length);
          const prey = exposed[pick]!;
          this.x[i] = this.x[prey]!;
          this.z[i] = this.z[prey]!;
          hunted = true;
          this.kill(prey, PREDATION);
          exposed[pick] = exposed[exposed.length - 1]!;
          exposed.pop();
          this.energy[i] = Math.min(fox.eMax, this.energy[i]! + fox.conv);
        }
        if (!hunted) {
          // Суточное блуждание: 24 часовых шага по FOX_WANDER дают смещение порядка FOX_WANDER·√24.
          const angle = this.rnd(id, P_MOVE + 3) * Math.PI * 2;
          const reach = FOX_WANDER * Math.sqrt(HOURS) * Math.sqrt(-Math.log(1 - this.rnd(id, P_MOVE + 4)));
          const fx = this.x[i]! + Math.cos(angle) * reach;
          const fz = this.z[i]! + Math.sin(angle) * reach;
          this.x[i] = fx < 0 ? 0 : fx > maxX ? maxX : fx;
          this.z[i] = fz < 0 ? 0 : fz > maxZ ? maxZ : fz;
        }
      }

      // Кролики: едят из своей ячейки, при нехватке переходят в лучшую соседнюю (до 4 переходов).
      for (let i = this.bucketHead[c * 2 + RABBIT]!; i >= 0; i = this.bucketNext[i]!) {
        if (this.alive[i] !== 1) continue;
        const id = this.uid[i]!;
        let desired = (rabbit.eMax - this.energy[i]! + rabbit.metabolism) / rabbit.conv;
        if (desired > rabbit.intakeMax) desired = rabbit.intakeMax;
        let cell = this.cellAt(this.x[i]!, this.z[i]!);
        for (let hop = 0; hop < 5; hop++) {
          const avail = this.grass[cell]! - GRASS.floor;
          const got = avail <= 0 ? 0 : desired < avail ? desired : avail;
          if (got > 0) {
            this.grass[cell]! -= got;
            this.energy[i]! += got * rabbit.conv;
            desired -= got;
          }
          const poor = this.grass[cell]! < GRASS.K * 0.3;
          if (!poor && (desired <= 1e-6 || hop > 0)) break;
          if (!poor && this.rnd(id, P_MOVE) >= 0.8) break;
          const cx = cell % this.cellsX;
          const cz = Math.floor(cell / this.cellsX);
          let best = -1;
          let bestCell = cell;
          for (let k = 0; k < 8; k++) {
            const nxCell = cx + DX8[k]!;
            const nzCell = cz + DZ8[k]!;
            if (nxCell < 0 || nxCell >= this.cellsX || nzCell < 0 || nzCell >= this.cellsY) continue;
            const score = (poor ? this.grass[nzCell * this.cellsX + nxCell]! : 0) + this.rnd(id * 64 + hop * 8 + k, P_MOVE + 1) * (poor ? 0.05 : 1);
            if (score > best) {
              best = score;
              bestCell = nzCell * this.cellsX + nxCell;
            }
          }
          cell = bestCell;
          if (desired <= 1e-6) break;
        }
        this.x[i] = ((cell % this.cellsX) + 0.5) * CELL_M;
        this.z[i] = (Math.floor(cell / this.cellsX) + 0.5) * CELL_M;
      }

      // Обмен веществ, события жизни, смена чанка по фактическому положению.
      for (let species = 0; species < 2; species++) {
        const p = SPECIES[species]!;
        let i = this.bucketHead[c * 2 + species]!;
        while (i >= 0) {
          const next = this.bucketNext[i]!;
          if (this.alive[i] === 1) {
            this.energy[i]! -= p.metabolism;
            if (this.energy[i]! <= 0) this.kill(i, STARVE);
            else {
              this.dailyLife(i);
              if (this.alive[i] === 1) this.chunk[i] = this.chunkAt(this.x[i]!, this.z[i]!);
            }
          }
          i = next;
        }
      }
    }
  }

  /** Особи свёрнуты в счётчики; всё, что зависит от распределения энергии, идёт через таблицы-замыкания. */
  private farCohort(fp: FarParams): void {
    const rabbit = SPECIES[RABBIT]!;
    const fox = SPECIES[FOX]!;
    const moves: number[] = [];
    for (let c = 0; c < this.nChunks; c++) {
      if (this.level[c] === 1) continue;
      const kr = c * 2 + RABBIT;
      const kf = c * 2 + FOX;

      // Кролики: потребление.
      const nr = this.cJuv[kr]! + this.cAdult[kr]!;
      const { sum, avail } = this.chunkGrass(c);
      const grassMean = sum / (CELLS * CELLS);
      if (nr > 0) {
        const mean = (this.cEJuv[kr]! + this.cEAdult[kr]!) / nr;
        let eaten = nr * rabbit.intakeMax * fp.desire.at(mean) * fp.intake.at(grassMean);
        if (eaten > avail) eaten = avail;
        if (eaten > 0 && avail > 0) {
          this.grazeChunk(c, eaten / avail);
          this.cEJuv[kr]! += (eaten * rabbit.conv * this.cJuv[kr]!) / nr;
          this.cEAdult[kr]! += (eaten * rabbit.conv * this.cAdult[kr]!) / nr;
        }
      }

      // Лисы: добыча из когорты кроликов того же чанка.
      const nf = this.cJuv[kf]! + this.cAdult[kf]!;
      if (nf > 0 && nr > 0) {
        const mean = (this.cEJuv[kf]! + this.cEAdult[kf]!) / nf;
        let kills = this.stochasticRound(nf * fp.hungry.at(mean) * fp.kill.at(nr, grassMean), c, P_FAR + 10);
        if (kills > nr) kills = nr;
        for (let k = 0; k < kills; k++) {
          const total = this.cJuv[kr]! + this.cAdult[kr]!;
          const fromJuv = this.rnd(c * 64 + k, P_FAR + 11) * total < this.cJuv[kr]!;
          this.takeFromCohort(kr, fromJuv);
          this.deaths[RABBIT]![PREDATION]!++;
        }
        const gain = kills * fox.conv;
        this.cEJuv[kf]! += (gain * this.cJuv[kf]!) / nf;
        this.cEAdult[kf]! += (gain * this.cAdult[kf]!) / nf;
        this.capEnergy(kf, fox.eMax);
      }

      for (let species = 0; species < 2; species++) {
        const p = SPECIES[species]!;
        const k = c * 2 + species;
        let juv = this.cJuv[k]!;
        let adult = this.cAdult[k]!;
        if (juv + adult === 0) continue;
        this.capEnergy(k, p.eMax);
        this.cEJuv[k]! -= p.metabolism * juv;
        this.cEAdult[k]! -= p.metabolism * adult;
        const mean = (this.cEJuv[k]! + this.cEAdult[k]!) / (juv + adult);

        // Голод: умершие были на нуле энергии — счётчик убывает, сумма энергии нет.
        const starveRate = fp.starve[species]!.at(mean);
        const sj = Math.min(juv, this.stochasticRound(juv * starveRate, k, P_FAR + 12));
        const sa = Math.min(adult, this.stochasticRound(adult * starveRate, k, P_FAR + 13));
        this.cJuv[k] = juv -= sj;
        this.cAdult[k] = adult -= sa;
        this.deaths[species]![STARVE]! += sj + sa;
        if (this.cEJuv[k]! < 0 || juv === 0) this.cEJuv[k] = 0;
        if (this.cEAdult[k]! < 0 || adult === 0) this.cEAdult[k] = 0;

        // Случайная смертность и старость.
        const bj = Math.min(juv, this.stochasticRound(juv * p.baseMortality, k, P_FAR + 14));
        for (let q = 0; q < bj; q++) this.takeFromCohort(k, true);
        this.deaths[species]![BASE]! += bj;
        const ba = Math.min(this.cAdult[k]!, this.stochasticRound(this.cAdult[k]! * p.baseMortality, k, P_FAR + 15));
        for (let q = 0; q < ba; q++) this.takeFromCohort(k, false);
        this.deaths[species]![BASE]! += ba;
        const oa = Math.min(this.cAdult[k]!, this.stochasticRound(this.cAdult[k]! * fp.oldAge[species]!, k, P_FAR + 16));
        for (let q = 0; q < oa; q++) this.takeFromCohort(k, false);
        this.deaths[species]![OLD_AGE]! += oa;

        // Взросление.
        const grown = Math.min(this.cJuv[k]!, this.stochasticRound(this.cJuv[k]! / p.matureDays, k, P_FAR + 17));
        if (grown > 0) {
          const e = (this.cEJuv[k]! / this.cJuv[k]!) * grown;
          this.cJuv[k]! -= grown;
          this.cEJuv[k]! -= e;
          this.cAdult[k]! += grown;
          this.cEAdult[k]! += e;
        }

        // Размножение.
        if (this.cAdult[k]! > 0) {
          const adultMean = this.cEAdult[k]! / this.cAdult[k]!;
          let litters = this.stochasticRound(this.cAdult[k]! * fp.repro[species]!.at(adultMean), k, P_FAR + 18);
          if (species === FOX) {
            // То же правило территориальности, что и у особей: выводок появляется, пока лис в чанке меньше предела.
            const room = Math.max(0, Math.ceil((FOX_TERRITORY_CAP - this.foxInChunk[c]!) / p.litter));
            if (litters > room) litters = room;
            this.foxInChunk[c]! += litters * p.litter;
          }
          if (litters > 0) {
            this.cEAdult[k]! -= litters * p.reproCost;
            if (this.cEAdult[k]! < 0) this.cEAdult[k] = 0;
            this.cJuv[k]! += litters * p.litter;
            this.cEJuv[k]! += litters * p.litter * p.birthEnergy;
            this.births[species]! += litters * p.litter;
          }
        }

        // Расселение: применяется после обхода, чтобы порядок чанков не влиял.
        const total = this.cJuv[k]! + this.cAdult[k]!;
        const movers = Math.min(total, this.stochasticRound(total * fp.disperse[species]!, k, P_FAR + 19));
        for (let q = 0; q < movers; q++) {
          const to = this.neighbour(c, k * 131 + q);
          if (to === c) continue;
          const left = this.cJuv[k]! + this.cAdult[k]!;
          if (left === 0) break;
          const fromJuv = this.rnd(k * 131 + q, P_FAR + 20) * left < this.cJuv[k]!;
          const e = this.takeFromCohort(k, fromJuv);
          moves.push(to, species, fromJuv ? 1 : 0, e);
        }
      }
    }
    for (let m = 0; m < moves.length; m += 4) {
      const to = moves[m]!;
      const species = moves[m + 1]!;
      const isJuv = moves[m + 2] === 1;
      const e = moves[m + 3]!;
      const p = SPECIES[species]!;
      if (this.level[to] === 1) {
        const key = this.nextUid;
        const [x, z] = this.randomPointIn(to, key);
        const u = this.rnd(key, P_PLACE + 2);
        this.spawn(species, x, z, isJuv ? u * p.matureDays : p.matureDays + u * (p.lifespan * 0.8 - p.matureDays), e);
      } else {
        const k = to * 2 + species;
        if (isJuv) {
          this.cJuv[k]!++;
          this.cEJuv[k]! += e;
        } else {
          this.cAdult[k]!++;
          this.cEAdult[k]! += e;
        }
      }
    }
  }

  /** Изымает одну особь из стадии когорты вместе с её средней энергией; возвращает эту энергию. */
  private takeFromCohort(k: number, fromJuv: boolean): number {
    if (fromJuv && this.cJuv[k]! > 0) {
      const e = this.cEJuv[k]! / this.cJuv[k]!;
      this.cJuv[k]!--;
      this.cEJuv[k]! -= e;
      return e;
    }
    if (this.cAdult[k]! > 0) {
      const e = this.cEAdult[k]! / this.cAdult[k]!;
      this.cAdult[k]!--;
      this.cEAdult[k]! -= e;
      return e;
    }
    return 0;
  }

  private capEnergy(k: number, eMax: number): void {
    if (this.cEJuv[k]! > this.cJuv[k]! * eMax) this.cEJuv[k] = this.cJuv[k]! * eMax;
    if (this.cEAdult[k]! > this.cAdult[k]! * eMax) this.cEAdult[k] = this.cAdult[k]! * eMax;
  }

  // ───────── выборки для калибровки ─────────

  private beginSamples(): void {
    if (!this.sampler) return;
    for (let c = 0; c < this.nChunks; c++) {
      const s = this.sample[c]!;
      resetSample(s);
      if (this.level[c] === 1) s.grass = this.chunkGrass(c).sum / (CELLS * CELLS);
    }
    for (let i = 0; i < this.n; i++) {
      if (this.alive[i] !== 1) continue;
      const c = this.chunk[i]!;
      if (this.level[c] !== 1) continue;
      const species = this.sp[i]!;
      const s = this.sample[c]!;
      s.n[species]!++;
      if (species === RABBIT && this.grass[this.cellAt(this.x[i]!, this.z[i]!)]! < COVER) s.exposed++;
      s.energy[species]! += this.energy[i]!;
      if (this.age[i]! >= SPECIES[species]!.matureDays) {
        s.adults[species]!++;
        s.adultEnergy[species]! += this.energy[i]!;
      }
    }
  }

  private endSamples(): void {
    if (!this.sampler) return;
    for (let c = 0; c < this.nChunks; c++) if (this.level[c] === 1) this.sampler(c, this.sample[c]!);
  }
}

const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ8 = [0, 1, 1, 1, 0, -1, -1, -1];
const SENSE_CELLS = 1;
const FOX_RUN = 24;
const FOX_WANDER = 16;
const CATCH_CHANCE = 0.25;

function emptySample(): ChunkSample {
  return { grass: 0, exposed: 0, n: [0, 0], adults: [0, 0], energy: [0, 0], adultEnergy: [0, 0], desired: 0, got: 0, hungryFoxDays: 0, kills: 0, starved: [0, 0], oldAge: [0, 0], litters: [0, 0], crossed: [0, 0] };
}

function resetSample(s: ChunkSample): void {
  s.grass = 0;
  s.exposed = 0;
  s.desired = 0;
  s.got = 0;
  s.hungryFoxDays = 0;
  s.kills = 0;
  for (let k = 0; k < 2; k++) {
    s.n[k] = 0;
    s.adults[k] = 0;
    s.energy[k] = 0;
    s.adultEnergy[k] = 0;
    s.starved[k] = 0;
    s.oldAge[k] = 0;
    s.litters[k] = 0;
    s.crossed[k] = 0;
  }
}
