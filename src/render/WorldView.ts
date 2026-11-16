// Рендер мира. Получает только сообщения протокола из shared и ничего не знает о ядре симуляции.
// Собирает сцену из рельефа (LOD), горизонта, воды, неба, осадков; ведёт камеру и постобработку.
// Время суток и года берётся из тактов снимков и интерполируется между ними.

import * as THREE from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dot, float, mix, pass, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { SNAPSHOT_STRIDE, type FrameSnapshot, type LayerMessage, type SurfaceMessage, type WeatherMessage, type WorldStaticMessage } from '../shared/protocol';
import { dayFraction, yearFraction } from '../shared/time';
import { CameraRig, type CameraMode, type CameraView } from './camera';
import { Precipitation } from './precip';
import { Sky } from './sky';
import { TerrainLod, buildHorizonMesh, terrainMaterial, type TerrainUniforms } from './terrain';
import { buildInlandWater, buildSea } from './water';
import { WorldData } from './worldData';

export type GraphicsBackend = 'webgpu' | 'webgl2';
export type QualityName = 'low' | 'medium' | 'high';

export interface RenderStats {
  backend: GraphicsBackend;
  quality: QualityName;
  fps: number;
  frameMsAvg: number;
  frameMsMax: number;
  /** Кадров дольше 100 мс за окно. */
  longFrames: number;
  drawCalls: number;
  triangles: number;
  agentsDrawn: number;
  terrainNodes: number;
  resolution: string;
}

export interface WorldViewOptions {
  /** Принудительно использовать WebGL 2 даже при доступном WebGPU. */
  forceWebGL: boolean;
  maxAgents: number;
  quality: QualityName;
}

interface Quality {
  pixelRatio: number;
  shadow: number;
  shadowEvery: number;
  bloom: boolean;
  tiltTaps: number;
  lodK: number;
  particles: number;
}

export const QUALITY: Record<QualityName, Quality> = {
  low: { pixelRatio: 0.6, shadow: 0, shadowEvery: 0, bloom: false, tiltTaps: 1, lodK: 1.4, particles: 2500 },
  medium: { pixelRatio: 0.75, shadow: 2048, shadowEvery: 4, bloom: true, tiltTaps: 6, lodK: 1.9, particles: 6000 },
  high: { pixelRatio: 1, shadow: 2048, shadowEvery: 2, bloom: true, tiltTaps: 10, lodK: 2.6, particles: 10000 },
};

interface HeldSnapshot {
  tick: number;
  count: number;
  data: Float32Array;
  arrival: number;
}

interface WeatherView {
  chunks: number;
  rate: Float32Array;
  cloud: Float32Array;
  temperature: Float32Array;
  windX: number;
  windZ: number;
  windSpeed: number;
}

const TWO_PI = Math.PI * 2;
const LOOKUP_SIZE = 1 << 16;
const SEA_EXTENT = 12000;

/** Цветокоррекция по сезону: весна свежая, лето тёплое, осень золотистая, зима холодная и приглушённая. */
const SEASON_GRADE: [THREE.Vector3, number][] = [
  [new THREE.Vector3(1.0, 1.02, 0.98), 1.08],
  [new THREE.Vector3(1.03, 1.01, 0.95), 1.1],
  [new THREE.Vector3(1.07, 0.98, 0.88), 1.06],
  [new THREE.Vector3(0.95, 0.98, 1.05), 0.88],
];

