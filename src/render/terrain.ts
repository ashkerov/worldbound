// Рельеф: квадродерево узлов с LOD и «юбками» против щелей между уровнями, горизонт за границей мира,
// материал из полей симуляции (почва, влага, зелень, снег, облачность, слой-карта).

import * as THREE from 'three/webgpu';
import { color, float, mix, mx_noise_float, normalWorld, positionWorld, sin, smoothstep, step, texture, vec2 } from 'three/tsl';
import type { UniformNode } from 'three/webgpu';
import type { WorldData } from './worldData';

/** Квадов по стороне узла. */
const GRID = 32;
/** Минимальная сторона листа, м: 64 м / 32 = шаг 2 м — разрешение высот мира. */
const LEAF = 64;
/** Тени отбрасывают только узлы не крупнее этого (шаг ≤ 8 м): грубые дальние узлы давали угловатые тени при низком солнце. */
const SHADOW_CASTER_MAX = 256;

type FloatUniform = UniformNode<'float', number>;
export interface TerrainUniforms {
  layerOpacity: FloatUniform;
  worldSize: FloatUniform;
}

/** Материал поверхности. Цвет — функция реальных данных; шум даёт только мелкую фактуру. */
export function terrainMaterial(data: WorldData, u: TerrainUniforms): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0 });
  const p = positionWorld;
  const uvw = vec2(p.x, p.z).div(u.worldSize);
  const surface = texture(data.surfaceTex, uvw);
  const soilTex = texture(data.staticTex, uvw);
  const weather = texture(data.weatherTex, uvw);
  const layer = texture(data.layerTex, uvw);

  const big = mx_noise_float(p.mul(0.045));
  const mid = mx_noise_float(p.mul(0.35));
  const fine = mx_noise_float(p.mul(2.1));

  const snow = surface.r;
  const moisture = surface.g;
  const green = surface.b;
  const wet = surface.a;

  // Покров: от сухой выгоревшей травы к сочной; зелень — отклик среды из симуляции.
  const lush = mix(color(0x4f7a32), color(0x3d6a2a), big.mul(0.5).add(0.5));
  const dry = mix(color(0x9a9450), color(0x8a8a46), mid.mul(0.5).add(0.5));
  const grass = mix(dry, lush, smoothstep(0.15, 0.7, moisture.mul(0.6).add(green.mul(0.6))));
  const soil = soilTex.rgb.mul(mid.mul(0.12).add(1));
  const coverK = smoothstep(0.05, 0.55, green.add(fine.mul(0.06)));
  let ground = mix(soil, grass, coverK);

  // Скала по уклону: слоистая порода, как в прототипе 1A.
  const layerY = p.y.mul(0.18).add(big.mul(2.2)).add(mid.mul(0.6)).add(p.x.mul(0.004));
  const band = layerY.fract();
  const seam = smoothstep(0, 0.08, band).mul(smoothstep(1, 0.9, band));
  const tone = sin(layerY.floor().mul(12.9898)).mul(0.5).add(0.5);
  const rock = mix(color(0x77716a), color(0x9a9488), tone.mul(0.7).add(mid.mul(0.3))).mul(seam.mul(0.18).add(0.82)).mul(fine.mul(0.14).add(1));
  // За границей мира (горизонт, разрешение 32 м) склоны сглажены — горы там скальные по высоте.
  const outside = float(1).sub(step(0, p.x).mul(step(p.x, u.worldSize)).mul(step(0, p.z)).mul(step(p.z, u.worldSize)));
  const rockMask = smoothstep(0.8, 0.62, normalWorld.y.add(mid.mul(0.06))).max(outside.mul(smoothstep(90, 220, p.y.add(big.mul(40))))).max(smoothstep(340, 520, p.y.add(big.mul(60))));
  ground = mix(ground, rock, rockMask);

  // Влажная поверхность темнее; снег ложится на пологие места.
  ground = ground.mul(float(1).sub(wet.mul(0.22)).sub(moisture.mul(0.08)));
  const snowK = smoothstep(0.015, 0.2, snow.add(fine.mul(0.02))).mul(smoothstep(0.5, 0.75, normalWorld.y));
  ground = mix(ground, color(0xeef3f8).mul(mid.mul(0.05).add(0.97)), snowK);

  // Тень облаков: темнее там, где над миром идут дождевые ячейки.
  ground = ground.mul(float(1).sub(weather.r.mul(0.32)));

  m.colorNode = mix(ground, layer.rgb, u.layerOpacity.mul(layer.a));
  // Слой-карта читается и ночью: часть его цвета не зависит от освещения сцены.
  m.emissiveNode = layer.rgb.mul(u.layerOpacity.mul(layer.a).mul(0.45));
  m.roughnessNode = float(0.95).sub(wet.mul(0.25)).sub(snowK.mul(0.15));
  return m;
}

interface Node {
  x: number;
  z: number;
  size: number;
  level: number;
  minY: number;
  maxY: number;
  children: Node[] | null;
  mesh: THREE.Mesh | null;
}

