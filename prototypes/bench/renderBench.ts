// Прототип 1B: нагрузка рендера в масштабе мира M (4096 м).
// Синтетическая сцена: чанки рельефа с двумя уровнями детализации, сотни тысяч деревьев
// с тремя LOD по чанкам, трава вокруг камеры, тысячи существ с анимацией из текстуры (VAT),
// тень от солнца. Камера автоматически проходит три ракурса; по каждому снимаются показатели.
//
// Параметры: ?renderer=webgl2&trees=300000&creatures=3000&grass=60000&shadows=1&dpr=1

import * as THREE from 'three/webgpu';
import { float, floor, fract, hash, instanceIndex, mix, positionLocal, texture, time, vec2, attribute } from 'three/tsl';
import { hash4 } from '../../src/shared/rng';

const params = new URLSearchParams(location.search);
const num = (name: string, fallback: number) => (params.has(name) ? Number(params.get(name)) : fallback);
const WORLD = 4096;
const CHUNK = 128;
const CHUNKS = WORLD / CHUNK;
const TREE_TARGET = num('trees', 300_000);
const CREATURES = num('creatures', 3000);
const GRASS = num('grass', 60_000);
const SHADOWS = num('shadows', 1) === 1;
const SEGMENT_SECONDS = num('seconds', 7);

// ───────── детерминированный рельеф ─────────

const INV = 1 / 4294967296;
const smooth = (t: number) => t * t * (3 - 2 * t);
function noise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const tz = smooth(z - iz);
  const a = hash4(seed, 0, ix, iz) * INV;
  const b = hash4(seed, 0, ix + 1, iz) * INV;
  const c = hash4(seed, 0, ix, iz + 1) * INV;
  const d = hash4(seed, 0, ix + 1, iz + 1) * INV;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
function heightAt(x: number, z: number): number {
  let h = 0;
  let amp = 90;
  let freq = 1 / 900;
  for (let o = 0; o < 5; o++) {
    h += (noise(10 + o, x * freq, z * freq) - 0.5) * amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return h;
}
const forestAt = (x: number, z: number) => Math.max(0, Math.min(1, (noise(77, x / 420, z / 420) - 0.38) * 4));

// ───────── геометрия ─────────

function terrainGeometry(cx: number, cz: number, segments: number): THREE.BufferGeometry {
  const n = segments + 1;
  const step = CHUNK / segments;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const meadow = new THREE.Color(0x7fa35a);
  const forest = new THREE.Color(0x3f6b3a);
  const tint = new THREE.Color();
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = cx * CHUNK + ix * step;
      const z = cz * CHUNK + iz * step;
      const i = (iz * n + ix) * 3;
      positions[i] = x;
      positions[i + 1] = heightAt(x, z);
      positions[i + 2] = z;
      tint.copy(meadow).lerp(forest, forestAt(x, z));
      colors[i] = tint.r;
      colors[i + 1] = tint.g;
      colors[i + 2] = tint.b;
    }
  }
  const indices = new Uint16Array(segments * segments * 6);
  let o = 0;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * n + ix;
      indices[o++] = a;
      indices[o++] = a + n;
      indices[o++] = a + 1;
      indices[o++] = a + 1;
      indices[o++] = a + n;
      indices[o++] = a + n + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => p.toNonIndexed());
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const arrays = flat.map((p) => p.getAttribute(name).array as Float32Array);
    const joined = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
    let offset = 0;
    for (const a of arrays) {
      joined.set(a, offset);
      offset += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(joined, 3));
  }
  return out;
}