export class WorldView {
  private readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  private readonly sky: Sky;
  private readonly agents: THREE.InstancedMesh;
  private data: WorldData | null = null;
  private terrain: TerrainLod | null = null;
  private worldGroup = new THREE.Group();
  private precip: Precipitation | null = null;
  private labels = new THREE.Group();
  private readonly terrainUniforms: TerrainUniforms = { layerOpacity: uniform(0), worldSize: uniform(4096) };
  private weather: WeatherView | null = null;
  private daysPerSeason = 5;
  private quality: Quality;
  private qualityName: QualityName;
  private pipelineTilt!: THREE.RenderPipeline;
  private pipelinePlain!: THREE.RenderPipeline;
  private readonly tilt = uniform(1);
  private readonly aspect = uniform(1);
  private readonly gradeTint = uniform(new THREE.Vector3(1, 1, 1));
  private readonly gradeSat = uniform(1);
  private prev: HeldSnapshot | null = null;
  private curr: HeldSnapshot | null = null;
  private snapshotInterval = 100;
  private readonly prevRowById = new Int32Array(LOOKUP_SIZE).fill(-1);
  private frameIndex = 0;
  private lastFrame = 0;
  private frames = 0;
  private frameMsSum = 0;
  private frameMsMax = 0;
  private longFrames = 0;
  private statsStart = 0;
  private stats: RenderStats;
  private disposed = false;
  private shadowDirty = true;
  /** Кадров, в которые рисуется второй конвейер: оба компилируются заранее, переключение камеры без рывка. */
  private warmPlain = 2;
  /** Сообщает о каждом кадре — для мини-карты (рамка обзора). */
  onFrame: (() => void) | null = null;

  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly canvas: HTMLCanvasElement,
    readonly backend: GraphicsBackend,
    maxAgents: number,
    qualityName: QualityName,
  ) {
    this.qualityName = qualityName;
    this.quality = QUALITY[qualityName];
    this.stats = { backend, quality: qualityName, fps: 0, frameMsAvg: 0, frameMsMax: 0, longFrames: 0, drawCalls: 0, triangles: 0, agentsDrawn: 0, terrainNodes: 0, resolution: '' };
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    this.sky = new Sky(2048);
    this.sky.light.castShadow = this.quality.shadow > 0;
    this.scene.fog = this.sky.fog;
    this.scene.add(this.sky.group, this.worldGroup, this.labels);
    this.labels.visible = false;

    this.rig = new CameraRig(canvas);
    this.rig.onModeChange = () => (this.shadowDirty = true);

    // Маркер тестового агента (отладка фазы 0): тело + «нос», чтобы был виден курс.
    const body = new THREE.CapsuleGeometry(0.45, 0.9, 4, 10);
    body.translate(0, 0.9, 0);
    const nose = new THREE.ConeGeometry(0.28, 0.8, 8);
    nose.rotateZ(-Math.PI / 2);
    nose.translate(0.75, 1.0, 0);
    const marker = mergeGeometries(body, nose);
    this.agents = new THREE.InstancedMesh(marker, new THREE.MeshStandardNodeMaterial({ color: 0xd9793b, roughness: 0.7 }), maxAgents);
    this.agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.agents.count = 0;
    this.agents.frustumCulled = false;
    this.scene.add(this.agents);

    this.buildPipelines();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  static async create(canvas: HTMLCanvasElement, options: WorldViewOptions): Promise<WorldView> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: options.forceWebGL });
    await renderer.init();
    const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    const view = new WorldView(renderer, canvas, isWebGPU ? 'webgpu' : 'webgl2', options.maxAgents, options.quality);
    view.statsStart = performance.now();
    view.lastFrame = view.statsStart;
    await renderer.setAnimationLoop(view.frame);
    return view;
  }

  private buildPipelines(): void {
    const band = screenUV.y.sub(0.5).abs();
    // Tilt-shift слабый и только у краёв кадра (решение заказчика №10).
    const radius = smoothstep(0.26, 0.5, band).mul(this.tilt).mul(0.005);
    const make = (taps: number): THREE.RenderPipeline => {
      const scenePass = pass(this.scene, this.rig.camera);
      const sceneColor = scenePass.getTextureNode('output');
      let sum = sceneColor.sample(screenUV).rgb;
      for (let i = 1; i < taps; i++) {
        const r = Math.sqrt(i / taps);
        const a = i * 2.39996;
        sum = sum.add(sceneColor.sample(screenUV.add(vec2(float(Math.cos(a) * r).div(this.aspect), Math.sin(a) * r).mul(radius))).rgb);
      }
      let graded = sum.div(taps);
      if (this.quality.bloom) graded = graded.add(bloom(vec4(graded, 1), 0.18, 0.5, 0.95).rgb);
      graded = graded.mul(this.gradeTint);
      const luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      graded = mix(vec3(luma), graded, this.gradeSat);
      const vignette = smoothstep(0.95, 0.35, screenUV.sub(0.5).length());
      return new THREE.RenderPipeline(this.renderer, vec4(graded.mul(mix(float(0.8), float(1), vignette)), 1));
    };
    this.pipelineTilt = make(this.quality.tiltTaps);
    this.pipelinePlain = make(1);
  }

  setQuality(name: QualityName): void {
    if (name === this.qualityName) return;
    this.qualityName = name;
    this.quality = QUALITY[name];
    this.stats.quality = name;
    this.sky.light.castShadow = this.quality.shadow > 0;
    this.terrain?.setCastShadow(this.quality.shadow > 0);
    if (this.terrain) this.terrain.lodK = this.quality.lodK;
    this.pipelineTilt.dispose();
    this.pipelinePlain.dispose();
    this.buildPipelines();
    this.warmPlain = 2;
    this.rebuildPrecip();
    this.resize();
    this.shadowDirty = true;
  }

  private rebuildPrecip(): void {
    if (this.precip) {
      this.scene.remove(this.precip.mesh);
      this.precip.mesh.geometry.dispose();
    }
    this.precip = new Precipitation(this.quality.particles, this.sky.uniforms);
    this.scene.add(this.precip.mesh);
  }

  private readonly resize = (): void => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.rig.camera.aspect = width / height;
    this.rig.camera.updateProjectionMatrix();
    this.aspect.value = width / height;
    this.stats.resolution = `${Math.round(width * this.quality.pixelRatio)}×${Math.round(height * this.quality.pixelRatio)}`;
  };

  // ───────── данные мира ─────────

  setWorld(message: WorldStaticMessage): void {
    this.clearWorld();
    const data = new WorldData(message);
    this.data = data;
    this.daysPerSeason = message.config.daysPerSeason;
    this.terrainUniforms.worldSize.value = data.worldSize;
    const material = terrainMaterial(data, this.terrainUniforms);
    this.terrain = new TerrainLod(data, material);
    this.terrain.lodK = this.quality.lodK;
    this.terrain.setCastShadow(this.quality.shadow > 0);
    this.worldGroup.add(this.terrain.group);
    this.worldGroup.add(buildHorizonMesh(data, material));
    this.worldGroup.add(buildSea(data, this.sky.uniforms, SEA_EXTENT));
    const inland = buildInlandWater(data, this.sky.uniforms);
    if (inland) this.worldGroup.add(inland);
    this.rebuildPrecip();
    this.buildLabels(message);

    this.warmPlain = 2;
    this.rig.bounds = data.worldSize;
    this.rig.ground = (x, z) => data.groundAt(x, z);
    const c = data.worldSize / 2;
    this.rig.setView({ mode: 'strategic', target: [c, Math.max(0, data.groundAt(c, c)), c], yaw: 0.7, pitch: 0.95, distance: data.worldSize * 0.95 });
    this.shadowDirty = true;
  }

  clearWorld(): void {
    this.terrain?.dispose();
    this.terrain = null;
    for (const child of [...this.worldGroup.children]) {
      this.worldGroup.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    for (const label of [...this.labels.children]) {
      this.labels.remove(label);
      if (label instanceof THREE.Sprite) label.material.map?.dispose();
    }
    this.data?.dispose();
    this.data = null;
    this.weather = null;
    this.prev = this.curr = null;
    this.agents.count = 0;
  }

  get hasWorld(): boolean {
    return this.data !== null;
  }

  private buildLabels(message: WorldStaticMessage): void {
    for (const p of message.provinces) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      const font = '600 30px "Segoe UI", system-ui, sans-serif';
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(p.name).width) + 24;
      canvas.width = w;
      canvas.height = 46;
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(25, 22, 16, 0.85)';
      ctx.strokeText(p.name, w / 2, 23);
      ctx.fillStyle = '#fff6e2';
      ctx.fillText(p.name, w / 2, 23);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true, fog: false }));
      sprite.scale.set((w / 46) * 0.035, 0.035, 1);
      sprite.position.set(p.x, Math.max(0, this.data!.groundAt(p.x, p.z)) + 40, p.z);
      sprite.renderOrder = 20;
      this.labels.add(sprite);
    }
  }

  setSurface(message: SurfaceMessage): void {
    if (this.data && message.n === this.data.n) this.data.setSurface(message.data);
  }

  setWeather(message: WeatherMessage): void {
    const view: WeatherView = {
      chunks: message.chunks,
      rate: new Float32Array(message.rate),
      cloud: new Float32Array(message.cloud),
      temperature: new Float32Array(message.temperature),
      windX: message.windX,
      windZ: message.windZ,
      windSpeed: message.windSpeed,
    };
    this.weather = view;
    this.data?.setWeather(view.cloud, view.rate);
  }

  setLayer(message: LayerMessage | null): void {
    if (!this.data) return;
    if (message && message.n === this.data.n) {
      this.data.setLayer(message.image);
      this.terrainUniforms.layerOpacity.value = 0.78;
      this.labels.visible = message.layer === 'provinces';
    } else {
      this.terrainUniforms.layerOpacity.value = 0;
      this.labels.visible = false;
    }
  }

  /** Погода в точке (билинейно по чанкам, как в симуляции). */
  weatherAt(x: number, z: number): { rate: number; cloud: number; temperature: number } | null {
    const w = this.weather;
    const d = this.data;
    if (!w || !d) return null;
    const c = w.chunks;
    const per = d.worldSize / c;
    const fx = THREE.MathUtils.clamp(x / per - 0.5, 0, c - 1.001);
    const fz = THREE.MathUtils.clamp(z / per - 0.5, 0, c - 1.001);
    const ix = Math.min(c - 2, Math.floor(fx));
    const iz = Math.min(c - 2, Math.floor(fz));
    const tx = fx - ix;
    const tz = fz - iz;
    const s = (a: Float32Array) => (a[iz * c + ix]! * (1 - tx) + a[iz * c + ix + 1]! * tx) * (1 - tz) + (a[(iz + 1) * c + ix]! * (1 - tx) + a[(iz + 1) * c + ix + 1]! * tx) * tz;
    const cx = THREE.MathUtils.clamp(Math.floor(x / d.cellSize), 0, d.n - 1);
    const cz = THREE.MathUtils.clamp(Math.floor(z / d.cellSize), 0, d.n - 1);
    return { rate: s(w.rate) * d.precipFactor[cz * d.n + cx]!, cloud: s(w.cloud), temperature: s(w.temperature) };
  }

  // ───────── снимки и время ─────────

  /** Принимает новый снимок. Возвращает буфер, который больше не нужен, — его следует вернуть воркеру. */
  pushSnapshot(snapshot: FrameSnapshot): ArrayBuffer | null {
    const now = performance.now();
    const released = this.prev ? (this.prev.data.buffer as ArrayBuffer) : null;
    if (this.curr) {
      const interval = now - this.curr.arrival;
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

  private alpha(now: number): number {
    return this.curr ? Math.min(1, (now - this.curr.arrival) / this.snapshotInterval) : 0;
  }

  /** Такт для отображения: между двумя последними снимками — плавный ход неба. */
  private renderTick(now: number): number {
    if (!this.curr) return 0;
    if (!this.prev) return this.curr.tick;
    return this.prev.tick + (this.curr.tick - this.prev.tick) * this.alpha(now);
  }

  private updateAgents(now: number): void {
    const curr = this.curr;
    if (!curr) return;
    const prev = this.prev;
    const alpha = this.alpha(now);
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
        let dh = heading - p[po + 4]!;
        dh -= Math.round(dh / TWO_PI) * TWO_PI;
        x = p[po + 1]! + (x - p[po + 1]!) * alpha;
        y = p[po + 2]! + (y - p[po + 2]!) * alpha;
        z = p[po + 3]! + (z - p[po + 3]!) * alpha;
        heading = p[po + 4]! + dh * alpha;
      }
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

  private updateEnvironment(now: number): void {
    const tick = this.renderTick(now);
    const yf = yearFraction(tick, this.daysPerSeason);
    const target = this.rig.target;
    const weather = this.weatherAt(target.x, target.z);
    const camWeather = this.weatherAt(this.rig.camera.position.x, this.rig.camera.position.z) ?? weather;
    const prevDaylight = this.sky.daylight;
    this.sky.update(dayFraction(tick), yf, weather?.cloud ?? 0.1);
    if (Math.abs(prevDaylight - this.sky.daylight) > 0.002) this.shadowDirty = true;
    this.renderer.toneMappingExposure = 0.9 + 0.15 * this.sky.daylight;
    // Сезонная цветокоррекция: плавная смесь соседних сезонов.
    const s = yf * 4;
    const k = Math.floor(s) % 4;
    const t = THREE.MathUtils.smoothstep(s - Math.floor(s), 0.6, 1);
    const a = SEASON_GRADE[k]!;
    const b = SEASON_GRADE[(k + 1) % 4]!;
    this.gradeTint.value.copy(a[0]).lerp(b[0], t);
    this.gradeSat.value = THREE.MathUtils.lerp(a[1], b[1], t);
    if (this.precip && camWeather && this.weather) {
      this.precip.update(this.rig.camera, camWeather.rate, camWeather.temperature, this.weather.windX, this.weather.windZ, this.weather.windSpeed, this.rig.altitude());
    }
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    this.frames++;
    this.frameMsSum += frameMs;
    if (frameMs > this.frameMsMax) this.frameMsMax = frameMs;
    if (frameMs > 100) this.longFrames++;
    this.frameIndex++;

    this.rig.update(Math.min(0.1, frameMs / 1000));
    const strategic = this.rig.mode === 'strategic';
    this.tilt.value += ((strategic ? 1 : 0) - this.tilt.value) * 0.1;
    if (this.data) {
      this.terrain?.update(this.rig.camera.position);
      this.updateEnvironment(now);
      this.sky.follow(this.rig.target, this.rig.camera.position, this.rig.distance);
      this.sky.updateFog(this.rig.distance, this.rig.altitude(), this.rig.camera.far);
      this.updateAgents(now);
      const every = this.quality.shadowEvery;
      if (this.quality.shadow > 0 && (this.shadowDirty || (every > 0 && this.frameIndex % every === 0))) {
        this.sky.light.shadow.needsUpdate = true;
        this.shadowDirty = false;
      }
    } else {
      this.sky.update(0.45, 0.3, 0.2);
      this.sky.follow(this.rig.target, this.rig.camera.position, 1000);
      this.sky.updateFog(1000, 100, this.rig.camera.far);
    }
    if (this.warmPlain > 0) {
      this.warmPlain--;
      (this.tilt.value > 0.02 ? this.pipelinePlain : this.pipelineTilt).render();
    } else (this.tilt.value > 0.02 ? this.pipelineTilt : this.pipelinePlain).render();
    this.onFrame?.();

    if (now - this.statsStart >= 500) {
      const info = this.renderer.info.render;
      this.stats = {
        ...this.stats,
        fps: (this.frames * 1000) / (now - this.statsStart),
        frameMsAvg: this.frameMsSum / this.frames,
        frameMsMax: this.frameMsMax,
        longFrames: this.longFrames,
        drawCalls: info.drawCalls,
        triangles: info.triangles,
        terrainNodes: this.terrain?.nodesDrawn ?? 0,
      };
      this.statsStart = now;
      this.frames = 0;
      this.frameMsSum = 0;
      this.frameMsMax = 0;
      this.longFrames = 0;
    }
  };

  // ───────── камера ─────────

  setCameraMode(mode: CameraMode): void {
    this.rig.setMode(mode);
  }

  setView(view: Partial<CameraView>): void {
    const before = this.rig.target.clone();
    this.rig.setView(view);
    // Плавное ведение камеры не требует внеочередного обновления теней — только скачок.
    if (before.distanceTo(this.rig.target) > 200) this.shadowDirty = true;
  }

  getStats(): RenderStats {
    return this.stats;
  }

  /** Интерполированное положение первых сущностей — для автоматических проверок плавности. */
  sampleAgentPositions(limit: number): number[] {
    const matrices = this.agents.instanceMatrix.array as Float32Array;
    const out: number[] = [];
    for (let row = 0; row < Math.min(limit, this.agents.count); row++) out.push(matrices[row * 16 + 12]!, matrices[row * 16 + 14]!);
    return out;
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    void this.renderer.setAnimationLoop(null);
    this.clearWorld();
    this.renderer.dispose();
  }
}

/** Склеивает две геометрии с атрибутами position и normal. */
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
