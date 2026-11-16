// Прототип 1A — визуальная цель WORLDBOUND. Отдельная страница, не затрагивающая каркас игры:
//   /prototypes/diorama/index.html?quality=medium&renderer=webgl2&time=18.2&mode=free
// Диорама 150×150 м: рельеф со скальным срезом, река и водопад, три вида деревьев, трава и цветы,
// дом, олени и житель, цикл дня и ночи, тени, туман, tilt-shift в стратегическом режиме.

import * as THREE from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dot, float, mix, pass, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { Actor} from './creatures';
import { loadCreatures, type Creatures } from './creatures';
import { buildFlora } from './flora';
import { buildHouse } from './house';
import { Puffs, puffTexture } from './kit';
import { HALF, HOUSE, heightAt } from './layout';
import { Sky } from './sky';
import { buildTerrain, buildWater, waterfallFoot } from './terrain';

type QualityName = 'low' | 'medium' | 'high';
type Mode = 'strategic' | 'free';

interface Quality {
  pixelRatio: number;
  antialias: boolean;
  shadow: number;
  terrainStep: number;
  grass: number;
  flowers: number;
  leafDensity: number;
  bloom: boolean;
  tiltTaps: number;
  /** Карта теней обновляется раз в столько кадров. */
  shadowEvery: number;
}

const QUALITY: Record<QualityName, Quality> = {
  low: { pixelRatio: 0.55, antialias: false, shadow: 1024, terrainStep: 1.0, grass: 8000, flowers: 800, leafDensity: 0.55, bloom: false, tiltTaps: 6, shadowEvery: 6 },
  medium: { pixelRatio: 0.75, antialias: false, shadow: 2048, terrainStep: 0.9, grass: 18000, flowers: 1600, leafDensity: 0.85, bloom: true, tiltTaps: 8, shadowEvery: 4 },
  high: { pixelRatio: 1, antialias: true, shadow: 2048, terrainStep: 0.75, grass: 34000, flowers: 3000, leafDensity: 1.1, bloom: true, tiltTaps: 14, shadowEvery: 2 },
};

const params = new URLSearchParams(location.search);
const qualityName = (['low', 'medium', 'high'].includes(params.get('quality') ?? '') ? params.get('quality') : 'medium') as QualityName;
const quality: Quality = { ...QUALITY[qualityName] };
// Переопределения для профилирования: ?pr=0.7&aa=0&shadow=0&bloom=0&taps=1&grass=0&every=1&post=0&lights=0
const override = (name: string): number | null => (params.has(name) ? Number(params.get(name)) : null);
quality.pixelRatio = override('pr') ?? quality.pixelRatio;
quality.antialias = (override('aa') ?? (quality.antialias ? 1 : 0)) === 1;
quality.shadow = override('shadow') ?? quality.shadow;
quality.bloom = (override('bloom') ?? (quality.bloom ? 1 : 0)) === 1;
quality.tiltTaps = override('taps') ?? quality.tiltTaps;
quality.grass = override('grass') ?? quality.grass;
quality.shadowEvery = override('every') ?? quality.shadowEvery;
const usePost = override('post') !== 0;
const useLights = override('lights') !== 0;

export interface DioramaStats {
  backend: string;
  quality: QualityName;
  resolution: string;
  fps: number;
  frameMs: number;
  frameMsP99: number;
  drawCalls: number;
  triangles: number;
  buildMs: number;
}

export interface DioramaApi {
  ready: boolean;
  stats(): DioramaStats;
  resetStats(): void;
  setHour(hour: number): void;
  setAuto(on: boolean): void;
  setMode(mode: Mode): void;
  focus(name: string): void;
  /** Мгновенно ставит камеру: цель, курс, наклон (рад), дистанция. */
  setView(view: { target: [number, number, number]; yaw: number; pitch: number; distance: number }): void;
  hideUi(hidden: boolean): void;
  /** Текущее состояние камеры — для автоматической проверки управления. */
  view(): { mode: Mode; target: [number, number, number]; yaw: number; pitch: number; distance: number };
}

declare global {
  interface Window {
    __diorama?: DioramaApi;
  }
}

// ───────── камера ─────────

