// Хеш состояния мира: основа тестов детерминизма и «сохранил → загрузил → совпало».

export class StateHasher {
  private h1 = 0x811c9dc5;
  private h2 = 0x9e3779b9;

  addInt(value: number): this {
    this.h1 = Math.imul(this.h1 ^ (value | 0), 0x01000193);
    this.h2 = Math.imul(this.h2 ^ (value | 0), 0x85ebca6b) ^ (this.h2 >>> 15);
    return this;
  }

  /** Хеширует `length` первых элементов массива по их байтовому представлению. */
  addArray(array: Float32Array | Uint8Array | Uint16Array | Int32Array | Uint32Array, length = array.length): this {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, length * array.BYTES_PER_ELEMENT);
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      h1 = Math.imul(h1 ^ b, 0x01000193);
      h2 = Math.imul(h2 ^ b, 0x85ebca6b) ^ (h2 >>> 15);
    }
    this.h1 = h1;
    this.h2 = h2;
    return this.addInt(length);
  }

  digest(): string {
    const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
    return hex(this.h1) + hex(this.h2);
  }
}
