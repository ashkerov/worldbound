// Небо, солнце и луна, цикл дня и ночи, туман. Все цвета сцены, зависящие от времени суток,
// идут через униформы SkyUniforms — материалы подхватывают их без пересборки шейдеров.

import * as THREE from 'three/webgpu';
import { dot, float, floor, fract, hash, mix, mx_fractal_noise_float, normalize, positionLocal, pow, saturate, smoothstep, time, uniform, vec3 } from 'three/tsl';

const colorUniform = (hex = 0xffffff) => uniform(new THREE.Color(hex));
const vectorUniform = () => uniform(new THREE.Vector3(0, 1, 0));
const floatUniform = (value: number) => uniform(value);
type ColorUniform = ReturnType<typeof colorUniform>;
type VectorUniform = ReturnType<typeof vectorUniform>;
type FloatUniform = ReturnType<typeof floatUniform>;

export interface SkyUniforms {
  zenith: ColorUniform;
  horizon: ColorUniform;
  haze: ColorUniform;
  /** Общий оттенок освещённости — для неосвещаемых материалов (пена, дым). */
  ambient: ColorUniform;
  sunColor: ColorUniform;
  sunDir: VectorUniform;
  moonDir: VectorUniform;
  sunStrength: FloatUniform;
  stars: FloatUniform;
  /** 0 днём → 1 ночью: свечение окон и фонаря. */
  night: FloatUniform;
  cloud: ColorUniform;
}

interface Key {
  zenith: number;
  horizon: number;
  haze: number;
  ambient: number;
  cloud: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  fogNear: number;
  fogFar: number;
}

const NIGHT: Key = { zenith: 0x060a1c, horizon: 0x1b2a4d, haze: 0x0f1830, ambient: 0x39486e, cloud: 0x26324f, hemiSky: 0x4a5e9c, hemiGround: 0x1c2438, hemi: 0.85, fogNear: 70, fogFar: 430 };
const DUSK: Key = { zenith: 0x35488f, horizon: 0xffa868, haze: 0x9a6f6e, ambient: 0xd9a58a, cloud: 0xffb58a, hemiSky: 0xe3bcc0, hemiGround: 0x7a6c70, hemi: 1.2, fogNear: 60, fogFar: 360 };
const DAY: Key = { zenith: 0x3d86d8, horizon: 0xcfe7f6, haze: 0x93aebf, ambient: 0xffffff, cloud: 0xffffff, hemiSky: 0xcfe6ff, hemiGround: 0x74804f, hemi: 0.82, fogNear: 110, fogFar: 560 };

const ca = new THREE.Color();
const cb = new THREE.Color();
function blend(target: THREE.Color, a: number, b: number, t: number): THREE.Color {
  return target.copy(ca.set(a)).lerp(cb.set(b), t);
}

export class Sky {
  readonly uniforms: SkyUniforms = {
    zenith: colorUniform(),
    horizon: colorUniform(),
    haze: colorUniform(),
    ambient: colorUniform(),
    sunColor: colorUniform(),
    sunDir: vectorUniform(),
    moonDir: vectorUniform(),
    sunStrength: floatUniform(1),
    stars: floatUniform(0),
    night: floatUniform(0),
    cloud: colorUniform(),
  };
  readonly group = new THREE.Group();
  readonly light = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly fill = new THREE.DirectionalLight(0xffffff, 0.3);
  readonly fog = new THREE.Fog(0xffffff, 100, 500);
  readonly dome: THREE.Mesh;
  hour = 10.5;
  /** 0..1 — для экспозиции и интерфейса. */
  daylight = 1;
  private fogNear = 100;
  private fogFar = 500;

