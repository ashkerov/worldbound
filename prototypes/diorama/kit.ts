// Общие инструменты диорамы: сборщик геометрии с цветами вершин, текстуры из canvas, узел ветра.

import * as THREE from 'three/webgpu';
import { attribute, cos, positionLocal, sin, time, vec3 } from 'three/tsl';

type ColorSource = THREE.Color | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color);
type SwaySource = number | ((p: THREE.Vector3) => number);

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/** Накапливает части в одну геометрию: position, normal, color, uv, sway (амплитуда качания на ветру). */
export class GeoBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uvs: number[] = [];
  private readonly sway: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: ColorSource, sway: SwaySource = 0): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = g.getAttribute('position');
    const normal = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    _nm.getNormalMatrix(matrix);
    for (let i = 0; i < position.count; i++) {
      _p.fromBufferAttribute(position, i).applyMatrix4(matrix);
      _n.fromBufferAttribute(normal, i).applyMatrix3(_nm).normalize();
      const c = typeof color === 'function' ? color(_p, _n) : color;
      this.pos.push(_p.x, _p.y, _p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.col.push(c.r, c.g, c.b);
      this.uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      this.sway.push(typeof sway === 'function' ? sway(_p) : sway);
    }
    if (g !== geometry) g.dispose();
    return this;
  }

  /** Треугольник с явными атрибутами. */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3, colors: [THREE.Color, THREE.Color, THREE.Color], uv: [number, number, number, number, number, number], sway: [number, number, number]): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.nor.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    for (const k of colors) this.col.push(k.r, k.g, k.b);
    this.uvs.push(...uv);
    this.sway.push(...sway);
  }

  /**
   * Листовая карточка: квадрат с центром `centre`, лежащий в плоскости (right, up).
   * Материал листвы двусторонний, а нормаль затенения общая — карточки кроны освещаются как единый объём.
   */
  card(centre: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, shade: THREE.Vector3, low: THREE.Color, highColor: THREE.Color, swayLow: number, swayHigh: number): void {
    const a = centre.clone().sub(right).sub(up);
    const b = centre.clone().add(right).sub(up);
    const c = centre.clone().add(right).add(up);
    const d = centre.clone().sub(right).add(up);
    this.tri(a, b, c, shade, [low, low, highColor], [0, 0, 1, 0, 1, 1], [swayLow, swayLow, swayHigh]);
    this.tri(a, c, d, shade, [low, highColor, highColor], [0, 0, 1, 1, 0, 1], [swayLow, swayHigh, swayHigh]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Смещение вершины ветром. positionLocal к этому моменту уже в мировых координатах экземпляра — волны согласованы в пространстве. */
export function windPosition(strength = 1) {
  const sway = attribute('sway', 'float');
  const p = positionLocal;
  const gust = sin(time.mul(0.7).add(p.x.mul(0.05)).add(p.z.mul(0.04))).mul(0.5).add(0.7);
  const dx = sin(time.mul(1.5).add(p.x.mul(0.42)).add(p.z.mul(0.31))).mul(gust);
  const dz = cos(time.mul(1.2).add(p.x.mul(0.27)).sub(p.z.mul(0.44))).mul(gust);
  const flutter = sin(time.mul(5.1).add(p.x.mul(2.3)).add(p.y.mul(3.1)).add(p.z.mul(1.7))).mul(0.25);
  return p.add(vec3(dx.add(flutter), 0, dz.add(flutter.mul(0.6))).mul(sway.mul(strength)));
}

export function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void, srgb = true): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Мягкое круглое облачко для дыма и водяной пыли. */
export function puffTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

export interface PuffOptions {
  count: number;
  source: THREE.Vector3;
  spread: number;
  velocity: THREE.Vector3;
  drift: number;
  life: number;
  sizeStart: number;
  sizeEnd: number;
  opacity: number;
  color: THREE.Color;
}

/** Облачка-спрайты с жизненным циклом: дым из трубы, водяная пыль у водопада. */
export class Puffs {
  readonly group = new THREE.Group();
  readonly tint = new THREE.Color(1, 1, 1);
  private readonly sprites: THREE.Sprite[] = [];
  private readonly age: number[] = [];
  private readonly seed: number[] = [];
  private readonly origin: THREE.Vector3[] = [];

  constructor(
    texture: THREE.Texture,
    private readonly o: PuffOptions,
  ) {
    for (let i = 0; i < o.count; i++) {
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0 });
      const sprite = new THREE.Sprite(material);
      this.sprites.push(sprite);
      this.age.push((i / o.count) * o.life);
      this.seed.push(i * 12.9898);
      this.origin.push(o.source.clone());
      this.group.add(sprite);
    }
  }

  update(dt: number, wind: number): void {
    const o = this.o;
    for (let i = 0; i < this.sprites.length; i++) {
      let age = this.age[i]! + dt;
      if (age > o.life) {
        age -= o.life;
        this.seed[i]! += 1.618;
        const s = this.seed[i]!;
        this.origin[i]!.set(o.source.x + Math.sin(s * 7.1) * o.spread, o.source.y, o.source.z + Math.cos(s * 5.3) * o.spread);
      }
      this.age[i] = age;
      const t = age / o.life;
      const s = this.seed[i]!;
      const sprite = this.sprites[i]!;
      sprite.position.set(
        this.origin[i]!.x + o.velocity.x * age + Math.sin(s + age * 0.9) * o.drift * t + wind * age * age * 0.25,
        this.origin[i]!.y + o.velocity.y * age,
        this.origin[i]!.z + o.velocity.z * age + Math.cos(s * 1.3 + age * 0.7) * o.drift * t,
      );
      const size = o.sizeStart + (o.sizeEnd - o.sizeStart) * t;
      sprite.scale.set(size, size, 1);
      const material = sprite.material;
      material.opacity = o.opacity * Math.min(1, t * 6) * (1 - t) ** 1.5;
      material.color.copy(o.color).multiply(this.tint);
      material.rotation = s + age * 0.25;
    }
  }
}
