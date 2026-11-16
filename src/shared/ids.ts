// Идентификатор сущности: 32 бита = тип (4) | поколение (8) | индекс (20).
// Поколение защищает от «висячих» ссылок на слот, который переиспользован.

export const EntityKind = {
  None: 0,
  Tree: 1,
  Animal: 2,
  Person: 3,
  Building: 4,
  TestAgent: 15,
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export const MAX_INDEX = (1 << 20) - 1;
export const MAX_GENERATION = (1 << 8) - 1;

export type EntityId = number;

export function makeId(kind: EntityKind, generation: number, index: number): EntityId {
  if (index < 0 || index > MAX_INDEX) throw new RangeError(`Индекс сущности вне диапазона: ${index}`);
  return (((kind & 0xf) << 28) | ((generation & 0xff) << 20) | index) >>> 0;
}

export function idKind(id: EntityId): EntityKind {
  return ((id >>> 28) & 0xf) as EntityKind;
}

export function idGeneration(id: EntityId): number {
  return (id >>> 20) & 0xff;
}

export function idIndex(id: EntityId): number {
  return id & MAX_INDEX;
}
