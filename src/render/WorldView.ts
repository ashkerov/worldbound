// Рендер мира. Получает только сообщения протокола из shared и ничего не знает
// о ядре симуляции. Между двумя последними снимками состояние интерполируется,
// поэтому 10 тактов/с выглядят плавно при любой частоте кадров.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SNAPSHOT_STRIDE, type FrameSnapshot, type TerrainMessage } from '../shared/protocol';

export type GraphicsBackend = 'webgpu' | 'webgl2';

export interface RenderStats {
  backend: GraphicsBackend;
  fps: number;
  frameMsAvg: number;
  frameMsMax: number;
  drawCalls: number;
  triangles: number;
  agentsDrawn: number;
}

export interface WorldViewOptions {
  /** Принудительно использовать WebGL 2 даже при доступном WebGPU. */
  forceWebGL: boolean;
  maxAgents: number;
}

interface HeldSnapshot {
  tick: number;
  count: number;
  data: Float32Array;
  arrival: number;
}

const TWO_PI = Math.PI * 2;
const LOOKUP_SIZE = 1 << 16;

export class WorldView {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
  private readonly controls: OrbitControls;
  private terrainMesh: THREE.Mesh | null = null;
  private readonly agents: THREE.InstancedMesh;
  private prev: HeldSnapshot | null = null;
  private curr: HeldSnapshot | null = null;
  private snapshotInterval = 100;
  private readonly prevRowById = new Int32Array(LOOKUP_SIZE).fill(-1);

