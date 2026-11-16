// Хранилище древесных растений (кустарники и деревья) — постоянные индивиды в столбцах (SoA).
// Свободные слоты переиспользуются; поколение в идентификаторе защищает от ссылок на погибшие.

import { EntityKind, MAX_GENERATION, MAX_INDEX, makeId, type EntityId } from '../../shared/ids';

export const Stage = {
  Seedling: 0,
  Sapling: 1,
  Mature: 2,
  Old: 3,
} as const;
export type Stage = (typeof Stage)[keyof typeof Stage];
export const STAGE_NAMES = ['всход', 'подрост', 'взрослое', 'старое'] as const;

export class WoodyStore {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly species: Uint8Array;
  /** Возраст, игровые годы. */
  readonly age: Float32Array;
  /** Сухая биомасса, кг (древесина + листва). */
  readonly biomass: Float32Array;
  /** Облиственность 0..1. */
  readonly leaf: Float32Array;
  readonly health: Float32Array;
  readonly stage: Uint8Array;
  /** Скользящие индексы стресса 0..1: вода и свет. */
  readonly stressW: Float32Array;
  readonly stressL: Float32Array;
  /** Индекс эко-ячейки под растением (кэш по координатам). */
  readonly cell: Int32Array;
  readonly alive: Uint8Array;
  readonly generation: Uint8Array;
  highWater = 0;
  count = 0;
  private free: number[] = [];

  constructor(capacity: number) {
    if (capacity > MAX_INDEX + 1) throw new RangeError('Ёмкость хранилища превышает адресуемую идентификатором');
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.species = new Uint8Array(capacity);
    this.age = new Float32Array(capacity);
    this.biomass = new Float32Array(capacity);
    this.leaf = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.stage = new Uint8Array(capacity);
    this.stressW = new Float32Array(capacity);
    this.stressL = new Float32Array(capacity);
    this.cell = new Int32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.generation = new Uint8Array(capacity);
  }

  /** Индекс нового растения или −1, если хранилище заполнено. */
  spawn(species: number, x: number, z: number, cell: number, biomass: number, age: number): number {
    let i: number;
    if (this.free.length > 0) i = this.free.pop()!;
    else if (this.highWater < this.capacity) i = this.highWater++;
    else return -1;
    this.x[i] = x;
    this.z[i] = z;
    this.species[i] = species;
    this.age[i] = age;
    this.biomass[i] = biomass;
    this.leaf[i] = 0;
    this.health[i] = 1;
    this.stage[i] = Stage.Seedling;
    this.stressW[i] = 0;
    this.stressL[i] = 0;
    this.cell[i] = cell;
    this.alive[i] = 1;
    this.count++;
    return i;
  }

  remove(i: number): void {
    if (this.alive[i] !== 1) return;
    this.alive[i] = 0;
    this.biomass[i] = 0;
    this.generation[i] = (this.generation[i]! + 1) & MAX_GENERATION;
    this.free.push(i);
    this.count--;
  }

  idOf(i: number): EntityId {
    return makeId(EntityKind.Tree, this.generation[i]!, i);
  }

  freeSlots(): Int32Array {
    return Int32Array.from(this.free);
  }

  restore(highWater: number, count: number, free: ArrayLike<number>): void {
    if (highWater > this.capacity || count > highWater) throw new Error('Сохранение растений повреждено');
    this.highWater = highWater;
    this.count = count;
    this.free = Array.from(free);
  }
}