/** Квадродерево рельефа мира. Геометрия узлов строится по требованию и кэшируется. */
export class TerrainLod {
  readonly group = new THREE.Group();
  private readonly root: Node;
  private readonly index: THREE.BufferAttribute;
  private readonly material: THREE.Material;
  private readonly visible = new Set<Node>();
  /** Коэффициент дальности: узел делится, пока расстояние до него меньше size × k. */
  lodK = 2;
  /** Сколько геометрий узлов можно построить за кадр. */
  buildBudget = 3;
  castShadow = true;
  nodesDrawn = 0;
  private built = 0;

  constructor(
    private readonly data: WorldData,
    material: THREE.Material,
  ) {
    this.material = material;
    const verts = GRID + 1;
    const skirt = GRID * 4;
    const idx: number[] = [];
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        const a = z * verts + x;
        idx.push(a, a + verts, a + 1, a + 1, a + verts, a + verts + 1);
      }
    }
    // Юбка: полоса вниз по периметру узла, закрывает щели между соседями разных уровней.
    const ring: number[] = [];
    for (let x = 0; x < GRID; x++) ring.push(x);
    for (let z = 0; z < GRID; z++) ring.push(z * verts + GRID);
    for (let x = GRID; x > 0; x--) ring.push(GRID * verts + x);
    for (let z = GRID; z > 0; z--) ring.push(z * verts);
    const base = verts * verts;
    for (let k = 0; k < skirt; k++) {
      const a = ring[k]!;
      const b = ring[(k + 1) % skirt]!;
      const a2 = base + k;
      const b2 = base + ((k + 1) % skirt);
      idx.push(a, b, a2, b, b2, a2);
    }
    this.index = new THREE.BufferAttribute(new Uint32Array(idx), 1);
    this.root = this.makeNode(0, 0, data.worldSize, 0);
  }

  private makeNode(x: number, z: number, size: number, level: number): Node {
    const t = this.data.terrain;
    const stride = Math.max(1, Math.round(size / GRID / t.spacing));
    let minY = Infinity;
    let maxY = -Infinity;
    const x0 = Math.round(x / t.spacing);
    const z0 = Math.round(z / t.spacing);
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const v = t.heights[Math.min(t.samples - 1, z0 + j * stride) * t.samples + Math.min(t.samples - 1, x0 + i * stride)]!;
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
      }
    }
    return { x, z, size, level, minY: Math.min(minY, 0), maxY, children: null, mesh: null };
  }

  private children(node: Node): Node[] {
    if (!node.children) {
      const h = node.size / 2;
      node.children = [this.makeNode(node.x, node.z, h, node.level + 1), this.makeNode(node.x + h, node.z, h, node.level + 1), this.makeNode(node.x, node.z + h, h, node.level + 1), this.makeNode(node.x + h, node.z + h, h, node.level + 1)];
    }
    return node.children;
  }

  private buildMesh(node: Node): THREE.Mesh {
    const t = this.data.terrain;
    const verts = GRID + 1;
    const stride = Math.max(1, Math.round(node.size / GRID / t.spacing));
    const step = stride * t.spacing;
    const x0 = Math.round(node.x / t.spacing);
    const z0 = Math.round(node.z / t.spacing);
    const count = verts * verts + GRID * 4;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const last = t.samples - 1;
    const hAt = (ix: number, iz: number) => t.heights[Math.min(last, Math.max(0, iz)) * t.samples + Math.min(last, Math.max(0, ix))]!;
    const d = this.data;
    const perCell = d.cellSize / t.spacing;
    // Над реками вершина грубого узла берёт минимум по своему окну: прорезанное русло не исчезает
    // при прореживании отсчётов, и вода не прячется под рельефом на средних дистанциях.
    const nearRiver = (ix: number, iz: number) => {
      const cx = Math.floor(ix / perCell);
      const cz = Math.floor(iz / perCell);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x >= 0 && z >= 0 && x < d.n && z < d.n && d.waterKind[z * d.n + x] === 1) return true;
        }
      }
      return false;
    };
    const vertexHeight = (ix: number, iz: number) => {
      if (stride === 1 || stride > 16 || !nearRiver(ix, iz)) return hAt(ix, iz);
      const r = stride >> 1;
      let m = Infinity;
      for (let z = iz - r; z <= iz + r; z++) for (let x = ix - r; x <= ix + r; x++) m = Math.min(m, hAt(x, z));
      return m;
    };
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const ix = x0 + i * stride;
        const iz = z0 + j * stride;
        const k = (j * verts + i) * 3;
        pos[k] = ix * t.spacing;
        pos[k + 1] = vertexHeight(ix, iz);
        pos[k + 2] = iz * t.spacing;
        // Нормаль по центральным разностям с шагом узла — освещение согласовано с геометрией.
        const dx = hAt(ix + stride, iz) - hAt(ix - stride, iz);
        const dz = hAt(ix, iz + stride) - hAt(ix, iz - stride);
        const len = Math.sqrt(dx * dx + 4 * step * step + dz * dz);
        nor[k] = -dx / len;
        nor[k + 1] = (2 * step) / len;
        nor[k + 2] = -dz / len;
      }
    }
    // Юбка.
    const ring: number[] = [];
    for (let x = 0; x < GRID; x++) ring.push(x);
    for (let z = 0; z < GRID; z++) ring.push(z * verts + GRID);
    for (let x = GRID; x > 0; x--) ring.push(GRID * verts + x);
    for (let z = GRID; z > 0; z--) ring.push(z * verts);
    const depth = step * 1.5 + 2;
    ring.forEach((src, k) => {
      const d = (verts * verts + k) * 3;
      pos[d] = pos[src * 3]!;
      pos[d + 1] = pos[src * 3 + 1]! - depth;
      pos[d + 2] = pos[src * 3 + 2]!;
      nor[d] = nor[src * 3]!;
      nor[d + 1] = nor[src * 3 + 1]!;
      nor[d + 2] = nor[src * 3 + 2]!;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(this.index);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(node.x, node.minY - depth, node.z), new THREE.Vector3(node.x + node.size, node.maxY, node.z + node.size));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = this.castShadow && node.size <= SHADOW_CASTER_MAX;
    mesh.matrixAutoUpdate = false;
    this.built++;
    return mesh;
  }

  private distance(node: Node, eye: THREE.Vector3): number {
    const dx = Math.max(node.x - eye.x, 0, eye.x - (node.x + node.size));
    const dz = Math.max(node.z - eye.z, 0, eye.z - (node.z + node.size));
    const dy = Math.max(node.minY - eye.y, 0, eye.y - node.maxY);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Выбор узлов под текущую камеру. Недостроенные узлы временно заменяются предком — дыр нет. */
  update(eye: THREE.Vector3): void {
    let budget = this.buildBudget;
    const want: Node[] = [];
    const visit = (node: Node) => {
      const split = node.size > LEAF && this.distance(node, eye) < node.size * this.lodK;
      if (split) {
        const kids = this.children(node);
        // Геометрия детей строится постепенно, в пределах бюджета кадра; делим узел, когда готовы все четыре.
        for (const k of kids) {
          if (!k.mesh && budget > 0) {
            k.mesh = this.buildMesh(k);
            budget--;
          }
        }
        if (kids.every((k) => k.mesh)) {
          for (const k of kids) visit(k);
          return;
        }
      }
      if (!node.mesh) node.mesh = this.buildMesh(node);
      want.push(node);
    };
    visit(this.root);
    const next = new Set(want);
    for (const node of this.visible) {
      if (!next.has(node)) this.group.remove(node.mesh!);
    }
    for (const node of next) {
      if (!this.visible.has(node)) this.group.add(node.mesh!);
    }
    this.visible.clear();
    for (const node of next) this.visible.add(node);
    this.nodesDrawn = next.size;
    // Освобождение памяти: удаляются геометрии далёких невидимых узлов, если их накопилось много.
    if (this.built > 1400) this.prune(this.root);
  }

  private prune(node: Node): void {
    if (!node.children) return;
    for (const k of node.children) {
      this.prune(k);
      if (k.mesh && !this.visible.has(k) && k.level >= 4) {
        k.mesh.geometry.dispose();
        k.mesh = null;
        this.built--;
      }
    }
  }

  setCastShadow(on: boolean): void {
    this.castShadow = on;
    const walk = (node: Node) => {
      if (node.mesh) node.mesh.castShadow = on && node.size <= SHADOW_CASTER_MAX;
      node.children?.forEach(walk);
    };
    walk(this.root);
  }

  dispose(): void {
    const walk = (node: Node) => {
      node.mesh?.geometry.dispose();
      node.children?.forEach(walk);
    };
    walk(this.root);
    this.group.clear();
  }
}

/** Горизонт: окрестность за границей мира (без внутренней части, которую рисует квадродерево). */
export function buildHorizonMesh(data: WorldData, material: THREE.Material): THREE.Mesh {
  const h = data.horizon;
  const s = h.samples;
  const pos = new Float32Array(s * s * 3);
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      const k = (j * s + i) * 3;
      pos[k] = h.originX + i * h.spacing;
      pos[k + 1] = h.heights[j * s + i]!;
      pos[k + 2] = h.originZ + j * h.spacing;
    }
  }
  const size = data.worldSize;
  const idx: number[] = [];
  for (let j = 0; j < s - 1; j++) {
    for (let i = 0; i < s - 1; i++) {
      const x0 = h.originX + i * h.spacing;
      const z0 = h.originZ + j * h.spacing;
      // Квад внутри мира (включая касающиеся границы изнутри) не рисуется: горизонт стыкуется с рельефом
      // мира ровно по границе, где высоты совпадают, и не перекрывает его.
      if (x0 >= 0 && z0 >= 0 && x0 + h.spacing <= size && z0 + h.spacing <= size) continue;
      const a = j * s + i;
      idx.push(a, a + s, a + 1, a + 1, a + s, a + s + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  return mesh;
}