class CameraRig {
  mode: Mode = 'strategic';
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.3, 4000);
  readonly target = new THREE.Vector3(0, 3, 0);
  yaw = 0.62;
  pitch = 0.72;
  distance = 300;
  follow: Actor | null = null;
  private readonly goalTarget = new THREE.Vector3(0, 3, 0);
  private goalYaw = 0.62;
  private goalPitch = 0.72;
  private goalDistance = 300;
  private fov = 30;
  private readonly keys = new Set<string>();

  constructor(canvas: HTMLCanvasElement) {
    let button = -1;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      button = e.button;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      button = -1;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (button < 0) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const rotate = (this.mode === 'strategic') === (button === 2);
      if (rotate) {
        this.goalYaw -= dx * 0.005;
        this.goalPitch += dy * 0.004;
      } else {
        this.pan(-dx, -dy, (this.goalDistance * 0.0016 * this.fov) / 30);
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.goalDistance *= Math.exp(e.deltaY * 0.0011);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  /** Сдвиг цели в плоскости земли: right/forward заданы относительно взгляда камеры. */
  private pan(right: number, forward: number, scale: number): void {
    this.follow = null;
    const sin = Math.sin(this.goalYaw);
    const cos = Math.cos(this.goalYaw);
    this.goalTarget.x += (right * cos + forward * sin) * scale;
    this.goalTarget.z += (-right * sin + forward * cos) * scale;
  }

  setMode(mode: Mode, keepView = false): void {
    this.mode = mode;
    if (keepView) return;
    if (mode === 'strategic') {
      this.follow = null;
      this.goalPitch = 0.72;
      this.goalDistance = Math.max(this.goalDistance, 200);
    } else {
      this.goalPitch = 0.28;
      this.goalDistance = Math.min(this.goalDistance, 34);
    }
  }

  goTo(target: THREE.Vector3, yaw: number, pitch: number, distance: number, follow: Actor | null = null): void {
    this.goalTarget.copy(target);
    this.goalYaw = yaw;
    this.goalPitch = pitch;
    this.goalDistance = distance;
    this.follow = follow;
  }

  snap(): void {
    this.target.copy(this.goalTarget);
    this.yaw = this.goalYaw;
    this.pitch = this.goalPitch;
    this.distance = this.goalDistance;
    this.fov = this.mode === 'strategic' ? 30 : 46;
  }

  update(dt: number): void {
    const strategic = this.mode === 'strategic';
    const move = dt * (strategic ? 0.45 : 0.9) * Math.max(8, this.goalDistance);
    const k = this.keys;
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const kz = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    if (kx !== 0 || kz !== 0) this.pan(kx, kz, move);
    this.goalYaw += ((k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0)) * dt * 1.2;

    if (this.follow) this.goalTarget.copy(this.follow.focus);
    this.goalTarget.x = THREE.MathUtils.clamp(this.goalTarget.x, -HALF, HALF);
    this.goalTarget.z = THREE.MathUtils.clamp(this.goalTarget.z, -HALF, HALF);
    if (!this.follow) this.goalTarget.y = heightAt(this.goalTarget.x, this.goalTarget.z) + (strategic ? 1 : 1.4);
    this.goalPitch = THREE.MathUtils.clamp(this.goalPitch, strategic ? 0.5 : 0.05, strategic ? 1.2 : 1.45);
    this.goalDistance = THREE.MathUtils.clamp(this.goalDistance, strategic ? 60 : 3, strategic ? 420 : 150);

    const ease = 1 - Math.exp(-dt * 7);
    this.target.lerp(this.goalTarget, ease);
    this.yaw += (this.goalYaw - this.yaw) * ease;
    this.pitch += (this.goalPitch - this.pitch) * ease;
    this.distance += (this.goalDistance - this.distance) * ease;
    this.fov += ((strategic ? 30 : 46) - this.fov) * ease;

    const cosP = Math.cos(this.pitch);
    const cam = this.camera;
    cam.position.set(this.target.x + Math.sin(this.yaw) * cosP * this.distance, this.target.y + Math.sin(this.pitch) * this.distance, this.target.z + Math.cos(this.yaw) * cosP * this.distance);
    if (Math.abs(cam.position.x) < HALF && Math.abs(cam.position.z) < HALF) {
      cam.position.y = Math.max(cam.position.y, heightAt(cam.position.x, cam.position.z) + 0.7);
    }
    cam.lookAt(this.target);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}

// ───────── запуск ─────────

async function main(): Promise<void> {
  const loading = document.getElementById('loading')!;
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const started = performance.now();

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: quality.antialias, forceWebGL: params.get('renderer') === 'webgl2' });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = quality.shadow > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const sky = new Sky(quality.shadow);
  scene.fog = sky.fog;
  scene.add(sky.group);
  scene.add(buildTerrain(quality.terrainStep));
  scene.add(buildWater(sky.uniforms));
  scene.add(buildFlora(quality, sky.uniforms));
  const house = buildHouse(sky.uniforms);
  scene.add(house.group);

  const puff = puffTexture();
  const smoke = new Puffs(puff, { count: 14, source: house.chimneyTop, spread: 0.12, velocity: new THREE.Vector3(0.22, 1.15, 0.1), drift: 0.9, life: 7.5, sizeStart: 0.7, sizeEnd: 4.2, opacity: 0.55, color: new THREE.Color(0xd9d5cd) });
  const mist = new Puffs(puff, { count: 10, source: waterfallFoot(), spread: 1.5, velocity: new THREE.Vector3(0, 0.75, 0), drift: 0.8, life: 3.4, sizeStart: 1.3, sizeEnd: 4.4, opacity: 0.34, color: new THREE.Color(0xffffff) });
  scene.add(smoke.group, mist.group);

  loading.textContent = 'Загрузка моделей…';
  const creatures: Creatures = await loadCreatures('/');
  scene.add(creatures.group);

  const rig = new CameraRig(canvas);
  const camera = rig.camera;

  // ── Постобработка: tilt-shift (стратегический режим), свечение, виньетка ──
  const tilt = uniform(1);
  const aspect = uniform(1);
  const band = screenUV.y.sub(0.5).abs();
  const radius = smoothstep(0.11, 0.5, band).mul(tilt).mul(0.012);
  const output = (taps: number): THREE.RenderPipeline => {
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode('output');
    let sum = sceneColor.sample(screenUV).rgb;
    for (let i = 1; i < taps; i++) {
      // Спираль золотого угла: равномерное покрытие круга малым числом выборок.
      const r = Math.sqrt(i / taps);
      const a = i * 2.39996;
      sum = sum.add(sceneColor.sample(screenUV.add(vec2(float(Math.cos(a) * r).div(aspect), Math.sin(a) * r).mul(radius))).rgb);
    }
    let graded = sum.div(taps);
    if (quality.bloom) graded = graded.add(bloom(vec4(graded, 1), 0.2, 0.55, 0.95).rgb);
    const luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
    graded = mix(vec3(luma), graded, 1.12);
    const vignette = smoothstep(0.95, 0.35, screenUV.sub(0.5).length());
    return new THREE.RenderPipeline(renderer, vec4(graded.mul(mix(float(0.78), float(1), vignette)), 1));
  };
  // Два конвейера: с размытием (стратегический режим) и без него — в свободном режиме выборки не тратятся.
  // Оба компилируются при запуске, поэтому переключение режима не вызывает рывка.
  const pipelineTilt = output(quality.tiltTaps);
  const pipelinePlain = output(1);

  const resize = (): void => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    // Доля от размера окна в CSS-пикселях: пресет задаёт фактическое разрешение отрисовки.
    renderer.setPixelRatio(quality.pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    aspect.value = width / height;
  };
  resize();
  window.addEventListener('resize', resize);

  // ── Управление ──
  let auto = params.get('auto') === '1';
  let shadowDirty = true;
  let frame = 0;
  const hourInput = document.getElementById('hour') as HTMLInputElement;
  const clock = document.getElementById('clock')!;
  const playButton = document.getElementById('play')!;
  const setHour = (hour: number): void => {
    sky.setHour(hour);
    hourInput.value = String(sky.hour);
    clock.textContent = `${String(Math.floor(sky.hour)).padStart(2, '0')}:${String(Math.floor((sky.hour % 1) * 60)).padStart(2, '0')}`;
    for (const { light, power } of house.lights) light.intensity = useLights ? power * sky.uniforms.night.value : 0;
    shadowDirty = true;
    renderer.toneMappingExposure = 0.92 + 0.12 * sky.daylight;
    smoke.tint.copy(sky.uniforms.ambient.value);
    mist.tint.copy(sky.uniforms.ambient.value);
  };
  const setAuto = (on: boolean): void => {
    auto = on;
    playButton.classList.toggle('on', on);
    playButton.textContent = on ? '❚❚' : '▶';
  };
  const markButtons = (): void => {
    document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === rig.mode));
    document.querySelectorAll<HTMLButtonElement>('#quality button').forEach((b) => b.classList.toggle('on', b.dataset.quality === qualityName));
  };
  const setMode = (mode: Mode, keepView = false): void => {
    rig.setMode(mode, keepView);
    markButtons();
  };
  const focus = (name: string): void => {
    const foot = waterfallFoot();
    switch (name) {
      case 'house':
        setMode('free', true);
        rig.goTo(new THREE.Vector3(HOUSE.x, HOUSE.y + 2.4, HOUSE.z), HOUSE.yaw + 0.55, 0.2, 21);
        break;
      case 'waterfall':
        setMode('free', true);
        rig.goTo(new THREE.Vector3(foot.x - 1, foot.y + 4.2, foot.z - 1), 0.95, 0.16, 27);
        break;
      case 'stag':
        setMode('free', true);
        rig.goTo(creatures.stag.focus, creatures.stag.heading + 0.85, 0.14, 8.5, creatures.stag);
        break;
      case 'doe':
        setMode('free', true);
        rig.goTo(creatures.doe.focus, creatures.doe.heading - 0.9, 0.16, 9, creatures.doe);
        break;
      case 'farmer':
        setMode('free', true);
        rig.goTo(creatures.farmer.focus, creatures.farmer.heading + 0.7, 0.15, 6.2, creatures.farmer);
        break;
      default:
        setMode('strategic', true);
        rig.goTo(new THREE.Vector3(0, 3, 0), 0.62, 0.72, 262);
    }
  };
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));
  document.querySelectorAll<HTMLButtonElement>('#focus button').forEach((b) => b.addEventListener('click', () => focus(b.dataset.focus!)));
  document.querySelectorAll<HTMLButtonElement>('#quality button').forEach((b) =>
    b.addEventListener('click', () => {
      const next = new URLSearchParams(location.search);
      next.set('quality', b.dataset.quality!);
      location.search = next.toString();
    }),
  );
  hourInput.addEventListener('input', () => setHour(Number(hourInput.value)));
  playButton.addEventListener('click', () => setAuto(!auto));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') {
      e.preventDefault();
      setMode(rig.mode === 'strategic' ? 'free' : 'strategic');
    } else if (e.code === 'KeyH') {
      document.body.classList.toggle('clean');
    }
  });

  setHour(Number(params.get('time') ?? 10.5));
  setAuto(auto);
  if (params.get('mode') === 'free') focus('house');
  else focus('overview');
  rig.snap();
  markButtons();
  if (params.get('ui') === '0') document.body.classList.add('clean');

  loading.textContent = 'Компиляция шейдеров…';
  rig.update(0);
  await renderer.compileAsync(scene, camera);
  // Прогрев: по одному кадру каждым конвейером, чтобы шейдеры постобработки и теней собрались до показа.
  if (usePost) {
    pipelinePlain.render();
    pipelineTilt.render();
  }
  const buildMs = performance.now() - started;

  // ── Кадр ──
  const statsPanel = document.getElementById('stats')!;
  const frameTimes: number[] = [];
  let last = performance.now();
  let statsShown = 0;
  let info = { drawCalls: 0, triangles: 0 };
  const stats = (): DioramaStats => {
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    return {
      backend,
      quality: qualityName,
      resolution: `${canvas.width}×${canvas.height}`,
      fps: avg > 0 ? 1000 / avg : 0,
      frameMs: avg,
      frameMsP99: sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]! : 0,
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      buildMs,
    };
  };

  await renderer.setAnimationLoop(() => {
    const now = performance.now();
    const frameMs = now - last;
    last = now;
    const dt = Math.min(0.1, frameMs / 1000);
    frameTimes.push(frameMs);
    if (frameTimes.length > 600) frameTimes.shift();

    if (auto) setHour(sky.hour + dt * (24 / 96));
    for (const actor of creatures.all) actor.update(dt);
    smoke.update(dt, 0.5);
    mist.update(dt, 0);
    rig.update(dt);
    sky.updateFog(rig.distance);
    sky.dome.position.copy(camera.position);
    tilt.value += ((rig.mode === 'strategic' ? 1 : 0) - tilt.value) * (1 - Math.exp(-dt * 5));
    const wantTilt = rig.mode === 'strategic' || tilt.value > 0.03;
    if (quality.shadow > 0 && (shadowDirty || frame % quality.shadowEvery === 0)) {
      sky.light.shadow.needsUpdate = true;
      shadowDirty = false;
    }
    frame++;

    if (!usePost) renderer.render(scene, camera);
    else if (wantTilt) pipelineTilt.render();
    else pipelinePlain.render();
    info = { drawCalls: renderer.info.render.drawCalls, triangles: Math.round(renderer.info.render.triangles) };

    if (now - statsShown > 500) {
      statsShown = now;
      const s = stats();
      statsPanel.textContent = `${backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${s.resolution}\n${s.fps.toFixed(0)} к/с · ${s.frameMs.toFixed(1)} мс\nВызовов отрисовки: ${s.drawCalls}\nТреугольников: ${s.triangles.toLocaleString('ru-RU')}`;
    }
  });

  loading.hidden = true;
  for (const id of ['controls', 'stats', 'help']) document.getElementById(id)!.hidden = false;

  window.__diorama = {
    ready: true,
    stats,
    resetStats: () => {
      frameTimes.length = 0;
    },
    setHour,
    setAuto,
    setMode: (mode) => setMode(mode),
    focus: (name) => {
      focus(name);
      rig.snap();
    },
    setView: (view) => {
      rig.goTo(new THREE.Vector3(...view.target), view.yaw, view.pitch, view.distance);
      rig.snap();
    },
    hideUi: (hidden) => document.body.classList.toggle('clean', hidden),
    view: () => ({ mode: rig.mode, target: [rig.target.x, rig.target.y, rig.target.z], yaw: rig.yaw, pitch: rig.pitch, distance: rig.distance }),
  };
}

main().catch((error: unknown) => {
  const loading = document.getElementById('loading')!;
  loading.hidden = false;
  loading.textContent = `Не удалось построить диораму:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  console.error(error);
});
