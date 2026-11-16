// Прототип фазы 1: расширенная пищевая сеть на единой модели (один расчёт для всего мира).
// Два продуцента (трава, кустарник), два травоядных (кролик, олень), два хищника (лиса, волк),
// сезоны с северо-южным градиентом, сезонное размножение, миграция оленей, возврат веществ в почву.
// Одноразовый исследовательский код; в проект переносятся выводы.

import { counterRandom } from '../../src/shared/rng';
import { StateHasher } from '../../src/sim/core/hash';

export const CELLS = 16;
export const CELL_M = 8;
export const CHUNK_M = CELLS * CELL_M;
export const HOURS = 24;
export const DAYS_PER_SEASON = 5;
export const DAYS_PER_YEAR = 20;
const DT = 1 / HOURS;

export const RABBIT = 0;
export const DEER = 1;
export const FOX = 2;
export const WOLF = 3;
export const SPECIES_NAMES = ['кролик', 'олень', 'лиса', 'волк'] as const;
export const SEASONS = ['весна', 'лето', 'осень', 'зима'] as const;
export const CAUSES = ['голод', 'хищник', 'старость', 'случайная'] as const;
const STARVE = 0;
const PREDATION = 1;
const OLD_AGE = 2;
const BASE = 3;

interface Prey {
  species: number;
  /** Энергия с одной добычи. */
  energy: number;
  catchChance: number;
  /** Добыча в укрытии (густая трава) не видна. */
  hides: boolean;
}

export interface Spec {
  herbivore: boolean;
  intakeMax: number;
  eatsShrub: boolean;
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
  hungryFrac: number;
  /** Сезоны, в которые возможно размножение: весна, лето, осень, зима. */
  breeds: [boolean, boolean, boolean, boolean];
  /** Территориальность: предел числа особей вида на участке, при котором ещё возможен выводок (0 — нет предела). */
  territoryCap: number;
  /** Сторона участка территории в чанках. */
  territoryBlock: number;
  prey: Prey[];
  senseCells: number;
  run: number;
  wander: number;
  migratory: boolean;
  /** Всеядность: голодный хищник без добычи кормится ягодами кустарника (только поддержание жизни). */
  omnivore: boolean;
  perChunk: number;
}

export const SPECS: Spec[] = [
  // кролик
  { herbivore: true, intakeMax: 1.2, eatsShrub: false, metabolism: 0.6, eMax: 10, birthEnergy: 4, reproThreshold: 8.5, reproCost: 3.5, litter: 2, cooldown: 9, matureDays: 6, lifespan: 60, baseMortality: 0.004, hungryFrac: 1, breeds: [true, true, true, false], territoryCap: 0, territoryBlock: 1, prey: [], senseCells: 0, run: 0, wander: 0, migratory: false, omnivore: false, perChunk: 7 },
  // олень
  { herbivore: true, intakeMax: 2.8, eatsShrub: true, metabolism: 1.3, eMax: 30, birthEnergy: 12, reproThreshold: 26, reproCost: 9, litter: 1, cooldown: 16, matureDays: 20, lifespan: 200, baseMortality: 0.0015, hungryFrac: 1, breeds: [true, false, false, false], territoryCap: 0, territoryBlock: 1, prey: [], senseCells: 0, run: 0, wander: 0, migratory: true, omnivore: false, perChunk: 3 },
  // лиса
  { herbivore: false, intakeMax: 0, eatsShrub: false, metabolism: 0.6, eMax: 12, birthEnergy: 6, reproThreshold: 10, reproCost: 4, litter: 2, cooldown: 25, matureDays: 14, lifespan: 120, baseMortality: 0.002, hungryFrac: 0.75, breeds: [true, true, false, false], territoryCap: 2, territoryBlock: 2, prey: [{ species: RABBIT, energy: 2.5, catchChance: 0.25, hides: true }], senseCells: 1, run: 24, wander: 16, migratory: false, omnivore: true, perChunk: 0.35 },
  // волк
  { herbivore: false, intakeMax: 0, eatsShrub: false, metabolism: 1.0, eMax: 24, birthEnergy: 10, reproThreshold: 19, reproCost: 8, litter: 2, cooldown: 20, matureDays: 20, lifespan: 160, baseMortality: 0.002, hungryFrac: 0.7, breeds: [true, false, false, false], territoryCap: 4, territoryBlock: 4, prey: [{ species: DEER, energy: 13, catchChance: 0.22, hides: true }, { species: RABBIT, energy: 2, catchChance: 0.18, hides: true }], senseCells: 4, run: 60, wander: 34, migratory: true, omnivore: false, perChunk: 0.12 },
];

