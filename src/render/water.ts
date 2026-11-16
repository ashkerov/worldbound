// Вода: реки и озёра — поверхность по ячейкам гидрологии симуляции (уровни, направление стока, расход);
// море — плоскость на уровне моря до горизонта с глубиной из рельефа и пеной у берега.

import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, color, dot, float, mix, mx_noise_float, normalView, positionLocal, positionViewDirection, positionWorld, pow, saturate, smoothstep, step, texture, time, uniform, vec2, vec3 } from 'three/tsl';
import type { SkyUniforms } from './sky';
import type { WorldData } from './worldData';

const RIVER = 1;
const LAKE = 2;

/** Поверхность рек и озёр. Вершины — углы ячеек; уровень угла — среднее по соседним водным ячейкам. */
export function buildInlandWater(data: WorldData, sky: SkyUniforms): THREE.Mesh | null {
  const n = data.n;
  const cs = data.cellSize;
  const v = n + 1;
  const levelSum = new Float64Array(v * v);
  const weight = new Float64Array(v * v);
  const flowX = new Float32Array(v * v);
  const flowZ = new Float32Array(v * v);
  const discharge = new Float32Array(v * v);
  const lake = new Float32Array(v * v);
  const depthSum = new Float32Array(v * v);
  let cells = 0;
  for (let i = 0; i < n * n; i++) {
    const kind = data.waterKind[i]!;
    if (kind !== RIVER && kind !== LAKE) continue;
    cells++;
    const x = i % n;
    const z = (i - x) / n;
    const level = data.waterLevel[i]!;
    for (const [cx, cz] of [
      [x, z],
      [x + 1, z],
      [x, z + 1],
      [x + 1, z + 1],
    ] as const) {
      const c = cz * v + cx;
      levelSum[c] = levelSum[c]! + level;
      weight[c]!++;
      flowX[c] = flowX[c]! + (kind === RIVER ? data.flow[i * 2]! : 0);
      flowZ[c] = flowZ[c]! + (kind === RIVER ? data.flow[i * 2 + 1]! : 0);
      discharge[c] = Math.max(discharge[c]!, data.meanDischarge[i]!);
      if (kind === LAKE) lake[c] = 1;
      depthSum[c] = depthSum[c]! + Math.max(0, level - data.cellHeight[i]!);
    }
  }
  if (cells === 0) return null;
  // Кольцо ячеек вокруг воды: поверхность продолжается под берег, и линию берега рисует пересечение
  // с рельефом, а не ступенчатая граница ячеек. Уровень углов кольца — от соседних углов воды.
  const draw = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const kind = data.waterKind[i]!;
    if (kind !== RIVER && kind !== LAKE) continue;
    const x = i % n;
    const z = (i - x) / n;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= n || zz >= n) continue;
        if (data.waterKind[zz * n + xx] !== 3) draw[zz * n + xx] = 1;
      }
    }
  }
  const baseWeight = Float64Array.from(weight);
  for (let c = 0; c < v * v; c++) {
    if (baseWeight[c]! > 0) continue;
    const cx = c % v;
    const cz = (c - cx) / v;
    let sum = 0;
    let k = 0;
    let dsum = 0;
    let lakeMax = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx;
        const zz = cz + dz;
        if (xx < 0 || zz < 0 || xx >= v || zz >= v) continue;
        const o = zz * v + xx;
        if (baseWeight[o]! === 0) continue;
        sum += levelSum[o]! / baseWeight[o]!;
        dsum += depthSum[o]! / baseWeight[o]!;
        lakeMax = Math.max(lakeMax, lake[o]!);
        k++;
      }
    }
    if (k === 0) continue;
    // Внешний край кольца уходит под берег — поверхность ныряет под рельеф, а не обрывается.
    levelSum[c] = sum / k - 2;
    depthSum[c] = 0;
    weight[c] = 1;
    lake[c] = lakeMax;
    void dsum;
  }
  const index = new Int32Array(v * v).fill(-1);
  const pos: number[] = [];
  const flow: number[] = [];
  const extra: number[] = [];
  for (let c = 0; c < v * v; c++) {
    if (weight[c] === 0) continue;
    const cx = c % v;
    const cz = (c - cx) / v;
    index[c] = pos.length / 3;
    const x = cx * cs;
    const z = cz * cs;
    const level = levelSum[c]! / weight[c]!;
    pos.push(x, level, z);
    const fl = Math.hypot(flowX[c]!, flowZ[c]!) || 1;
    flow.push(flowX[c]! / fl, flowZ[c]! / fl);
    extra.push(depthSum[c]! / weight[c]!, discharge[c]!, lake[c]!);
  }
  const idx: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (draw[i] === 0) continue;
    const x = i % n;
    const z = (i - x) / n;
    const a = index[z * v + x]!;
    const b = index[z * v + x + 1]!;
    const c = index[(z + 1) * v + x]!;
    const d = index[(z + 1) * v + x + 1]!;
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 2));
  g.setAttribute('water', new THREE.Float32BufferAttribute(extra, 3));
  g.setIndex(idx);
  g.computeVertexNormals();

  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0, transparent: true, depthWrite: false });
  const p = positionWorld;
  const w = attribute('water', 'vec3');
  const depth = w.x;
  const q = w.y;
  const isLake = w.z;
  const dir = attribute('flow', 'vec2');
  // Течение: полосы бегут вдоль направления стока; скорость растёт с расходом, у озёр течения нет.
  const speed = float(0.6).add(q.sqrt().mul(0.5)).mul(float(1).sub(isLake));
  const along = p.x.mul(dir.x).add(p.z.mul(dir.y));
  const across = p.x.mul(dir.y).sub(p.z.mul(dir.x));
  const streaks = mx_noise_float(vec3(across.mul(0.35), along.mul(0.08).sub(time.mul(speed)), time.mul(0.1)));
  const ripple = mx_noise_float(vec3(p.x.mul(0.25).add(time.mul(0.15)), p.z.mul(0.25), time.mul(0.35)));
  const deepK = saturate(depth.div(2.2).add(ripple.mul(0.1)));
  const body = mix(color(0x6cb6a8), color(0x1d5f78), deepK);
  const fresnel = pow(saturate(float(1).sub(dot(normalView, positionViewDirection))), 3);
  const reflected = mix(body, sky.horizon, fresnel.mul(0.55));
  // Пена: на мелководье у берегов и на крутых участках русла (перекаты, водопады).
  const steep = smoothstep(0.97, 0.85, attribute('normal', 'vec3').y);
  // Берег рисует сам рельеф, пересекая поверхность; пены у берега нет — только светлое мелководье.
  const shore = float(0);
  const foam = saturate(steep.mul(smoothstep(-0.3, 0.4, streaks).mul(0.6).add(0.5)).add(shore.mul(0.6)).add(smoothstep(0.45, 0.8, streaks).mul(0.15).mul(float(1).sub(isLake))));
  m.colorNode = mix(reflected, vec3(1, 1, 1).mul(sky.ambient), foam);
  m.opacityNode = saturate(mix(float(0.62), float(0.93), deepK).add(foam));
  const glint = step(0.8, mx_noise_float(vec3(p.x.mul(0.9), p.z.mul(0.9), time.mul(1.2))));
  m.emissiveNode = sky.sunColor.mul(glint.mul(sky.sunStrength).mul(0.3));
  // Вдали грубый LOD рельефа может перекрыть узкое русло — поверхность чуть приподнимается с расстоянием.
  // Только для рек: озёра широкие и плоские, грубый LOD их не прячет.
  // В positionNode нельзя ссылаться на positionWorld (он сам из него выводится); матрица сетки единичная.
  const lift = positionLocal.sub(cameraPosition).length().sub(250).max(0).mul(0.003).mul(float(1).sub(isLake));
  m.positionNode = positionLocal.add(vec3(0, lift.add(steep.mul(0.15)), 0));
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  return mesh;
}