function treeGeometry(lod: number): THREE.BufferGeometry {
  if (lod === 2) return merge([new THREE.OctahedronGeometry(3.2, 0).translate(0, 6.5, 0)]);
  const detail = lod === 0 ? 2 : 1;
  const trunk = new THREE.CylinderGeometry(0.35, 0.55, 5, lod === 0 ? 10 : 5).translate(0, 2.5, 0);
  const crowns = [
    new THREE.IcosahedronGeometry(3.0, detail).translate(0, 6.5, 0),
    new THREE.IcosahedronGeometry(2.2, detail).translate(1.6, 5.4, 0.8),
    new THREE.IcosahedronGeometry(2.0, detail).translate(-1.3, 5.8, -1.1),
  ];
  return merge(lod === 0 ? [trunk, ...crowns] : [trunk, crowns[0]!, crowns[1]!]);
}

/** Четвероногое из капсул и цилиндров (~450 треугольников) + запечённая анимация шага (VAT). */
function creatureAssets(): { geometry: THREE.BufferGeometry; vat: THREE.DataTexture; vertices: number; frames: number } {
  const parts: { g: THREE.BufferGeometry; leg: number }[] = [];
  parts.push({ g: new THREE.CapsuleGeometry(0.32, 0.9, 4, 12).rotateZ(Math.PI / 2).translate(0, 0.95, 0), leg: -1 });
  parts.push({ g: new THREE.SphereGeometry(0.24, 10, 8).translate(0.85, 1.25, 0), leg: -2 });
  const legs: [number, number][] = [
    [0.45, 0.18],
    [0.45, -0.18],
    [-0.45, 0.18],
    [-0.45, -0.18],
  ];
  legs.forEach(([lx, lz], k) => parts.push({ g: new THREE.CylinderGeometry(0.07, 0.05, 0.7, 8).translate(lx, 0.35, lz), leg: k }));
  const flat = parts.map((p) => ({ g: p.g.toNonIndexed(), leg: p.leg }));
  const vertices = flat.reduce((n, p) => n + p.g.getAttribute('position').count, 0);
  const frames = 16;
  const rest = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const vertexId = new Float32Array(vertices);
  const legOf = new Int8Array(vertices);
  let v = 0;
  for (const p of flat) {
    const pos = p.g.getAttribute('position').array as Float32Array;
    const nor = p.g.getAttribute('normal').array as Float32Array;
    for (let i = 0; i < pos.length / 3; i++, v++) {
      rest.set(pos.subarray(i * 3, i * 3 + 3), v * 3);
      normal.set(nor.subarray(i * 3, i * 3 + 3), v * 3);
      vertexId[v] = v;
      legOf[v] = p.leg;
    }
  }
  // Запекание: строка текстуры — кадр, столбец — вершина, значение — положение вершины.
  const data = new Float32Array(vertices * frames * 4);
  for (let f = 0; f < frames; f++) {
    const phase = (f / frames) * Math.PI * 2;
    for (let i = 0; i < vertices; i++) {
      let x = rest[i * 3]!;
      let y = rest[i * 3 + 1]!;
      const z = rest[i * 3 + 2]!;
      const leg = legOf[i]!;
      if (leg >= 0) {
        // Нога качается вокруг бедра (y = 0.7); диагональные пары — в противофазе.
        const angle = Math.sin(phase + (leg === 0 || leg === 3 ? 0 : Math.PI)) * 0.6;
        const dy = y - 0.7;
        const hipX = leg < 2 ? 0.45 : -0.45;
        const dx = x - hipX;
        x = hipX + dx * Math.cos(angle) - dy * Math.sin(angle);
        y = 0.7 + dx * Math.sin(angle) + dy * Math.cos(angle);
      } else {
        y += Math.sin(phase * 2) * 0.03 + (leg === -2 ? Math.sin(phase) * 0.04 : 0);
      }
      const o = (f * vertices + i) * 4;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = z;
      data[o + 3] = 1;
    }
  }
  const vat = new THREE.DataTexture(data, vertices, frames, THREE.RGBAFormat, THREE.FloatType);
  vat.minFilter = THREE.NearestFilter;
  vat.magFilter = THREE.NearestFilter;
  vat.needsUpdate = true;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rest, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('vertexId', new THREE.BufferAttribute(vertexId, 1));
  return { geometry, vat, vertices, frames };
}