export const GRASS = { K: 1, r: 0.5, floor: 0.1 };
export const SHRUB = { K: 1.2, r: 0.2, floor: 0.06 };
export const COVER = 0.6;
export const SHRUB_COVER = 0.75;

const P_SPAWN = 31;
const P_MOVE = 32;
const P_CATCH = 33;
const P_LIFE = 34;
const P_MIGRATE = 35;

export interface WebOptions {
  /** Виды, которых в мире нет (для опытов с каскадами). */
  absent?: number[];
  /** Отключить сезоны: вечная весна без градиента. */
  noSeasons?: boolean;
}

export class WebWorld {
  readonly cellsX: number;
  readonly cellsY: number;
  readonly nChunks: number;
  readonly grass: Float32Array;
  readonly shrub: Float32Array;
  /** Плодородие ячейки: 1 — базовое, растёт от останков и помёта, медленно возвращается к 1. */
  readonly nutrient: Float32Array;

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
  readonly born = new Int32Array(this.cap);
  n = 0;
  private readonly free: number[] = [];
  private nextUid = 1;

  // Книга учёта: [вид][сезон] и [вид][причина][сезон].
  readonly births = SPECS.map(() => [0, 0, 0, 0]);
  readonly deaths = SPECS.map(() => CAUSES.map(() => [0, 0, 0, 0]));
  /** Наименьший возраст и энергия родителя в момент выводка — проверка правил размножения. */
  readonly minParentAge = SPECS.map(() => Infinity);
  readonly minParentEnergy = SPECS.map(() => Infinity);
  /** Наименьшая доля прожитого срока среди умерших от старости. */
  readonly minOldAgeFraction = SPECS.map(() => Infinity);
  day = 0;
  private clock = 0;

  private readonly cellHead: Int32Array[];
  private readonly cellNext = new Int32Array(this.cap);
  private readonly touched: number[][] = [[], []];
  private inChunk: Int32Array[] = [];
  /** Число особей вида на участках территории (сторона участка — territoryBlock чанков). */
  private inBlock: Int32Array[] = [];

  constructor(
    readonly seed: number,
    readonly nx: number,
    readonly ny: number,
    readonly options: WebOptions = {},
  ) {
    this.cellsX = nx * CELLS;
    this.cellsY = ny * CELLS;
    this.nChunks = nx * ny;
    const cells = this.cellsX * this.cellsY;
    this.grass = new Float32Array(cells).fill(GRASS.K * 0.8);
    this.shrub = new Float32Array(cells).fill(SHRUB.K * 0.7);
    this.nutrient = new Float32Array(cells).fill(1);
    this.cellHead = [new Int32Array(cells).fill(-1), new Int32Array(cells).fill(-1)];
    const w = this.cellsX * CELL_M;
    const h = this.cellsY * CELL_M;
    SPECS.forEach((spec, species) => {
      if (options.absent?.includes(species)) return;
      const total = Math.round(spec.perChunk * this.nChunks);
      for (let k = 0; k < total; k++) {
        const key = species * 1000003 + k;
        const i = this.spawn(species, this.rnd(key, P_SPAWN) * w, this.rnd(key, P_SPAWN + 1) * h, spec.matureDays + this.rnd(key, P_SPAWN + 2) * spec.lifespan * 0.5, spec.eMax * 0.65);
        this.cool[i] = this.rnd(key, P_SPAWN + 3) * spec.cooldown;
      }
    });
  }

  // ───────── среда ─────────

  get season(): number {
    return this.options.noSeasons ? 0 : Math.floor((this.day % DAYS_PER_YEAR) / DAYS_PER_SEASON);
  }

