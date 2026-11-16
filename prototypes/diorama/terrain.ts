// Рельеф диорамы, срез грунта по краям, подставка и вода (река, водопад, заводь).

import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { attribute, color, dot, float, mix, mx_noise_float, normalView, normalWorld, positionViewDirection, positionWorld, pow, saturate, sin, smoothstep, step, time, uv, vec3 } from 'three/tsl';
import { FOOT_S, HALF, HOUSE, LIP_S, WATER_LOW, WATER_UP, ground, noise2, river, riverHalfWidth, smoothstep as sstep, waterLevel } from './layout';
import type { SkyUniforms } from './sky';

export const BASE_Y = -9;

const C = (hex: number) => new THREE.Color(hex);

const GRASS_A = C(0x5d8a3a);
const GRASS_B = C(0x44742f);
const GRASS_DRY = C(0x8f9a48);
const GRASS_HIGH = C(0x3f6a35);

/** Цвет травяного покрова в точке — общий для рельефа и пучков травы, чтобы они сливались. */
export function grassColor(x: number, z: number, plateau: number, target: THREE.Color): THREE.Color {
  target.copy(GRASS_A).lerp(GRASS_B, noise2(41, x / 11, z / 11));
  target.lerp(GRASS_DRY, sstep(0.55, 0.85, noise2(42, x / 27, z / 27)) * 0.6);
  return target.lerp(GRASS_HIGH, plateau * 0.75);
}

export function buildTerrain(step: number): THREE.Group {
  const group = new THREE.Group();
  const n = Math.round((HALF * 2) / step) + 1;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const sand = C(0xb9a877);
  const bedShallow = C(0x8a8463);
  const bedDeep = C(0x3d4c44);
  const dirt = C(0x8c6d47);
  const tint = new THREE.Color();
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -HALF + ix * step;
      const z = -HALF + iz * step;
      const g = ground(x, z);
      const i = (iz * n + ix) * 3;
      // Скальный срез: вершины на склоне сдвигаются по горизонтали — получаются уступы и выступы.
      const face = 4 * g.plateau * (1 - g.plateau);
      const crag = ((noise2(51, (x - z) * 0.15, g.h * 0.42) - 0.5) * 3.2 + (noise2(52, (x - z) * 0.55, g.h * 1.2) - 0.5) * 1.1) * face;
      positions[i] = x + 0.666 * crag;
      positions[i + 1] = g.h;
      positions[i + 2] = z + 0.746 * crag;

      grassColor(x, z, g.plateau, tint);
      const shore = g.riverD - g.riverW;
      if (shore < 0) {
        tint.copy(bedShallow).lerp(bedDeep, sstep(0, 1, -shore / g.riverW));
      } else {
        tint.lerp(sand, (1 - sstep(0.1, 1.9, shore)) * 0.9);
      }
      const trailK = 1 - sstep(0.7, 1.9, g.trailD + (noise2(43, x / 2, z / 2) - 0.5) * 0.9);
      tint.lerp(dirt, trailK * 0.92);
      const yard = 1 - sstep(4.5, 9, Math.hypot(x - HOUSE.x, z - HOUSE.z) + (noise2(44, x / 3, z / 3) - 0.5) * 3);
      tint.lerp(dirt, yard * 0.55);
      colors[i] = tint.r;
      colors[i + 1] = tint.g;
      colors[i + 2] = tint.b;
    }
  }
  const cells = n - 1;
  const indices = new Uint32Array(cells * cells * 6);
  let o = 0;
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const a = iz * n + ix;
      indices[o++] = a;
      indices[o++] = a + n;
      indices[o++] = a + 1;
      indices[o++] = a + 1;
      indices[o++] = a + n;
      indices[o++] = a + n + 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // Материал: цвета вершин + скала по уклону (считается в шейдере — граница чёткая) + мелкая фактура.
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0 });
  const p = positionWorld;
  const big = mx_noise_float(p.mul(0.35));
  const fine = mx_noise_float(p.mul(2.6));
  const micro = mx_noise_float(p.mul(9));
  // Слоистая порода: пласты разной светлоты с тёмными швами между ними и тонкими трещинами.
  const layer = p.y.mul(0.95).add(big.mul(0.4)).add(p.x.mul(0.03));
  const band = layer.fract();
  const seam = smoothstep(0, 0.07, band).mul(smoothstep(1, 0.9, band));
  const tone = sin(layer.floor().mul(12.9898)).mul(0.5).add(0.5);
  const crackField = mx_noise_float(vec3(p.x.mul(0.55), p.y.mul(2.4), p.z.mul(0.55))).abs();
  const cracks = float(1).sub(smoothstep(0.0, 0.07, crackField));
  const rock = mix(color(0x77726a), color(0xa9a399), tone)
    .mul(seam.mul(0.42).add(0.58))
    .mul(float(1).sub(cracks.mul(0.4)))
    .mul(fine.mul(0.16).add(1))
    .mul(micro.mul(0.12).add(1));
  const rockMask = smoothstep(0.83, 0.66, normalWorld.y.add(fine.mul(0.05)));
  const soil = attribute('color', 'vec3').mul(big.mul(0.1).add(1)).mul(fine.mul(0.09).add(1)).mul(micro.mul(0.05).add(1));
  material.colorNode = mix(soil, rock, rockMask);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);

  // Срез грунта по периметру: дёрн, почва, слои породы.
  const sidePos: number[] = [];
  const sideNor: number[] = [];
  const sideDepth: number[] = [];
  const edge = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number) => {
    const h0 = ground(x0, z0).h;
    const h1 = ground(x1, z1).h;
    const quad = [
      [x0, h0, z0, 0],
      [x1, h1, z1, 0],
      [x1, BASE_Y, z1, h1 - BASE_Y],
      [x0, h0, z0, 0],
      [x1, BASE_Y, z1, h1 - BASE_Y],
      [x0, BASE_Y, z0, h0 - BASE_Y],
    ];
    for (const v of quad) {
      sidePos.push(v[0]!, v[1]!, v[2]!);
      sideNor.push(nx, 0, nz);
      sideDepth.push(v[3]!);
    }
  };
  for (let k = 0; k < cells; k++) {
    const a = -HALF + k * step;
    const b = a + step;
    edge(b, HALF, a, HALF, 0, 1);
    edge(a, -HALF, b, -HALF, 0, -1);
    edge(HALF, a, HALF, b, 1, 0);
    edge(-HALF, b, -HALF, a, -1, 0);
  }
  const sideGeometry = new THREE.BufferGeometry();
  sideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sidePos, 3));
  sideGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(sideNor, 3));
  sideGeometry.setAttribute('depth', new THREE.Float32BufferAttribute(sideDepth, 1));
  const sideMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 1, side: THREE.DoubleSide });
  const depth = attribute('depth', 'float');
  const wobble = mx_noise_float(vec3(p.x.mul(0.25), p.y.mul(0.9), p.z.mul(0.25)));
  const layers = sin(p.y.mul(3.1).add(wobble.mul(2.5))).mul(0.5).add(0.5);
  const stone = mix(color(0x5f584f), color(0x8f8676), layers).mul(mx_noise_float(p.mul(3)).mul(0.14).add(1));
  const subsoil = mix(color(0x6a4a2e), color(0x8a643f), mx_noise_float(p.mul(1.7)).mul(0.5).add(0.5));
  const turf = color(0x3f5f2a);
  const d = depth.add(wobble.mul(0.35));
  sideMaterial.colorNode = mix(mix(turf, subsoil, smoothstep(0.12, 0.3, d)), stone, smoothstep(1.4, 2.4, d));
  const side = new THREE.Mesh(sideGeometry, sideMaterial);
  side.receiveShadow = true;
  group.add(side);

  // Подставка — диорама стоит на тёмной деревянной плите.
  const plinth = new THREE.Mesh(new RoundedBoxGeometry(HALF * 2 + 7, 2.4, HALF * 2 + 7, 3, 0.5), new THREE.MeshStandardNodeMaterial({ color: 0x3a2a1c, roughness: 0.55 }));
  plinth.position.y = BASE_Y - 1.2;
  plinth.receiveShadow = true;
  group.add(plinth);
  return group;
}

