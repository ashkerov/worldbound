// Частицы осадков вокруг камеры: интенсивность и вид (дождь или снег) берутся из погоды симуляции
// в точке камеры. Положения частиц считаются в вершинном шейдере — на процессоре только униформы.

import * as THREE from 'three/webgpu';
import { attribute, float, fract, mix, positionLocal, select, sin, time, uniform, uv, vec3 } from 'three/tsl';
import type { SkyUniforms } from './sky';

const BOX = 70;
const HEIGHT = 40;

export class Precipitation {
  readonly mesh: THREE.Mesh;
  /** Интенсивность 0..1 (из мм/ч). */
  readonly intensity = uniform(0);
  /** 0 — дождь, 1 — снег. */
  readonly snow = uniform(0);
  readonly center = uniform(new THREE.Vector3());
  readonly wind = uniform(new THREE.Vector2(0, 0));
  readonly right = uniform(new THREE.Vector3(1, 0, 0));

  constructor(count: number, sky: SkyUniforms) {
    const pos = new Float32Array(count * 4 * 3);
    const seeds = new Float32Array(count * 4 * 4);
    const uvs = new Float32Array(count * 4 * 2);
    const idx = new Uint32Array(count * 6);
    let s = 12345;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const corners = [
      [-0.5, 0],
      [0.5, 0],
      [-0.5, 1],
      [0.5, 1],
    ];
    for (let i = 0; i < count; i++) {
      const a = rnd();
      const b = rnd();
      const c = rnd();
      const d = rnd();
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        seeds.set([a, b, c, d], v * 4);
        uvs.set([corners[k]![0]! + 0.5, corners[k]![1]!], v * 2);
        pos.set([corners[k]![0]!, corners[k]![1]!, 0], v * 3);
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const seed = attribute('seed', 'vec4');
    const fall = mix(float(14), float(1.4), this.snow);
    const t = time;
    const yN = fract(seed.z.sub(t.mul(fall).div(HEIGHT)));
    const sway = sin(t.mul(1.3).add(seed.w.mul(30))).mul(this.snow).mul(0.8);
    const drift = this.wind.mul(t.mul(mix(float(0.6), float(0.35), this.snow)));
    const fx = fract(seed.x.add(drift.x.div(BOX)).sub(this.center.x.div(BOX))).sub(0.5).mul(BOX);
    const fz = fract(seed.y.add(drift.y.div(BOX)).sub(this.center.z.div(BOX))).sub(0.5).mul(BOX);
    const base = vec3(this.center.x.add(fx).add(sway), this.center.y.add(yN.mul(HEIGHT)).sub(HEIGHT * 0.45), this.center.z.add(fz));
    // Капля — вертикальная черта, снежинка — маленький квадрат; оба развёрнуты к камере.
    const width = mix(float(0.025), float(0.09), this.snow);
    const length = mix(float(0.9), float(0.09), this.snow);
    const local = positionLocal;
    const visible = select(this.intensity.greaterThan(seed.w), float(1), float(0));
    m.positionNode = base.add(this.right.mul(local.x.mul(width))).add(vec3(0, local.y.mul(length), 0)).mul(visible).add(vec3(0, -1e5, 0).mul(float(1).sub(visible)));
    const uvn = uv();
    const soft = float(1).sub(uvn.x.sub(0.5).abs().mul(2)).mul(mix(float(1), float(1).sub(uvn.y.sub(0.5).abs().mul(2)), this.snow));
    m.colorNode = mix(vec3(0.75, 0.8, 0.88), vec3(1, 1, 1), this.snow).mul(sky.ambient);
    m.opacityNode = soft.mul(mix(float(0.35), float(0.85), this.snow));
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  update(camera: THREE.Camera, rateMmH: number, temperature: number, windX: number, windZ: number, windSpeed: number, altitude: number): void {
    const k = Math.min(1, rateMmH / 6);
    // Частицы видны у земли; с высоты осадки видны по тени облаков на рельефе.
    this.intensity.value = altitude < 250 ? k : 0;
    this.mesh.visible = this.intensity.value > 0.01;
    this.snow.value += ((temperature < 0.5 ? 1 : 0) - this.snow.value) * 0.05;
    this.center.value.copy(camera.position);
    this.wind.value.set(windX * windSpeed, windZ * windSpeed);
    this.right.value.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  }
}