  /** 0 — северный край, 1 — южный. */
  private south(cell: number): number {
    return Math.floor(cell / this.cellsX) / (this.cellsY - 1);
  }

  /** Сезонный множитель роста растений: летом богаче север, зимой рост почти остановлен. */
  growth(south: number): number {
    if (this.options.noSeasons) return 1;
    switch (this.season) {
      case 0:
        return 1;
      case 1:
        return 1.3 - 0.75 * south;
      case 2:
        return 0.5;
      default:
        return 0.25 * south;
    }
  }

  /** Доступность травы: зимой на севере она под снегом. */
  access(south: number): number {
    return this.season === 3 ? 0.2 + 0.7 * south : 1;
  }

  /** Доступность веток кустарника: зимой на севере они частично под снегом. */
  browse(south: number): number {
    return this.season === 3 ? 0.3 + 0.7 * south : 1;
  }

  /** Куда вид стремится по сезону (доля пути с севера на юг): летом — на богатый север, зимой — на бесснежный юг. */
  private seasonalRange(): number {
    if (this.options.noSeasons) return 0.5;
    return [0.42, 0.28, 0.55, 0.74][this.season]!;
  }

  private metabolismFactor(): number {
    return this.season === 3 ? 1.3 : 1;
  }

  // ───────── служебное ─────────