/** Море до горизонта: цвет по глубине (рельеф мира и горизонта), прибой у берега. */
export function buildSea(data: WorldData, sky: SkyUniforms, extent: number): THREE.Mesh {
  const size = data.worldSize;
  const geometry = new THREE.PlaneGeometry(size + 2 * extent, size + 2 * extent, 64, 64);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(size / 2, 0, size / 2);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0, transparent: true, depthWrite: false });
  const p = positionWorld;
  const worldSize = uniform(size);
  const h = data.horizon;
  const hSpan = (h.samples - 1) * h.spacing;
  const inside = step(0, p.x).mul(step(p.x, worldSize)).mul(step(0, p.z)).mul(step(p.z, worldSize));
  const cellGround = texture(data.depthTex, vec2(p.x, p.z).div(worldSize)).r;
  const horizonGround = texture(data.horizonDepthTex, vec2(p.x.sub(h.originX), p.z.sub(h.originZ)).div(hSpan)).r;
  const ground = mix(horizonGround, cellGround, inside);
  const depth = ground.negate().max(0);
  const waves = mx_noise_float(vec3(p.x.mul(0.05).add(time.mul(0.12)), p.z.mul(0.05), time.mul(0.18)));
  const deepK = saturate(depth.div(18));
  const body = mix(color(0x58b5b0), color(0x174f75), deepK);
  const fresnel = pow(saturate(float(1).sub(dot(normalView, positionViewDirection))), 3);
  const surf = smoothstep(1.3, 0.15, depth.add(waves.mul(0.5)));
  const swell = smoothstep(0.2, 0.75, mx_noise_float(vec3(p.x.mul(0.12), p.z.mul(0.12).sub(time.mul(0.4)), time.mul(0.3)))).mul(smoothstep(4, 1.2, depth));
  const foam = saturate(surf.add(swell.mul(0.5)));
  m.colorNode = mix(mix(body, sky.horizon, fresnel.mul(0.6)), vec3(1, 1, 1).mul(sky.ambient), foam);
  m.opacityNode = saturate(mix(float(0.55), float(0.97), smoothstep(0, 6, depth)).add(foam.mul(0.5)));
  const glint = step(0.82, mx_noise_float(vec3(p.x.mul(0.35), p.z.mul(0.35), time.mul(1.1))));
  m.emissiveNode = sky.sunColor.mul(glint.mul(sky.sunStrength).mul(0.25));
  const mesh = new THREE.Mesh(geometry, m);
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  return mesh;
}