  private lastFrame = 0;
  private frames = 0;
  private frameMsSum = 0;
  private frameMsMax = 0;
  private statsStart = 0;
  private stats: RenderStats;
  private disposed = false;

  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly canvas: HTMLCanvasElement,
    readonly backend: GraphicsBackend,
    maxAgents: number,
  ) {
    this.stats = { backend, fps: 0, frameMsAvg: 0, frameMsMax: 0, drawCalls: 0, triangles: 0, agentsDrawn: 0 };

    this.scene.background = new THREE.Color(0x9fc4dd);
    this.scene.fog = new THREE.Fog(0x9fc4dd, 500, 1800);
    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x4a5a3a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
    sun.position.set(-300, 500, 200);
    this.scene.add(sun);

    this.camera.position.set(-120, 220, -120);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 1500;

    // Маркер тестового агента: тело + «нос», чтобы был виден курс. Локальная ось +X — вперёд.
    const body = new THREE.CapsuleGeometry(0.45, 0.9, 4, 10);
    body.translate(0, 0.9, 0);
    const nose = new THREE.ConeGeometry(0.28, 0.8, 8);
    nose.rotateZ(-Math.PI / 2);
    nose.translate(0.75, 1.0, 0);
    const marker = mergeGeometries(body, nose);
    const markerMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xd9793b, roughness: 0.7 });
    this.agents = new THREE.InstancedMesh(marker, markerMaterial, maxAgents);
    this.agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.agents.count = 0;
    this.agents.frustumCulled = false;
    this.scene.add(this.agents);

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  static async create(canvas: HTMLCanvasElement, options: WorldViewOptions): Promise<WorldView> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: options.forceWebGL });
    await renderer.init();
    const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    const view = new WorldView(renderer, canvas, isWebGPU ? 'webgpu' : 'webgl2', options.maxAgents);
    view.statsStart = performance.now();
    view.lastFrame = view.statsStart;
    await renderer.setAnimationLoop(view.frame);
    return view;
  }

  private readonly resize = (): void => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  setTerrain(terrain: TerrainMessage): void {
    const { samples, spacing } = terrain;
    const heights = new Float32Array(terrain.heights);
    const positions = new Float32Array(samples * samples * 3);
    const colors = new Float32Array(samples * samples * 3);
    let min = Infinity;
    let max = -Infinity;
    for (const h of heights) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    const low = new THREE.Color(0x5f8f4a);
    const high = new THREE.Color(0xa9b46a);
    const tint = new THREE.Color();
    for (let iz = 0; iz < samples; iz++) {
      for (let ix = 0; ix < samples; ix++) {
        const i = iz * samples + ix;
        const h = heights[i]!;
        positions[i * 3] = ix * spacing;
        positions[i * 3 + 1] = h;
        positions[i * 3 + 2] = iz * spacing;
        tint.copy(low).lerp(high, max > min ? (h - min) / (max - min) : 0);
        colors[i * 3] = tint.r;
        colors[i * 3 + 1] = tint.g;
        colors[i * 3 + 2] = tint.b;
      }
    }
    const cells = samples - 1;
    const indices = new Uint32Array(cells * cells * 6);
    let o = 0;
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const a = iz * samples + ix;
        const b = a + 1;
        const c = a + samples;
        const d = c + 1;
        indices[o++] = a;
        indices[o++] = c;
        indices[o++] = b;
        indices[o++] = b;
        indices[o++] = c;
        indices[o++] = d;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 });
    this.terrainMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.terrainMesh);

    const size = cells * spacing;
    const centre = new THREE.Vector3(size / 2, 0, size / 2);
    this.controls.target.copy(centre);
    this.camera.position.set(centre.x - size * 0.42, size * 0.38, centre.z - size * 0.42);
    this.controls.update();
  }

  /** Принимает новый снимок. Возвращает буфер, который больше не нужен, — его следует вернуть воркеру. */
  pushSnapshot(snapshot: FrameSnapshot): ArrayBuffer | null {
    const now = performance.now();
    const released = this.prev ? (this.prev.data.buffer as ArrayBuffer) : null;
    if (this.curr) {
      const interval = now - this.curr.arrival;
      // Сглаженная оценка интервала между снимками — длительность интерполяции.
      this.snapshotInterval += (Math.min(Math.max(interval, 4), 250) - this.snapshotInterval) * 0.25;
    }
    this.prev = this.curr;
    this.curr = { tick: snapshot.tick, count: snapshot.count, data: new Float32Array(snapshot.buffer), arrival: now };

    this.prevRowById.fill(-1);
    if (this.prev) {
      const data = this.prev.data;
      for (let row = 0; row < this.prev.count; row++) {
        const id = data[row * SNAPSHOT_STRIDE]!;
        if (id < LOOKUP_SIZE) this.prevRowById[id] = row;
      }
    }
    return released;
  }

  private updateAgents(now: number): void {
    const curr = this.curr;
    if (!curr) return;
    const prev = this.prev;
    const alpha = Math.min(1, (now - curr.arrival) / this.snapshotInterval);
    const matrices = this.agents.instanceMatrix.array as Float32Array;
    const count = Math.min(curr.count, this.agents.instanceMatrix.count);
    const c = curr.data;
    for (let row = 0; row < count; row++) {
      const o = row * SNAPSHOT_STRIDE;
      let x = c[o + 1]!;
      let y = c[o + 2]!;
      let z = c[o + 3]!;
      let heading = c[o + 4]!;
      const id = c[o]!;
      const prevRow = prev && id < LOOKUP_SIZE ? this.prevRowById[id]! : -1;
      if (prev && prevRow >= 0) {
        const p = prev.data;
        const po = prevRow * SNAPSHOT_STRIDE;
        const px = p[po + 1]!;
        const py = p[po + 2]!;
        const pz = p[po + 3]!;
        let dh = heading - p[po + 4]!;
        dh -= Math.round(dh / TWO_PI) * TWO_PI;
        x = px + (x - px) * alpha;
        y = py + (y - py) * alpha;
        z = pz + (z - pz) * alpha;
        heading = p[po + 4]! + dh * alpha;
      }
      // Поворот вокруг Y на −heading: локальная +X смотрит вдоль (cos h, 0, sin h).
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const m = row * 16;
      matrices[m] = cos;
      matrices[m + 1] = 0;
      matrices[m + 2] = sin;
      matrices[m + 3] = 0;
      matrices[m + 4] = 0;
      matrices[m + 5] = 1;
      matrices[m + 6] = 0;
      matrices[m + 7] = 0;
      matrices[m + 8] = -sin;
      matrices[m + 9] = 0;
      matrices[m + 10] = cos;
      matrices[m + 11] = 0;
      matrices[m + 12] = x;
      matrices[m + 13] = y;
      matrices[m + 14] = z;
      matrices[m + 15] = 1;
    }
    this.agents.count = count;
    this.agents.instanceMatrix.needsUpdate = true;
    this.stats.agentsDrawn = count;
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    this.frames++;
    this.frameMsSum += frameMs;
    if (frameMs > this.frameMsMax) this.frameMsMax = frameMs;

    this.controls.update();
    this.updateAgents(now);
    this.renderer.render(this.scene, this.camera);

    if (now - this.statsStart >= 500) {
      const info = this.renderer.info.render;
      this.stats = {
        backend: this.backend,
        fps: (this.frames * 1000) / (now - this.statsStart),
        frameMsAvg: this.frameMsSum / this.frames,
        frameMsMax: this.frameMsMax,
        drawCalls: info.drawCalls,
        triangles: info.triangles,
        agentsDrawn: this.stats.agentsDrawn,
      };
      this.statsStart = now;
      this.frames = 0;
      this.frameMsSum = 0;
      this.frameMsMax = 0;
    }
  };

  getStats(): RenderStats {
    return this.stats;
  }

  /** Интерполированное положение первых сущностей — для автоматических проверок плавности. */
  sampleAgentPositions(limit: number): number[] {
    const matrices = this.agents.instanceMatrix.array as Float32Array;
    const out: number[] = [];
    for (let row = 0; row < Math.min(limit, this.agents.count); row++) {
      out.push(matrices[row * 16 + 12]!, matrices[row * 16 + 14]!);
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    void this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

/** Склеивает две неиндексированные/индексированные геометрии с атрибутами position и normal. */
function mergeGeometries(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const parts = [a.toNonIndexed(), b.toNonIndexed()];
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal'] as const) {
    const arrays = parts.map((p) => p.getAttribute(name).array as Float32Array);
    const joined = new Float32Array(arrays.reduce((n, arr) => n + arr.length, 0));
    let offset = 0;
    for (const arr of arrays) {
      joined.set(arr, offset);
      offset += arr.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(joined, 3));
  }
  return merged;
}
