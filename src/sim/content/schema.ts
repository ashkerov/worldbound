// Схемы каталогов контента (ARCHITECTURE.md, раздел 6.3): декларативное описание полей и проверка.
// Каталог с ошибкой не загружается — ошибка называет файл, запись и поле.

export type FieldSpec =
  | { kind: 'number'; min: number; max: number; optional?: boolean; integer?: boolean }
  | { kind: 'string'; pattern?: RegExp; optional?: boolean }
  | { kind: 'enum'; values: readonly string[]; optional?: boolean }
  | { kind: 'boolean'; optional?: boolean }
  | { kind: 'object'; fields: Record<string, FieldSpec>; optional?: boolean; check?: (value: Record<string, unknown>) => string | null }
  | { kind: 'map'; keys: readonly string[]; value: FieldSpec; optional?: boolean }
  | { kind: 'list'; item: FieldSpec; minItems?: number; maxItems?: number; optional?: boolean };

export interface CatalogSchema {
  /** Имя каталога для сообщений об ошибках, например «content/plants/plants.json». */
  file: string;
  /** Поле со списком записей. */
  listField: string;
  entry: Record<string, FieldSpec>;
  /** Проверка записи целиком (связи между полями). */
  check?: (entry: Record<string, unknown>) => string | null;
  maxEntries: number;
}

export class CatalogError extends Error {}

function fail(where: string, message: string): never {
  throw new CatalogError(`${where}: ${message}`);
}

function validateValue(spec: FieldSpec, value: unknown, where: string): unknown {
  if (value === undefined) {
    if (spec.optional) return undefined;
    fail(where, 'обязательное поле отсутствует');
  }
  switch (spec.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'ожидалось число');
      if (value < spec.min || value > spec.max) fail(where, `${value} вне диапазона [${spec.min}, ${spec.max}]`);
      if (spec.integer && !Number.isInteger(value)) fail(where, 'ожидалось целое');
      return value;
    case 'string':
      if (typeof value !== 'string' || value.length === 0) fail(where, 'ожидалась непустая строка');
      if (spec.pattern && !spec.pattern.test(value)) fail(where, `«${value}» не соответствует формату`);
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) fail(where, `ожидалось одно из: ${spec.values.join(', ')}`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail(where, 'ожидалось true или false');
      return value;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'ожидался объект');
      const out = validateObject(spec.fields, value as Record<string, unknown>, where);
      const problem = spec.check?.(out);
      if (problem) fail(where, problem);
      return out;
    }
    case 'map': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'ожидался объект');
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (!spec.keys.includes(key)) fail(`${where}.${key}`, `неизвестный ключ; допустимы: ${spec.keys.join(', ')}`);
        out[key] = validateValue(spec.value, v, `${where}.${key}`);
      }
      return out;
    }
    case 'list': {
      if (!Array.isArray(value)) fail(where, 'ожидался список');
      if (spec.minItems !== undefined && value.length < spec.minItems) fail(where, `не меньше ${spec.minItems} элементов`);
      if (spec.maxItems !== undefined && value.length > spec.maxItems) fail(where, `не больше ${spec.maxItems} элементов`);
      return value.map((item, i) => validateValue(spec.item, item, `${where}[${i}]`));
    }
  }
}

function validateObject(fields: Record<string, FieldSpec>, value: Record<string, unknown>, where: string): Record<string, unknown> {
  for (const key of Object.keys(value)) {
    if (!(key in fields)) fail(`${where}.${key}`, 'неизвестное поле (опечатка?)');
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const v = validateValue(spec, value[key], `${where}.${key}`);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Проверяет каталог и возвращает записи. Идентификаторы (`id`) обязаны быть уникальными. */
export function validateCatalog<T>(schema: CatalogSchema, raw: unknown): T[] {
  if (typeof raw !== 'object' || raw === null) fail(schema.file, 'ожидался объект');
  const list = (raw as Record<string, unknown>)[schema.listField];
  if (!Array.isArray(list) || list.length === 0) fail(schema.file, `нет списка «${schema.listField}»`);
  if (list.length > schema.maxEntries) fail(schema.file, `не больше ${schema.maxEntries} записей`);
  const seen = new Set<string>();
  return list.map((entry, index) => {
    const id = typeof entry === 'object' && entry && 'id' in entry ? String((entry as { id: unknown }).id) : String(index);
    const where = `${schema.file}, запись ${index} (${id})`;
    if (typeof entry !== 'object' || entry === null) fail(where, 'ожидался объект');
    const out = validateObject(schema.entry, entry as Record<string, unknown>, where);
    if (seen.has(id)) fail(where, `повтор id «${id}»`);
    seen.add(id);
    const problem = schema.check?.(out);
    if (problem) fail(where, problem);
    return out as T;
  });
}

export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Проверка упорядоченности четырёх точек трапеции условий: min ≤ optMin ≤ optMax ≤ max. */
export function ordered(...keys: string[]): (value: Record<string, unknown>) => string | null {
  return (value) => {
    for (let i = 1; i < keys.length; i++) {
      if ((value[keys[i - 1]!] as number) > (value[keys[i]!] as number)) return `должно быть ${keys.join(' ≤ ')}`;
    }
    return null;
  };
}
