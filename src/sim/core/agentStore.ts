// Типизированное хранилище агентов (SoA). В фазе 0 — тестовые агенты;
// столбцы и приёмы (свободные слоты, поколения) те же, что будут у животных.

import { EntityKind, MAX_GENERATION, MAX_INDEX, makeId, type EntityId } from '../../shared/ids';

export class AgentStore {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly heading: Float32Array;
  readonly targetHeading: Float32Array;
  readonly speed: Float32Array;
  readonly alive: Uint8Array;
  readonly generation: Uint8Array;
  /** Верхняя граница занятых слотов: обход идёт по [0, highWater). */
  highWater = 0;
  count = 0;
  private readonly free: number[] = [];

  constructor(capacity: number) {
    if (capacity > MAX_INDEX + 1) throw new RangeError('Ёмкость хранилища превышает адресуемую идентификатором');
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.heading = new Float32Array(capacity);
    this.targetHeading = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.generation = new Uint8Array(capacity);
  }

  /** Возвращает индекс слота или -1, если хранилище заполнено. */
  spawn(x: number, z: number, heading: number, speed: number): number {
    let index: number;
    if (this.free.length > 0) {
      index = this.free.pop()!;
    } else if (this.highWater < this.capacity) {
      index = this.highWater++;
    } else {
      return -1;
    }
    this.x[index] = x;
    this.z[index] = z;
    this.heading[index] = heading;
    this.targetHeading[index] = heading;
    this.speed[index] = speed;
    this.alive[index] = 1;
    this.count++;
    return index;
  }

  despawn(index: number): void {
    if (this.alive[index] !== 1) return;
    this.alive[index] = 0;
    this.generation[index] = (this.generation[index]! + 1) & MAX_GENERATION;
    this.free.push(index);
    this.count--;
  }

  clear(): void {
    for (let i = 0; i < this.highWater; i++) {
      if (this.alive[i] === 1) {
        this.alive[i] = 0;
        this.generation[i] = (this.generation[i]! + 1) & MAX_GENERATION;
      }
    }
    this.free.length = 0;
    this.highWater = 0;
    this.count = 0;
  }

  idOf(index: number): EntityId {
    return makeId(EntityKind.TestAgent, this.generation[index]!, index);
  }

  isCurrent(id: EntityId, index: number): boolean {
    return this.alive[index] === 1 && this.idOf(index) === id;
  }
}