/** Лента воды вдоль русла на отрезке [s0, s1]. */
function ribbon(s0: number, s1: number): THREE.BufferGeometry {
  const COLS = 6;
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  let rows = 0;
  for (let s = s0; s <= s1 + 1e-6; s += 0.8) {
    const c = river.at(s);
    if (Math.abs(c.x) > HALF || Math.abs(c.z) > HALF) continue;
    const w = riverHalfWidth(s) + 0.12;
    const y = s0 < LIP_S ? waterLevel(Math.min(s, LIP_S)) : waterLevel(Math.max(s, FOOT_S));
    for (let k = 0; k <= COLS; k++) {
      const u = k / COLS;
      const off = (u * 2 - 1) * w;
      const x = Math.max(-HALF, Math.min(HALF, c.x - c.tz * off));
      const z = Math.max(-HALF, Math.min(HALF, c.z + c.tx * off));
      pos.push(x, y, z);
      uvs.push(u, s);
    }
    if (rows > 0) {
      const a = (rows - 1) * (COLS + 1);
      const b = rows * (COLS + 1);
      for (let k = 0; k < COLS; k++) idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    }
    rows++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildWater(sky: SkyUniforms): THREE.Group {
  const group = new THREE.Group();
  const p = positionWorld;
  const u = uv();
  const across = u.x.mul(2).sub(1).abs();

  const riverMaterial = (speed: number) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.1, metalness: 0, transparent: true, depthWrite: false });
    const flow = u.y.mul(0.32).sub(time.mul(speed));
    const streaks = mx_noise_float(vec3(u.x.mul(4.5), flow.mul(1.5), time.mul(0.12)));
    const ripple = mx_noise_float(vec3(p.x.mul(0.9).add(time.mul(0.25)), p.z.mul(0.9), time.mul(0.45)));
    const depthK = saturate(float(1).sub(across.mul(across)).add(streaks.mul(0.1)));
    const body = mix(color(0x5fb4ad), color(0x1f6f86), depthK.mul(0.9));
    const fresnel = pow(saturate(float(1).sub(dot(normalView, positionViewDirection))), 3);
    const reflected = mix(body, sky.horizon, fresnel.mul(0.6));
    const foam = saturate(smoothstep(0.9, 0.995, across.add(ripple.mul(0.07))).add(smoothstep(0.5, 0.85, streaks).mul(0.22)));
    m.colorNode = mix(reflected, vec3(1, 1, 1), foam);
    m.opacityNode = saturate(mix(float(0.7), float(0.95), depthK).add(foam));
    const glint = step(0.78, mx_noise_float(vec3(p.x.mul(2.6), p.z.mul(2.6), time.mul(1.4))));
    m.emissiveNode = sky.sunColor.mul(glint.mul(sky.sunStrength).mul(0.35));
    return m;
  };

  const start = (() => {
    for (let s = 0; s < LIP_S; s += 0.4) {
      const c = river.at(s);
      if (Math.abs(c.x) < HALF && Math.abs(c.z) < HALF) return s;
    }
    return 0;
  })();
  const upper = new THREE.Mesh(ribbon(start, LIP_S + 0.5), riverMaterial(0.55));
  const lower = new THREE.Mesh(ribbon(FOOT_S - 0.6, river.length), riverMaterial(0.32));
  upper.receiveShadow = lower.receiveShadow = true;
  upper.renderOrder = lower.renderOrder = 2;
  group.add(upper, lower);

  // Водопад: изогнутая пелена от кромки плато до заводи.
  const lip = river.at(LIP_S + 0.5);
  const fallPos: number[] = [];
  const fallUv: number[] = [];
  const fallIdx: number[] = [];
  const ROWS = 16;
  const COLS = 6;
  for (let r = 0; r <= ROWS; r++) {
    const v = r / ROWS;
    const forward = v * 2.9 + 0.1;
    const y = WATER_UP - (WATER_UP - WATER_LOW + 0.1) * v * v;
    const w = 1.75 + v * 0.9;
    for (let k = 0; k <= COLS; k++) {
      const uu = k / COLS;
      const off = (uu * 2 - 1) * w;
      const bulge = Math.cos((uu * 2 - 1) * 1.2) * 0.25 * v;
      fallPos.push(lip.x + lip.tx * (forward + bulge) - lip.tz * off, y, lip.z + lip.tz * (forward + bulge) + lip.tx * off);
      fallUv.push(uu, v);
    }
    if (r > 0) {
      const a = (r - 1) * (COLS + 1);
      const b = r * (COLS + 1);
      for (let k = 0; k < COLS; k++) fallIdx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    }
  }
  const fallGeometry = new THREE.BufferGeometry();
  fallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fallPos, 3));
  fallGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(fallUv, 2));
  fallGeometry.setIndex(fallIdx);
  fallGeometry.computeVertexNormals();
  const fallMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const fall = mx_noise_float(vec3(u.x.mul(11), u.y.mul(3.2).sub(time.mul(2.6)), 0.3));
  const fall2 = mx_noise_float(vec3(u.x.mul(4), u.y.mul(1.4).sub(time.mul(1.7)), 2.1));
  const white = smoothstep(-0.35, 0.5, fall.add(fall2.mul(0.6)).add(u.y.mul(0.5)));
  fallMaterial.colorNode = mix(color(0x8fcfdc), vec3(1, 1, 1), white);
  fallMaterial.opacityNode = saturate(float(0.72).add(white.mul(0.3))).mul(smoothstep(0, 0.12, float(1).sub(u.x.mul(2).sub(1).abs())));
  const fallMesh = new THREE.Mesh(fallGeometry, fallMaterial);
  fallMesh.renderOrder = 3;
  group.add(fallMesh);

  // Пена на заводи под водопадом.
  const foot = river.at(FOOT_S);
  const foamMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const fu = uv().sub(0.5).mul(2);
  const radius = fu.length();
  const churn = mx_noise_float(vec3(fu.x.mul(3.5), fu.y.mul(3.5), time.mul(0.9))).add(mx_noise_float(vec3(fu.x.mul(8), fu.y.mul(8), time.mul(1.6))).mul(0.5));
  foamMaterial.colorNode = vec3(1, 1, 1).mul(sky.ambient);
  foamMaterial.opacityNode = saturate(smoothstep(1, 0.15, radius.add(churn.mul(0.3))).mul(churn.mul(0.5).add(0.65)));
  const foam = new THREE.Mesh(new THREE.PlaneGeometry(8.5, 8.5), foamMaterial);
  foam.rotation.x = -Math.PI / 2;
  foam.position.set(foot.x + foot.tx * 0.6, WATER_LOW + 0.03, foot.z + foot.tz * 0.6);
  foam.renderOrder = 4;
  group.add(foam);
  return group;
}

export function waterfallFoot(): THREE.Vector3 {
  const foot = river.at(FOOT_S);
  return new THREE.Vector3(foot.x, WATER_LOW + 0.4, foot.z);
}