  private rnd(key: number, purpose: number): number {
    return counterRandom(this.seed, purpose, key, this.clock);
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

  chunkAt(x: number, z: number): number {
    const cx = Math.min(this.nx - 1, Math.max(0, Math.floor(x / CHUNK_M)));
    const cz = Math.min(this.ny - 1, Math.max(0, Math.floor(z / CHUNK_M)));
    return cz * this.nx + cx;
  }

  private blockAt(species: number, x: number, z: number): number {
    const b = SPECS[species]!.territoryBlock;
    const cx = Math.min(this.nx - 1, Math.max(0, Math.floor(x / CHUNK_M)));
    const cz = Math.min(this.ny - 1, Math.max(0, Math.floor(z / CHUNK_M)));
    return Math.floor(cz / b) * this.nx + Math.floor(cx / b);
  }

  private spawn(species: number, x: number, z: number, age: number, energy: number): number {
    const i = this.free.length > 0 ? this.free.pop()! : this.n++;
    if (i >= this.cap) throw new Error('Переполнение хранилища особей');
    const id = this.nextUid++;
    this.sp[i] = species;
    this.alive[i] = 1;
    this.x[i] = x;
    this.z[i] = z;
    this.age[i] = age;
    this.life[i] = SPECS[species]!.lifespan * (0.8 + 0.4 * counterRandom(this.seed, P_LIFE + 50, id, 0));
    this.energy[i] = energy;
    this.cool[i] = 0;
    this.uid[i] = id;
    this.born[i] = -1;
    return i;
  }

  /** Смерть: запись причины и сезона, останки возвращают вещества в почву ячейки. */
  private kill(i: number, cause: number): void {
    const species = this.sp[i]!;
    this.deaths[species]![cause]![this.season]!++;
    if (cause === OLD_AGE) this.minOldAgeFraction[species] = Math.min(this.minOldAgeFraction[species]!, this.age[i]! / SPECS[species]!.lifespan);
    const cell = this.cellAt(this.x[i]!, this.z[i]!);
    this.nutrient[cell] = Math.min(2, this.nutrient[cell]! + (species === DEER || species === WOLF ? 0.5 : 0.15));
    this.alive[i] = 0;
    this.free.push(i);
  }

  // ───────── учёт ─────────

  count(species: number): number {
    let total = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i] === 1 && this.sp[i] === species) total++;
    return total;
  }

  /** Среднее положение вида по оси север — юг, м от северного края. */
  meanZ(species: number): number {
    let sum = 0;
    let total = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.alive[i] === 1 && this.sp[i] === species) {
        sum += this.z[i]!;
        total++;
      }
    }
    return total > 0 ? sum / total : NaN;
  }

  fieldMean(field: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < field.length; i++) sum += field[i]!;
    return sum / field.length;
  }

  totalBirths(species: number): number {
    return this.births[species]!.reduce((a, b) => a + b, 0);
  }

  totalDeaths(species: number): number {
    return this.deaths[species]!.reduce((a, cause) => a + cause.reduce((x, y) => x + y, 0), 0);
  }

  stateHash(): string {
    const h = new StateHasher().addInt(this.day).addInt(this.n).addArray(this.grass).addArray(this.shrub).addArray(this.nutrient);
    h.addArray(this.alive, this.n).addArray(this.sp, this.n).addArray(this.x, this.n).addArray(this.z, this.n).addArray(this.age, this.n).addArray(this.energy, this.n);
    return h.digest();
  }

  // ───────── сутки ─────────

  stepDay(): void {
    this.clock++;
    this.inChunk = SPECS.map((_s, species) => {
      const counts = new Int32Array(this.nChunks);
      for (let i = 0; i < this.n; i++) if (this.alive[i] === 1 && this.sp[i] === species) counts[this.chunkAt(this.x[i]!, this.z[i]!)]!++;
      return counts;
    });
    this.inBlock = SPECS.map((spec, species) => {
      const counts = new Int32Array(this.nChunks);
      if (spec.territoryCap === 0) return counts;
      for (let i = 0; i < this.n; i++) if (this.alive[i] === 1 && this.sp[i] === species) counts[this.blockAt(species, this.x[i]!, this.z[i]!)]!++;
      return counts;
    });
    this.migrate();
    for (let hour = 0; hour < HOURS; hour++) {
      this.clock++;
      this.hour();
    }
    this.clock++;
    const n = this.n;
    for (let i = 0; i < n; i++) if (this.alive[i] === 1 && this.born[i] !== this.day) this.dailyLife(i);
    this.growPlants();
    this.day++;
  }

  private growPlants(): void {
    for (let c = 0; c < this.grass.length; c++) {
      const g = this.growth(this.south(c));
      const fertility = 0.6 + 0.4 * this.nutrient[c]!;
      const grass = this.grass[c]!;
      const next = grass + GRASS.r * g * grass * (1 - grass / (GRASS.K * fertility));
      this.grass[c] = next < GRASS.floor ? GRASS.floor : next;
      const shrub = this.shrub[c]!;
      const nextShrub = shrub + SHRUB.r * g * shrub * (1 - shrub / (SHRUB.K * fertility));
      this.shrub[c] = nextShrub < SHRUB.floor ? SHRUB.floor : nextShrub;
      this.nutrient[c] = 1 + (this.nutrient[c]! - 1) * 0.985;
    }
  }

  /** Кормовая ценность места для оленя: доступная трава и кустарник в окне 5×5 ячеек. */
  private forage(x: number, z: number): number {
    const cx = Math.floor(x / CELL_M);
    const cz = Math.floor(z / CELL_M);
    let sum = 0;
    let cells = 0;
    for (let dz = -2; dz <= 2; dz++) {
      const zz = cz + dz;
      if (zz < 0 || zz >= this.cellsY) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= this.cellsX) continue;
        const c = zz * this.cellsX + xx;
        const south = this.south(c);
        sum += Math.max(0, this.grass[c]! - GRASS.floor) * this.access(south) + 0.6 * Math.max(0, this.shrub[c]! - SHRUB.floor) * this.browse(south);
        cells++;
      }
    }
    return cells > 0 ? sum / cells : 0;
  }

  /** Суточная миграция: кочующий вид смещается к северу или югу, если там заметно лучше. */
  private migrate(): void {
    const maxZ = this.cellsY * CELL_M - 0.01;
    for (let i = 0; i < this.n; i++) {
      if (this.alive[i] !== 1 || !SPECS[this.sp[i]!]!.migratory) continue;
      const species = this.sp[i]!;
      const x = this.x[i]!;
      const z = this.z[i]!;
      let score: (zz: number) => number;
      if (species === DEER) score = (zz) => this.forage(x, zz);
      else score = (zz) => this.inChunk[DEER]![this.chunkAt(x, zz)]!;
      // Врождённое сезонное стремление: градиент условий слишком плавный, чтобы найти его на ощупь.
      const pull = this.seasonalRange() - z / maxZ;
      if (species === DEER && Math.abs(pull) > 0.07 && this.rnd(this.uid[i]!, P_MIGRATE + 1) < 0.8) {
        const step = (45 + this.rnd(this.uid[i]!, P_MIGRATE) * 45) * Math.sign(pull);
        this.z[i] = Math.min(maxZ, Math.max(0, z + step));
        continue;
      }
      const here = score(z);
      const north = z > 96 ? score(z - 96) : -1;
      const south = z < maxZ - 96 ? score(z + 96) : -1;
      const best = Math.max(north, south);
      if (best > here * 1.2 + 0.01) {
        const step = (48 + this.rnd(this.uid[i]!, P_MIGRATE) * 32) * (south >= north ? 1 : -1);
        this.z[i] = Math.min(maxZ, Math.max(0, z + step));
      }
    }
  }

  private hour(): void {
    const n = this.n;
    const maxX = this.cellsX * CELL_M - 0.01;
    const maxZ = this.cellsY * CELL_M - 0.01;
    const cost = this.metabolismFactor();

    // 1. Травоядные: едят из своей ячейки, переходят в лучшую соседнюю.
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1) continue;
      const species = this.sp[i]!;
      const spec = SPECS[species]!;
      if (!spec.herbivore) continue;
      const id = this.uid[i]!;
      const cell = this.cellAt(this.x[i]!, this.z[i]!);
      const access = this.access(this.south(cell));
      let desired = Math.min(spec.intakeMax * DT, spec.eMax - this.energy[i]!);
      if (desired < 0) desired = 0;
      // Олень — веткоед: сначала кустарник, затем трава. Кролик ест только траву.
      let got = 0;
      if (spec.eatsShrub) {
        got = Math.min(desired, Math.max(0, this.shrub[cell]! - SHRUB.floor) * this.browse(this.south(cell)));
        this.shrub[cell]! -= got;
      }
      if (got < desired) {
        const graze = Math.min(desired - got, Math.max(0, this.grass[cell]! - GRASS.floor) * access);
        this.grass[cell]! -= graze;
        got += graze;
      }
      this.energy[i]! += got - spec.metabolism * cost * DT;
      if (this.energy[i]! <= 0) {
        this.kill(i, STARVE);
        continue;
      }
      const value = (c: number) => Math.max(0, this.grass[c]! - GRASS.floor) * this.access(this.south(c)) + (spec.eatsShrub ? 0.6 * Math.max(0, this.shrub[c]! - SHRUB.floor) * this.browse(this.south(c)) : 0);
      const poor = value(cell) < 0.2;
      if (poor || this.rnd(id, P_MOVE) < 0.2) {
        const cx = cell % this.cellsX;
        const cz = Math.floor(cell / this.cellsX);
        let bx = cx;
        let bz = cz;
        let best = -1;
        for (let k = 0; k < 8; k++) {
          const xx = cx + DX8[k]!;
          const zz = cz + DZ8[k]!;
          if (xx < 0 || xx >= this.cellsX || zz < 0 || zz >= this.cellsY) continue;
          const score = (poor ? value(zz * this.cellsX + xx) : 0) + this.rnd(id * 8 + k, P_MOVE + 1) * (poor ? 0.05 : 1);
          if (score > best) {
            best = score;
            bx = xx;
            bz = zz;
          }
        }
        this.x[i] = (bx + 0.5) * CELL_M;
        this.z[i] = (bz + 0.5) * CELL_M;
      }
    }

    // 2. Списки добычи по ячейкам: отдельно кролики и олени.
    for (const prey of [RABBIT, DEER]) {
      const head = this.cellHead[prey]!;
      const touched = this.touched[prey]!;
      for (const cell of touched) head[cell] = -1;
      touched.length = 0;
    }
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1 || this.sp[i]! > DEER) continue;
      const head = this.cellHead[this.sp[i]!]!;
      const cell = this.cellAt(this.x[i]!, this.z[i]!);
      if (head[cell] === -1) this.touched[this.sp[i]!]!.push(cell);
      this.cellNext[i] = head[cell]!;
      head[cell] = i;
    }

    // 3. Хищники: голодный ищет ближайшую добычу из своего списка, по порядку предпочтения.
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1) continue;
      const spec = SPECS[this.sp[i]!]!;
      if (spec.herbivore) continue;
      const id = this.uid[i]!;
      let fx = this.x[i]!;
      let fz = this.z[i]!;
      let moved = false;
      if (this.energy[i]! < spec.hungryFrac * spec.eMax) {
        for (const prey of spec.prey) {
          const target = this.nearest(prey, fx, fz, spec.senseCells);
          if (target < 0) continue;
          const dx = this.x[target]! - fx;
          const dz = this.z[target]! - fz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= spec.run) {
            fx = this.x[target]!;
            fz = this.z[target]!;
            if (this.rnd(id, P_CATCH) < prey.catchChance) {
              this.kill(target, PREDATION);
              this.energy[i] = Math.min(spec.eMax, this.energy[i]! + prey.energy);
            }
          } else {
            fx += (dx / dist) * spec.run;
            fz += (dz / dist) * spec.run;
          }
          moved = true;
          break;
        }
      }
      if (!moved && spec.omnivore && this.energy[i]! < spec.eMax * 0.5) {
        // Ягоды: хватает, чтобы пережить нехватку добычи, но не на выводок.
        const cell = this.cellAt(fx, fz);
        const berries = Math.min(0.035, Math.max(0, this.shrub[cell]! - SHRUB.floor));
        this.shrub[cell]! -= berries;
        this.energy[i]! += berries;
      }
      if (!moved) {
        const angle = this.rnd(id, P_MOVE + 3) * Math.PI * 2;
        fx += Math.cos(angle) * spec.wander;
        fz += Math.sin(angle) * spec.wander;
      }
      this.x[i] = fx < 0 ? 0 : fx > maxX ? maxX : fx;
      this.z[i] = fz < 0 ? 0 : fz > maxZ ? maxZ : fz;
      this.energy[i]! -= spec.metabolism * cost * DT;
      if (this.energy[i]! <= 0) this.kill(i, STARVE);
    }
  }

  private nearest(prey: Prey, x: number, z: number, radius: number): number {
    const head = this.cellHead[prey.species]!;
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
        const cell = zz * this.cellsX + xx;
        // Укрытие: кролик прячется в густой траве, олень — в густом кустарнике.
        if (prey.hides && (prey.species === DEER ? this.shrub[cell]! >= SHRUB_COVER : this.grass[cell]! >= COVER)) continue;
        for (let j = head[cell]!; j >= 0; j = this.cellNext[j]!) {
          if (this.alive[j] !== 1) continue;
          const ddx = this.x[j]! - x;
          const ddz = this.z[j]! - z;
          const d = ddx * ddx + ddz * ddz;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
    }
    return best;
  }

  /** Суточные события жизни: старение, случайная смерть, размножение по правилам вида. */
  private dailyLife(i: number): void {
    const species = this.sp[i]!;
    const spec = SPECS[species]!;
    const id = this.uid[i]!;
    this.age[i]! += 1;
    if (this.age[i]! > this.life[i]!) return this.kill(i, OLD_AGE);
    if (this.rnd(id, P_LIFE) < spec.baseMortality) return this.kill(i, BASE);
    this.cool[i]! -= 1;
    if ((id & 1) !== 1 || this.age[i]! < spec.matureDays || this.energy[i]! < spec.reproThreshold || this.cool[i]! > 0) return;
    if (!spec.breeds[this.season]) return;
    if (spec.territoryCap > 0) {
      const block = this.blockAt(species, this.x[i]!, this.z[i]!);
      if (this.inBlock[species]![block]! >= spec.territoryCap) return;
      this.inBlock[species]![block]! += spec.litter;
    }
    this.minParentAge[species] = Math.min(this.minParentAge[species]!, this.age[i]!);
    this.minParentEnergy[species] = Math.min(this.minParentEnergy[species]!, this.energy[i]!);
    this.energy[i]! -= spec.reproCost;
    this.cool[i] = spec.cooldown;
    for (let k = 0; k < spec.litter; k++) {
      const child = this.spawn(species, this.x[i]!, this.z[i]!, 0, spec.birthEnergy);
      this.born[child] = this.day;
      this.births[species]![this.season]!++;
    }
  }
}

const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ8 = [0, 1, 1, 1, 0, -1, -1, -1];