/** Материал с подменой локального положения вершины до инстансинга — так анимация из текстуры совместима с InstancedMesh. */
class VatMaterial extends THREE.MeshStandardNodeMaterial {
  vatPosition: THREE.Node | null = null;

  override setupPosition(builder: THREE.NodeBuilder): THREE.Node {
    if (this.vatPosition) positionLocal.assign(this.vatPosition);
    return super.setupPosition(builder);
  }
}

// ───────── сцена ─────────

interface ChunkView {
  cx: number;
  cz: number;
  centre: THREE.Vector3;
  near: THREE.Mesh | null;
  far: THREE.Mesh;
  treeCount: number;
  treeMatrices: THREE.InstancedBufferAttribute | null;
  treeColors: THREE.InstancedBufferAttribute | null;
  trees: (THREE.InstancedMesh | null)[];
  terrainLod: number;
  treeLod: number;
}

export interface SegmentResult {
  name: string;
  fpsAvg: number;
  frameMsAvg: number;
  frameMsP99: number;
  frameMsMax: number;
  drawCalls: number;
  triangles: number;
}

export interface RenderBenchReport {
  backend: string;
  adapter: string;
  resolution: string;
  setup: { trees: number; creatures: number; grass: number; shadows: boolean; treeMeshesCreated: number };
  buildMs: number;
  heapMb: number | null;
  segments: SegmentResult[];
}

declare global {
  interface Window {
    __renderBench?: RenderBenchReport;
  }
}