  constructor(shadowSize: number) {
    const u = this.uniforms;
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const dir = normalize(positionLocal);
    const up = dir.y;
    const sky = mix(u.horizon, u.zenith, pow(saturate(up), 0.5));
    const below = mix(u.horizon, u.haze, saturate(up.mul(-2.5)));
    const base = mix(below, sky, smoothstep(-0.02, 0.02, up));
    const sunDot = saturate(dot(dir, u.sunDir));
    const sun = pow(sunDot, 900).mul(2.2).add(pow(sunDot, 24).mul(0.22)).add(pow(sunDot, 4).mul(0.06));
    const moonDot = saturate(dot(dir, u.moonDir));
    const moon = smoothstep(0.9993, 0.9996, moonDot).mul(1.6).add(pow(moonDot, 60).mul(0.18));
    const grid = dir.mul(360);
    const cell = floor(grid);
    const twinkle = hash(cell.x.add(cell.y.mul(57.3)).add(cell.z.mul(113.7)));
    const round = smoothstep(0.42, 0.05, fract(grid).sub(0.5).length());
    const stars = smoothstep(0.9965, 1, twinkle).mul(round).mul(u.stars).mul(saturate(up.mul(3))).mul(1.6);
    const plane = vec3(dir.x.div(up.add(0.22)).mul(1.3).add(time.mul(0.006)), dir.z.div(up.add(0.22)).mul(1.3), 0.5);
    const clouds = smoothstep(0.05, 0.55, mx_fractal_noise_float(plane, 4, 2, 0.55)).mul(saturate(up.mul(5))).mul(0.8);
    const withClouds = mix(base, u.cloud, clouds);
    material.colorNode = withClouds
      .add(u.sunColor.mul(sun).mul(u.sunStrength.add(0.15)))
      .add(vec3(0.75, 0.82, 1).mul(moon).mul(u.stars))
      .add(vec3(1, 1, 1).mul(stars).mul(float(1).sub(clouds)));
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 20), material);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;

    this.light.castShadow = shadowSize > 0;
    if (shadowSize > 0) {
      const s = this.light.shadow;
      s.mapSize.set(shadowSize, shadowSize);
      s.camera.left = s.camera.bottom = -112;
      s.camera.right = s.camera.top = 112;
      s.camera.near = 40;
      s.camera.far = 520;
      s.bias = -0.0006;
      s.normalBias = 0.35;
      s.radius = 1.5;
      s.blurSamples = 8;
      // Карта теней обновляется не каждый кадр — см. цикл кадра в diorama.ts.
      s.autoUpdate = false;
      s.needsUpdate = true;
    }
    this.group.add(this.dome, this.light, this.light.target, this.hemi, this.fill, this.fill.target);
    this.setHour(this.hour);
  }

  setHour(hour: number): void {
    this.hour = ((hour % 24) + 24) % 24;
    const u = this.uniforms;
    const theta = ((this.hour - 6) / 12) * Math.PI;
    const sunDir = new THREE.Vector3(0.8, 0, 0.25).multiplyScalar(Math.cos(theta)).add(new THREE.Vector3(0.25, 0.9, 0.45).multiplyScalar(Math.sin(theta))).normalize();
    const elevation = sunDir.y;
    const moonDir = new THREE.Vector3(-sunDir.x * 0.8, Math.abs(sunDir.y) * 0.7 + 0.35, -sunDir.z * 0.8 + 0.25).normalize();
    u.sunDir.value.copy(sunDir);
    u.moonDir.value.copy(moonDir);

    const day = THREE.MathUtils.smoothstep(elevation, -0.02, 0.34);
    const night = 1 - THREE.MathUtils.smoothstep(elevation, -0.3, 0.02);
    this.daylight = day;
    // Ночь → сумерки → день: сначала к сумеркам, затем к дню.
    const a = night > 0 ? NIGHT : DUSK;
    const b = night > 0 ? DUSK : DAY;
    const t = night > 0 ? 1 - night : day;
    blend(u.zenith.value, a.zenith, b.zenith, t);
    blend(u.horizon.value, a.horizon, b.horizon, t);
    blend(u.haze.value, a.haze, b.haze, t);
    blend(u.ambient.value, a.ambient, b.ambient, t);
    blend(u.cloud.value, a.cloud, b.cloud, t);
    blend(this.hemi.color, a.hemiSky, b.hemiSky, t);
    blend(this.hemi.groundColor, a.hemiGround, b.hemiGround, t);
    this.hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, t);
    this.fogNear = THREE.MathUtils.lerp(a.fogNear, b.fogNear, t);
    this.fogFar = THREE.MathUtils.lerp(a.fogFar, b.fogFar, t);
    this.fog.color.copy(u.horizon.value).lerp(u.haze.value, 0.35);

    u.stars.value = night;
    u.night.value = 1 - THREE.MathUtils.smoothstep(elevation, -0.12, 0.16);
    const sunUp = THREE.MathUtils.smoothstep(elevation, -0.04, 0.12);
    u.sunStrength.value = sunUp;
    blend(u.sunColor.value, 0xff9a52, 0xfff2dc, THREE.MathUtils.smoothstep(elevation, 0.0, 0.45));

    // Один направленный источник: днём солнце, ночью луна; через горизонт — плавное затухание.
    const moonUp = 1 - THREE.MathUtils.smoothstep(elevation, -0.14, -0.03);
    // В сумерках свет не гаснет: закатное зарево плавно сменяется лунным светом.
    void moonUp;
    this.light.color.set(0x9db6ff).lerp(u.sunColor.value, sunUp);
    this.light.intensity = THREE.MathUtils.lerp(1.05, 3.7, sunUp);
    if (elevation > -0.03) {
      this.light.position.copy(sunDir);
      this.light.position.y = Math.max(this.light.position.y, 0.09);
      this.light.position.normalize().multiplyScalar(260);
    } else {
      this.light.position.copy(moonDir).multiplyScalar(260);
    }
    this.light.target.position.set(0, 0, 0);
    this.fill.color.copy(this.hemi.color);
    this.fill.intensity = 0.28 * (0.35 + 0.65 * day);
    this.fill.position.set(-this.light.position.x, 120, -this.light.position.z);
  }

  /** Туман отсчитывается от камеры, поэтому отодвигается вместе с ней: издалека сцена не тонет в дымке. */
  updateFog(cameraDistance: number): void {
    this.fog.near = this.fogNear + cameraDistance * 0.85;
    this.fog.far = this.fogFar + cameraDistance * 1.7;
  }
}
