// Небо, солнце и луна, освещение, туман. Положение солнца — общая функция из shared/sun
// (та же, по которой симуляция считает освещённость), облачность — из погоды симуляции.
// Приёмы перенесены из прототипа 1A (prototypes/diorama/sky.ts) и масштабированы на большой мир.

import * as THREE from 'three/webgpu';
import { dot, float, floor, fract, hash, mix, mx_fractal_noise_float, normalize, positionLocal, pow, saturate, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { sunDirection, type SunState } from '../shared/sun';

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
  /** Общий оттенок освещённости — для неосвещаемых материалов (пена, осадки). */
  ambient: ColorUniform;
  sunColor: ColorUniform;
  sunDir: VectorUniform;
  moonDir: VectorUniform;
  sunStrength: FloatUniform;
  stars: FloatUniform;
  night: FloatUniform;
  cloud: ColorUniform;
  /** Облачность у камеры 0..1 — из погоды симуляции. */
  cloudCover: FloatUniform;
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
}

const NIGHT: Key = { zenith: 0x060a1c, horizon: 0x1b2a4d, haze: 0x0f1830, ambient: 0x39486e, cloud: 0x26324f, hemiSky: 0x4a5e9c, hemiGround: 0x1c2438, hemi: 0.8 };
const DUSK: Key = { zenith: 0x35488f, horizon: 0xffa868, haze: 0x9a6f6e, ambient: 0xd9a58a, cloud: 0xffb58a, hemiSky: 0xe3bcc0, hemiGround: 0x7a6c70, hemi: 1.15 };
const DAY: Key = { zenith: 0x3d86d8, horizon: 0xcfe7f6, haze: 0x93aebf, ambient: 0xffffff, cloud: 0xffffff, hemiSky: 0xcfe6ff, hemiGround: 0x74804f, hemi: 0.85 };
const OVERCAST = new THREE.Color(0x9aa4ad);

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
    cloudCover: floatUniform(0.1),
  };
  readonly group = new THREE.Group();
  readonly light = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly fog = new THREE.Fog(0xffffff, 1000, 6000);
  readonly dome: THREE.Mesh;
  /** 0..1 — для экспозиции. */
  daylight = 1;
  private readonly sun: SunState = { x: 0, y: 1, z: 0 };
  private shadowExtent = 400;

  constructor(shadowSize: number) {
    const u = this.uniforms;
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const dir = normalize(positionLocal);
    const up = dir.y;
    const clear = mix(u.horizon, u.zenith, pow(saturate(up), 0.5));
    const sky = mix(clear, u.cloud.mul(0.8), u.cloudCover.mul(0.55));
    const below = mix(u.horizon, u.haze, saturate(up.mul(-2.5)));
    const base = mix(below, sky, smoothstep(-0.02, 0.02, up));
    const sunDot = saturate(dot(dir, u.sunDir));
    const sunGlow = pow(sunDot, 900).mul(2.2).add(pow(sunDot, 24).mul(0.22)).add(pow(sunDot, 4).mul(0.06));
    const moonDot = saturate(dot(dir, u.moonDir));
    const moon = smoothstep(0.9993, 0.9996, moonDot).mul(1.6).add(pow(moonDot, 60).mul(0.18));
    const grid = dir.mul(360);
    const cell = floor(grid);
    const twinkle = hash(cell.x.add(cell.y.mul(57.3)).add(cell.z.mul(113.7)));
    const round = smoothstep(0.42, 0.05, fract(grid).sub(0.5).length());
    const stars = smoothstep(0.9965, 1, twinkle).mul(round).mul(u.stars).mul(saturate(up.mul(3))).mul(1.6);
    const plane = vec3(dir.x.div(up.add(0.22)).mul(1.3).add(time.mul(0.006)), dir.z.div(up.add(0.22)).mul(1.3), 0.5);
    // Облака: чем больше облачность из погоды, тем ниже порог — небо затягивает.
    const threshold = mix(float(0.35), float(-0.25), u.cloudCover);
    const clouds = smoothstep(threshold, threshold.add(0.45), mx_fractal_noise_float(plane, 4, 2, 0.55)).mul(saturate(up.mul(5))).mul(0.85);
    const veil = float(1).sub(clouds).mul(float(1).sub(u.cloudCover.mul(0.7)));
    material.colorNode = mix(base, u.cloud, clouds)
      .add(u.sunColor.mul(sunGlow).mul(u.sunStrength.add(0.15)).mul(veil))
      .add(vec3(0.75, 0.82, 1).mul(moon).mul(u.stars).mul(veil))
      .add(vec3(1, 1, 1).mul(stars).mul(veil));
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;

    this.light.castShadow = shadowSize > 0;
    if (shadowSize > 0) {
      const s = this.light.shadow;
      s.mapSize.set(shadowSize, shadowSize);
      s.bias = -0.0008;
      s.normalBias = 0.6;
      s.radius = 1.5;
      s.blurSamples = 8;
      s.autoUpdate = false;
      s.needsUpdate = true;
    }
    this.group.add(this.dome, this.light, this.light.target, this.hemi);
  }

  /** Время суток и года из такта симуляции; облачность у камеры — из погоды. */
  update(dayFrac: number, yearFrac: number, cloudCover: number): void {
    const u = this.uniforms;
    const s = sunDirection(dayFrac, yearFrac, this.sun);
    u.sunDir.value.set(s.x, s.y, s.z);
    // Луна — приблизительно напротив солнца, чуть выше горизонта ночью.
    u.moonDir.value.set(-s.x * 0.8, Math.abs(s.y) * 0.7 + 0.3, -s.z * 0.8 + 0.2).normalize();
    const elevation = s.y;
    u.cloudCover.value += (cloudCover - u.cloudCover.value) * 0.05;
    const cover = u.cloudCover.value;

    const day = THREE.MathUtils.smoothstep(elevation, -0.02, 0.34);
    const night = 1 - THREE.MathUtils.smoothstep(elevation, -0.3, 0.02);
    this.daylight = day;
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
    // Пасмурно: небо и горизонт сереют днём.
    const grey = cover * 0.6 * day;
    u.horizon.value.lerp(OVERCAST, grey);
    u.zenith.value.lerp(OVERCAST, grey * 0.8);
    this.fog.color.copy(u.horizon.value).lerp(u.haze.value, 0.35);

    u.stars.value = night;
    u.night.value = 1 - THREE.MathUtils.smoothstep(elevation, -0.12, 0.16);
    const sunUp = THREE.MathUtils.smoothstep(elevation, -0.04, 0.12);
    u.sunStrength.value = sunUp * (1 - cover * 0.6);
    blend(u.sunColor.value, 0xff9a52, 0xfff2dc, THREE.MathUtils.smoothstep(elevation, 0.0, 0.45));

    this.light.color.set(0x9db6ff).lerp(u.sunColor.value, sunUp);
    this.light.intensity = THREE.MathUtils.lerp(0.9, 3.5, sunUp) * (1 - cover * 0.55);
    this.hemi.intensity *= 1 + cover * 0.25;
    this.lightDir.set(elevation > -0.03 ? s.x : u.moonDir.value.x, elevation > -0.03 ? Math.max(s.y, 0.09) : u.moonDir.value.y, elevation > -0.03 ? s.z : u.moonDir.value.z).normalize();
  }

  private readonly lightDir = new THREE.Vector3(0, 1, 0);

  /** Источник света и карта теней следуют за точкой интереса камеры. */
  follow(target: THREE.Vector3, cameraPos: THREE.Vector3, viewDistance: number): void {
    const extent = THREE.MathUtils.clamp(viewDistance * 0.75, 120, 1600);
    const l = this.light;
    l.target.position.copy(target);
    l.position.copy(target).addScaledVector(this.lightDir, extent * 2 + 400);
    l.target.updateMatrixWorld();
    if (l.castShadow && Math.abs(extent - this.shadowExtent) > this.shadowExtent * 0.1) {
      this.shadowExtent = extent;
      const c = l.shadow.camera;
      c.left = c.bottom = -extent;
      c.right = c.top = extent;
      c.near = 10;
      c.far = extent * 4 + 1200;
      c.updateProjectionMatrix();
    }
    this.dome.position.copy(cameraPos);
  }

  /** Туман отсчитывается от камеры: при обзоре всего мира он отодвигается, у земли — сгущается к горизонту. */
  updateFog(viewDistance: number, altitude: number, far: number): void {
    const base = Math.max(viewDistance, altitude);
    this.fog.near = 300 + base * 0.7;
    this.fog.far = Math.min(far * 0.95, 2600 + base * 2.2);
    this.dome.scale.setScalar(far * 0.9);
  }
}