async function main(): Promise<void> {
  const status = document.getElementById('status')!;
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: params.get('renderer') === 'webgl2' });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  renderer.setPixelRatio(num('dpr', 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = SHADOWS;

  const buildStart = performance.now();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa9cbe0);
  scene.fog = new THREE.Fog(0xa9cbe0, 600, 3200);
  scene.add(new THREE.HemisphereLight(0xe2efff, 0x4d5a3c, 1.0));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
  sun.castShadow = SHADOWS;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -160;
  sun.shadow.camera.right = sun.shadow.camera.top = 160;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 6000);

  const terrainMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 });
  const treeMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  const treeGeometries = [treeGeometry(0), treeGeometry(1), treeGeometry(2)];

  // Плотность леса по чанкам → число деревьев, в сумме близкое к заданному.
  const density = new Float32Array(CHUNKS * CHUNKS);
  let densitySum = 0;
  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) {
      const d = forestAt((cx + 0.5) * CHUNK, (cz + 0.5) * CHUNK);
      density[cz * CHUNKS + cx] = d;
      densitySum += d;
    }
  }
  const chunks: ChunkView[] = [];
  const dummy = new THREE.Object3D();
  const colour = new THREE.Color();
  let treesPlaced = 0;
  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) {
      const index = cz * CHUNKS + cx;
      const far = new THREE.Mesh(terrainGeometry(cx, cz, 8), terrainMaterial);
      far.matrixAutoUpdate = false;
      far.receiveShadow = SHADOWS;
      scene.add(far);
      const count = Math.round((density[index]! / densitySum) * TREE_TARGET);
      let treeMatrices: THREE.InstancedBufferAttribute | null = null;
      let treeColors: THREE.InstancedBufferAttribute | null = null;
      if (count > 0) {
        const matrices = new Float32Array(count * 16);
        const colors = new Float32Array(count * 3);
        for (let k = 0; k < count; k++) {
          const x = (cx + hash4(5, index, k, 0) * INV) * CHUNK;
          const z = (cz + hash4(5, index, k, 1) * INV) * CHUNK;
          const s = 0.7 + hash4(5, index, k, 2) * INV * 0.8;
          dummy.position.set(x, heightAt(x, z) - 0.2, z);
          dummy.rotation.set(0, hash4(5, index, k, 3) * INV * 6.283, 0);
          dummy.scale.set(s, s * (0.85 + hash4(5, index, k, 4) * INV * 0.4), s);
          dummy.updateMatrix();
          dummy.matrix.toArray(matrices, k * 16);
          colour.setHSL(0.24 + hash4(5, index, k, 5) * INV * 0.1, 0.45, 0.24 + hash4(5, index, k, 6) * INV * 0.12);
          colors[k * 3] = colour.r;
          colors[k * 3 + 1] = colour.g;
          colors[k * 3 + 2] = colour.b;
        }
        treeMatrices = new THREE.InstancedBufferAttribute(matrices, 16);
        treeColors = new THREE.InstancedBufferAttribute(colors, 3);
        treesPlaced += count;
      }
      const centreX = (cx + 0.5) * CHUNK;
      const centreZ = (cz + 0.5) * CHUNK;
      chunks.push({ cx, cz, centre: new THREE.Vector3(centreX, heightAt(centreX, centreZ), centreZ), near: null, far, treeCount: count, treeMatrices, treeColors, trees: [null, null, null], terrainLod: 1, treeLod: -1 });
    }
  }

  let treeMeshesCreated = 0;
  function treeMesh(chunk: ChunkView, lod: number): THREE.InstancedMesh {
    let mesh = chunk.trees[lod]!;
    if (!mesh) {
      mesh = new THREE.InstancedMesh(treeGeometries[lod]!, treeMaterial, chunk.treeCount);
      // Все три LOD чанка делят одни и те же буферы матриц и цветов.
      mesh.instanceMatrix = chunk.treeMatrices!;
      mesh.instanceColor = chunk.treeColors!;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = SHADOWS && lod < 2;
      mesh.boundingSphere = new THREE.Sphere(chunk.centre, CHUNK * 0.75 + 16);
      scene.add(mesh);
      chunk.trees[lod] = mesh;
      treeMeshesCreated++;
    }
    return mesh;
  }

  function updateLods(): void {
    const cam = camera.position;
    for (const chunk of chunks) {
      const d = cam.distanceTo(chunk.centre);
      const terrainLod = d < 600 ? 0 : 1;
      if (terrainLod !== chunk.terrainLod) {
        if (terrainLod === 0 && !chunk.near) {
          chunk.near = new THREE.Mesh(terrainGeometry(chunk.cx, chunk.cz, 32), terrainMaterial);
          chunk.near.matrixAutoUpdate = false;
          chunk.near.receiveShadow = SHADOWS;
          scene.add(chunk.near);
        }
        if (chunk.near) chunk.near.visible = terrainLod === 0;
        chunk.far.visible = terrainLod === 1;
        chunk.terrainLod = terrainLod;
      }
      const treeLod = chunk.treeCount === 0 ? -1 : d < 110 ? 0 : d < 450 ? 1 : d < 1800 ? 2 : -1;
      if (treeLod !== chunk.treeLod) {
        if (chunk.treeLod >= 0) chunk.trees[chunk.treeLod]!.visible = false;
        if (treeLod >= 0) treeMesh(chunk, treeLod).visible = true;
        chunk.treeLod = treeLod;
      }
    }
  }

  // Существа: стадо вокруг центра мира, анимация из текстуры со случайной фазой на экземпляр.
  const creature = creatureAssets();
  const creatureMaterial = new VatMaterial({ color: 0xa9774a, roughness: 0.8 });
  const frame = fract(time.mul(1.2).add(hash(instanceIndex))).mul(creature.frames);
  const f0 = floor(frame);
  const f1 = f0.add(1).mod(creature.frames);
  const u = attribute('vertexId', 'float').add(0.5).div(creature.vertices);
  const sample = (f: typeof f0) => texture(creature.vat, vec2(u, f.add(0.5).div(creature.frames))).xyz;
  creatureMaterial.vatPosition = mix(sample(f0), sample(f1), fract(frame).mul(float(1)));
  const creatures = new THREE.InstancedMesh(creature.geometry, creatureMaterial, Math.max(1, CREATURES));
  creatures.count = CREATURES;
  creatures.castShadow = SHADOWS;
  creatures.frustumCulled = false;
  for (let i = 0; i < CREATURES; i++) {
    const angle = hash4(6, i, 0, 0) * INV * 6.283;
    const radius = Math.sqrt(hash4(6, i, 1, 0) * INV) * 380;
    const x = WORLD / 2 + Math.cos(angle) * radius;
    const z = WORLD / 2 + Math.sin(angle) * radius;
    dummy.position.set(x, heightAt(x, z), z);
    dummy.rotation.set(0, hash4(6, i, 2, 0) * INV * 6.283, 0);
    dummy.scale.setScalar(0.9 + hash4(6, i, 3, 0) * INV * 0.4);
    dummy.updateMatrix();
    creatures.setMatrixAt(i, dummy.matrix);
  }
  if (CREATURES > 0) scene.add(creatures);

  // Трава: пучки вокруг камеры на мировой сетке; буфер перезаполняется при смещении камеры.
  const tuft = new THREE.BufferGeometry();
  const blade: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const bx = Math.cos(a) * 0.12;
    const bz = Math.sin(a) * 0.12;
    blade.push(bx - bz * 0.3, 0, bz + bx * 0.3, bx + bz * 0.3, 0, bz - bx * 0.3, bx * 2.2, 0.55, bz * 2.2);
  }
  tuft.setAttribute('position', new THREE.Float32BufferAttribute(blade, 3));
  tuft.computeVertexNormals();
  const grassMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x86b05a, roughness: 0.9, side: THREE.DoubleSide });
  const grass = new THREE.InstancedMesh(tuft, grassMaterial, Math.max(1, GRASS));
  grass.frustumCulled = false;
  grass.count = 0;
  grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (GRASS > 0) scene.add(grass);
  const grassAnchor = new THREE.Vector2(Infinity, Infinity);
  const GRASS_RADIUS = 70;
  const grassStep = Math.sqrt((Math.PI * GRASS_RADIUS * GRASS_RADIUS) / Math.max(1, GRASS));
  function updateGrass(): void {
    if (GRASS === 0) return;
    if (camera.position.y - heightAt(camera.position.x, camera.position.z) > 200) {
      grass.count = 0;
      return;
    }
    const fx = camera.position.x;
    const fz = camera.position.z;
    if (Math.hypot(fx - grassAnchor.x, fz - grassAnchor.y) < 12 && grass.count > 0) return;
    grassAnchor.set(fx, fz);
    const array = grass.instanceMatrix.array as Float32Array;
    const gx0 = Math.floor((fx - GRASS_RADIUS) / grassStep);
    const gz0 = Math.floor((fz - GRASS_RADIUS) / grassStep);
    const span = Math.ceil((GRASS_RADIUS * 2) / grassStep);
    let n = 0;
    for (let iz = 0; iz < span && n < GRASS; iz++) {
      for (let ix = 0; ix < span && n < GRASS; ix++) {
        const gx = gx0 + ix;
        const gz = gz0 + iz;
        const x = (gx + hash4(8, gx, gz, 0) * INV) * grassStep;
        const z = (gz + hash4(8, gx, gz, 1) * INV) * grassStep;
        const dx = x - fx;
        const dz = z - fz;
        if (dx * dx + dz * dz > GRASS_RADIUS * GRASS_RADIUS) continue;
        const s = 0.7 + hash4(8, gx, gz, 2) * INV * 0.9;
        const o = n * 16;
        array.fill(0, o, o + 16);
        array[o] = s;
        array[o + 5] = s;
        array[o + 10] = s;
        array[o + 12] = x;
        array[o + 13] = heightAt(x, z);
        array[o + 14] = z;
        array[o + 15] = 1;
        n++;
      }
    }
    grass.count = n;
    grass.instanceMatrix.needsUpdate = true;
  }

  // ───────── проход камеры ─────────

  const mid = WORLD / 2;
  const segments: { name: string; place(t: number): void }[] = [
    {
      name: 'Стратегический обзор (высота 900 м)',
      place(t) {
        const a = t * 0.5;
        camera.position.set(mid + Math.cos(a) * 1300, 900, mid + Math.sin(a) * 1300);
        camera.lookAt(mid, 0, mid);
      },
    },
    {
      name: 'Средняя высота (120 м), пролёт над лесом',
      place(t) {
        const x = mid - 500 + t * 1000;
        camera.position.set(x, heightAt(x, mid) + 120, mid - 200);
        camera.lookAt(x + 260, heightAt(x + 260, mid), mid + 60);
      },
    },
    {
      name: 'У земли (6 м), стадо и лес вблизи',
      place(t) {
        const a = t * 1.2;
        const x = mid + Math.cos(a) * 150;
        const z = mid + Math.sin(a) * 150;
        camera.position.set(x, heightAt(x, z) + 6, z);
        camera.lookAt(mid, heightAt(mid, mid) + 2, mid);
      },
    },
  ];

  segments[2]!.place(0);
  updateLods();
  updateGrass();
  status.textContent = 'Компиляция шейдеров…';
  await renderer.compileAsync(scene, camera);
  const buildMs = performance.now() - buildStart;

  const results: SegmentResult[] = [];
  const WARM = 1500;
  let segment = 0;
  let segmentStart = performance.now();
  let last = segmentStart;
  let times: number[] = [];
  let info = { drawCalls: 0, triangles: 0 };

  await renderer.setAnimationLoop(() => {
    const now = performance.now();
    const elapsed = now - segmentStart;
    if (segment >= segments.length) return;
    const current = segments[segment]!;
    current.place(elapsed / (SEGMENT_SECONDS * 1000));
    updateLods();
    updateGrass();
    sun.target.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(80));
    sun.target.position.y = heightAt(sun.target.position.x, sun.target.position.z);
    sun.position.copy(sun.target.position).add(new THREE.Vector3(-220, 380, 160));
    renderer.render(scene, camera);
    if (elapsed > WARM) {
      times.push(now - last);
      info = { drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles };
    }
    last = now;
    if (elapsed >= SEGMENT_SECONDS * 1000) {
      const sorted = times.slice().sort((a, b) => a - b);
      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      results.push({
        name: current.name,
        fpsAvg: 1000 / avg,
        frameMsAvg: avg,
        frameMsP99: sorted[Math.floor(sorted.length * 0.99)]!,
        frameMsMax: sorted[sorted.length - 1]!,
        drawCalls: info.drawCalls,
        triangles: Math.round(info.triangles),
      });
      status.textContent = results.map((r) => `${r.name}: ${r.fpsAvg.toFixed(1)} к/с, 1% худших ${r.frameMsP99.toFixed(1)} мс, вызовов ${r.drawCalls}, треугольников ${r.triangles.toLocaleString('ru-RU')}`).join('\n');
      segment++;
      segmentStart = performance.now();
      last = segmentStart;
      times = [];
      if (segment >= segments.length) finish();
    }
  });

  async function finish(): Promise<void> {
    let adapter = 'неизвестно';
    try {
      if (backend === 'webgpu') {
        const a = await navigator.gpu.requestAdapter();
        adapter = [a?.info.vendor, a?.info.architecture, a?.info.description].filter(Boolean).join(' · ');
      } else {
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        if (gl && ext) adapter = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
      }
    } catch {
      // диагностика необязательна
    }
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    window.__renderBench = {
      backend,
      adapter,
      resolution: `${canvas.width}×${canvas.height}`,
      setup: { trees: treesPlaced, creatures: CREATURES, grass: GRASS, shadows: SHADOWS, treeMeshesCreated },
      buildMs,
      heapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
      segments: results,
    };
    status.textContent += `\n\nГотово. ${backend}, ${adapter}`;
  }
}

main().catch((error: unknown) => {
  document.getElementById('status')!.textContent = `Ошибка: ${error instanceof Error ? error.stack : String(error)}`;
  console.error(error);
});
