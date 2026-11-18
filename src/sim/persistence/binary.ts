// Двоичная запись и чтение секций сохранения (ARCHITECTURE.md, раздел 11.1).
// Секция: заголовок 32 байта + полезная нагрузка. Заголовок:
//   0  «WBSC» (4 байта)        16  длина нагрузки, u32
//   4  версия формата, u16      20  CRC-32 нагрузки, u32
//   6  версия схемы секции, u16 24  резерв (8 байт)
//   8  идентификатор секции, 8 байт ASCII (дополнен нулями)
// Нагрузка — последовательность полей с выравниванием по 8 байтам; порядок фиксирован схемой секции.

export const SECTION_MAGIC = 0x43534257; // «WBSC» в little-endian
/** 2 — фаза 3: набор секций открыт (новые секции необязательны и мигрируются). Секции версии 1 читаются. */
export const FORMAT_VERSION = 2;
const HEADER = 32;

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Typed = Float32Array | Float64Array | Uint8Array | Uint16Array | Int16Array | Int32Array | Uint32Array;

export class SectionWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
    const pad = (8 - (this.length % 8)) % 8;
    if (pad > 0) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
  }

  f64(value: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    this.push(b);
    return this;
  }

  /** Массив с префиксом длины (в элементах). */
  array(array: Typed): this {
    this.f64(array.length);
    this.push(new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength)));
    return this;
  }

  finish(id: string, schema: number): Uint8Array {
    const payload = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      payload.set(c, o);
      o += c.length;
    }
    const out = new Uint8Array(HEADER + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, SECTION_MAGIC, true);
    view.setUint16(4, FORMAT_VERSION, true);
    view.setUint16(6, schema, true);
    if (id.length > 8 || !/^[a-z0-9]+$/.test(id)) throw new Error(`Неверный идентификатор секции: ${id}`);
    for (let i = 0; i < id.length; i++) out[8 + i] = id.charCodeAt(i);
    view.setUint32(16, payload.length, true);
    view.setUint32(20, crc32(payload), true);
    out.set(payload, HEADER);
    return out;
  }
}

export interface SectionHeader {
  id: string;
  formatVersion: number;
  schema: number;
  length: number;
  crc: number;
}

export function readHeader(bytes: Uint8Array): SectionHeader {
  if (bytes.length < HEADER) throw new Error('Секция короче заголовка');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SECTION_MAGIC) throw new Error('Не секция сохранения WORLDBOUND');
  let id = '';
  for (let i = 8; i < 16 && bytes[i] !== 0; i++) id += String.fromCharCode(bytes[i]!);
  return { id, formatVersion: view.getUint16(4, true), schema: view.getUint16(6, true), length: view.getUint32(16, true), crc: view.getUint32(20, true) };
}

export class SectionReader {
  readonly header: SectionHeader;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array, expectedId: string) {
    this.header = readHeader(bytes);
    if (this.header.id !== expectedId) throw new Error(`Ожидалась секция ${expectedId}, найдена ${this.header.id}`);
    if (this.header.formatVersion > FORMAT_VERSION) throw new Error('Сохранение создано более новой версией игры');
    if (bytes.length !== HEADER + this.header.length) throw new Error(`Секция ${expectedId}: неверная длина`);
    this.bytes = bytes.subarray(HEADER);
    if (crc32(this.bytes) !== this.header.crc) throw new Error(`Секция ${expectedId}: контрольная сумма не совпала`);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  private align(): void {
    this.offset += (8 - (this.offset % 8)) % 8;
  }

  f64(): number {
    if (this.offset + 8 > this.bytes.length) throw new Error(`Секция ${this.header.id}: неожиданный конец`);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** Читает массив в существующий (длина обязана совпасть) — без лишних выделений. */
  into<T extends Typed>(target: T): T {
    const count = this.f64();
    if (count !== target.length) throw new Error(`Секция ${this.header.id}: длина массива ${count}, ожидалось ${target.length}`);
    const byteLength = count * target.BYTES_PER_ELEMENT;
    if (this.offset + byteLength > this.bytes.length) throw new Error(`Секция ${this.header.id}: неожиданный конец`);
    new Uint8Array(target.buffer, target.byteOffset, byteLength).set(this.bytes.subarray(this.offset, this.offset + byteLength));
    this.offset += byteLength;
    this.align();
    return target;
  }

  /** Проверка, что секция прочитана целиком: лишние байты означают другую раскладку. */
  end(): void {
    if (this.offset !== this.bytes.length) throw new Error(`Секция ${this.header.id}: лишние данные после конца раскладки`);
  }

  /** Читает массив переменной длины. */
  int32(): Int32Array {
    const count = this.f64();
    if (!Number.isInteger(count) || count < 0 || this.offset + count * 4 > this.bytes.length) throw new Error(`Секция ${this.header.id}: повреждённый массив`);
    const out = new Int32Array(count);
    new Uint8Array(out.buffer).set(this.bytes.subarray(this.offset, this.offset + count * 4));
    this.offset += count * 4;
    this.align();
    return out;
  }
}
