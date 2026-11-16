// Дом из досок на каменном цоколе с дранкой, трубой и светящимися окнами; двор, фонарь, мост.
// Всё собрано процедурно из отдельных камней, досок и дранок — собственная работа проекта.

import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { attribute, float, mx_noise_float, positionWorld, sin, time, vec3 } from 'three/tsl';
import { GeoBuilder } from './kit';
import { HOUSE, bridge, heightAt, rand } from './layout';
import type { SkyUniforms } from './sky';

const C = (hex: number) => new THREE.Color(hex);
const pick = (colors: number[], seed: number, i: number) => C(colors[Math.floor(rand(seed, i) * colors.length * 0.999)]!);

const WOOD = [0xa67a52, 0x956a45, 0xb3875c, 0x9c7049];
const DARK_WOOD = [0x4c3524, 0x55402d, 0x3f2c1f];
const STONE = [0x8f897e, 0x7c766c, 0x9c968a, 0x6f6a61, 0x90826c];
const SHINGLE = [0x7b5b3d, 0x6b4f37, 0x8c6b49, 0x5d4633, 0x74604a, 0x80684c, 0x6a5a40, 0x5f6243];

const dummy = new THREE.Object3D();
dummy.rotation.order = 'YXZ';

/** Брусок со скруглёнными рёбрами. */
function block(b: GeoBuilder, size: [number, number, number], at: [number, number, number], color: THREE.Color, rot: [number, number, number] = [0, 0, 0], soft = 0.03): void {
  dummy.position.set(...at);
  dummy.rotation.set(rot[0], rot[1], rot[2]);
  dummy.scale.set(1, 1, 1);
  dummy.updateMatrix();
  const radius = Math.min(soft, Math.min(...size) * 0.45);
  b.add(new RoundedBoxGeometry(size[0], size[1], size[2], 1, radius), dummy.matrix, color);
}

/** Простой брусок без скруглений — для множества мелких деталей (дранка). */
function slab(b: GeoBuilder, size: [number, number, number], at: [number, number, number], color: THREE.Color, rot: [number, number, number] = [0, 0, 0]): void {
  dummy.position.set(...at);
  dummy.rotation.set(rot[0], rot[1], rot[2]);
  dummy.scale.set(1, 1, 1);
  dummy.updateMatrix();
  b.add(new THREE.BoxGeometry(...size), dummy.matrix, color);
}

export interface HouseResult {
  group: THREE.Group;
  /** Мировые координаты устья трубы. */
  chimneyTop: THREE.Vector3;
  /** Тёплые источники света: их яркость задаётся временем суток. */
  lights: { light: THREE.PointLight; power: number }[];
}

export function buildHouse(sky: SkyUniforms): HouseResult {
  const group = new THREE.Group();
  const house = new THREE.Group();
  house.position.set(HOUSE.x, HOUSE.y, HOUSE.z);
  house.rotation.y = HOUSE.yaw;
  group.add(house);

  const wood = new GeoBuilder();
  const stone = new GeoBuilder();
  const roof = new GeoBuilder();
  const glass = new GeoBuilder();
  const worldWood = new GeoBuilder();

  const W = 7.4;
  const D = 5.4;
  const BASE = 0.9;
  const TOP = 3.5;
  const PITCH = 0.75;
  const EAVE = 0.6;
  const rise = (D / 2 + EAVE) * Math.tan(PITCH);
  const ridgeY = TOP - 0.25 + rise;

  // ── Каменный цоколь: два ряда отдельных камней по периметру ──
  block(stone, [W - 0.2, BASE, D - 0.2], [0, BASE / 2, 0], C(0x5c574f), [0, 0, 0], 0.01);
  let stoneIndex = 0;
  const stoneRow = (length: number, place: (t: number) => [number, number, number], yaw: number, rows: number, y0: number, rowH: number) => {
    for (let r = 0; r < rows; r++) {
      let t = -length / 2 + (r % 2) * 0.25;
      while (t < length / 2 - 0.2) {
        const w = Math.min(0.5 + rand(801, stoneIndex) * 0.45, length / 2 - t);
        const p = place(t + w / 2);
        block(stone, [w - 0.03, rowH - 0.03, 0.42], [p[0], y0 + r * rowH + rowH / 2, p[2]], pick(STONE, 802, stoneIndex).multiplyScalar(0.9 + rand(803, stoneIndex) * 0.2), [0, yaw, 0], 0.07);
        t += w;
        stoneIndex++;
      }
    }
  };
  stoneRow(W + 0.3, (t) => [t, 0, D / 2 + 0.02], 0, 2, 0, BASE / 2);
  stoneRow(W + 0.3, (t) => [t, 0, -D / 2 - 0.02], 0, 2, 0, BASE / 2);
  stoneRow(D + 0.3, (t) => [W / 2 + 0.02, 0, t], Math.PI / 2, 2, 0, BASE / 2);
  stoneRow(D + 0.3, (t) => [-W / 2 - 0.02, 0, t], Math.PI / 2, 2, 0, BASE / 2);

  // ── Стены из горизонтальных досок, угловые столбы, обвязка ──
  const ROWS = 9;
  const rowH = (TOP - BASE) / ROWS;
  for (let r = 0; r < ROWS; r++) {
    const y = BASE + r * rowH + rowH / 2;
    block(wood, [W, rowH - 0.012, 0.2], [0, y, D / 2 - 0.1], pick(WOOD, 810, r).multiplyScalar(0.92 + rand(811, r) * 0.16));
    block(wood, [W, rowH - 0.012, 0.2], [0, y, -D / 2 + 0.1], pick(WOOD, 812, r).multiplyScalar(0.92 + rand(813, r) * 0.16));
    block(wood, [0.2, rowH - 0.012, D - 0.4], [W / 2 - 0.1, y, 0], pick(WOOD, 814, r).multiplyScalar(0.92 + rand(815, r) * 0.16));
    block(wood, [0.2, rowH - 0.012, D - 0.4], [-W / 2 + 0.1, y, 0], pick(WOOD, 816, r).multiplyScalar(0.92 + rand(817, r) * 0.16));
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) block(wood, [0.3, TOP - BASE + 0.1, 0.3], [(sx * W) / 2, (TOP + BASE) / 2, (sz * D) / 2], pick(DARK_WOOD, 818, sx + sz * 3 + 5));
  }
  for (const sz of [-1, 1]) block(wood, [W + 0.4, 0.22, 0.26], [0, TOP + 0.05, (sz * D) / 2], C(DARK_WOOD[0]!));
  // Фронтоны из вертикальных досок.
  for (const sx of [-1, 1]) {
    let k = 0;
    for (let z = -D / 2 + 0.16; z < D / 2; z += 0.31) {
      const h = (D / 2 - Math.abs(z)) * Math.tan(PITCH) + 0.25;
      block(wood, [0.16, h, 0.29], [sx * (W / 2 - 0.08), TOP + h / 2, z], pick(WOOD, 820, k++ + sx * 40 + 60).multiplyScalar(0.88 + rand(821, k) * 0.2));
    }
    block(wood, [0.2, 0.2, D + 0.3], [sx * (W / 2 - 0.05), TOP + 0.05, 0], C(DARK_WOOD[1]!));
  }

  // ── Крыша: настил и ряды дранки с разбросом цвета и наклона ──
  const cosP = Math.cos(PITCH);
  const sinP = Math.sin(PITCH);
  const slope = (D / 2 + EAVE) / cosP;
  const roofLength = W + 1.3;
  for (const sign of [-1, 1]) {
    const mid = slope / 2;
    slab(roof, [roofLength - 0.1, 0.1, slope], [0, ridgeY - sinP * mid - 0.06, sign * cosP * mid], C(0x3d2c1f), [sign * PITCH, 0, 0]);
    const rowsCount = Math.ceil(slope / 0.36);
    for (let r = 0; r < rowsCount; r++) {
      const along = slope - 0.2 - r * 0.36;
      const perRow = Math.ceil(roofLength / 0.36);
      for (let k = 0; k < perRow; k++) {
        const id = r * 100 + k + (sign > 0 ? 5000 : 0);
        const x = -roofLength / 2 + 0.18 + k * 0.36 + (r % 2) * 0.18 + (rand(830, id) - 0.5) * 0.03;
        if (x > roofLength / 2) continue;
        const lift = 0.05 + r * 0.0005 + rand(831, id) * 0.012;
        const y = ridgeY - sinP * along + cosP * lift;
        const z = sign * (cosP * along + sinP * lift);
        slab(roof, [0.33 + rand(832, id) * 0.03, 0.035, 0.5], [x, y, z], pick(SHINGLE, 833, id).multiplyScalar(0.85 + rand(834, id) * 0.3), [sign * (PITCH - 0.08), (rand(835, id) - 0.5) * 0.06, 0]);
      }
    }
    // Ветровые доски по краям фронтонов.
    for (const sx of [-1, 1]) slab(roof, [0.09, 0.26, slope + 0.1], [sx * (roofLength / 2), ridgeY - sinP * mid, sign * cosP * mid], C(DARK_WOOD[0]!), [sign * PITCH, 0, 0]);
  }
  block(roof, [roofLength + 0.1, 0.16, 0.3], [0, ridgeY + 0.07, 0], C(0x4a3626));

  // ── Труба из камня ──
  const cx = W / 2 - 1.5;
  const cz = -1.0;
  const chimneyTopY = ridgeY + 1.15;
  block(stone, [0.72, chimneyTopY, 0.72], [cx, chimneyTopY / 2, cz], C(0x5c574f), [0, 0, 0], 0.01);
  for (let r = 0; r * 0.34 < chimneyTopY - 0.2; r++) {
    const y = r * 0.34 + 0.17;
    if (y < TOP - 0.3 && r % 1 === 0 && y > BASE && Math.abs(cz) < D / 2 - 0.5 && y < TOP - 0.3) continue; // внутри дома не видно
    for (let f = 0; f < 4; f++) {
      const a = (f * Math.PI) / 2;
      for (let k = 0; k < 2; k++) {
        const off = (k - 0.5) * 0.44 + (r % 2) * 0.1 - 0.05;
        const px = cx + Math.sin(a) * 0.4 + Math.cos(a) * off;
        const pz = cz + Math.cos(a) * 0.4 - Math.sin(a) * off;
        block(stone, [0.43, 0.31, 0.2], [px, y, pz], pick(STONE, 840, r * 8 + f * 2 + k).multiplyScalar(0.85 + rand(841, r * 8 + f * 2 + k) * 0.25), [0, a, 0], 0.06);
      }
    }
  }
  block(stone, [1.15, 0.16, 1.15], [cx, chimneyTopY + 0.05, cz], C(0x77716a), [0, 0, 0], 0.05);
  block(stone, [0.6, 0.3, 0.6], [cx, chimneyTopY + 0.28, cz], C(0x4a4642), [0, 0, 0], 0.04);

  // ── Окна: стекло, переплёт, наличники, ставни, цветочный ящик ──
  const shutter = C(0x4c6f63);
  const windowAt = (x: number, y: number, z: number, yaw: number, wide = 0.95) => {
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
    const local = (dx: number, dy: number, dz: number): [number, number, number] => {
      const v = new THREE.Vector3(dx, dy, dz).applyMatrix4(m);
      return [v.x, v.y, v.z];
    };
    glass.add(new THREE.PlaneGeometry(wide, 1.05), new THREE.Matrix4().makeRotationY(yaw).setPosition(...local(0, 0, 0.03)), C(0xffffff));
    block(wood, [wide + 0.22, 0.11, 0.1], local(0, 0.58, 0.06), C(DARK_WOOD[0]!), [0, yaw, 0]);
    block(wood, [wide + 0.3, 0.1, 0.2], local(0, -0.58, 0.1), C(DARK_WOOD[1]!), [0, yaw, 0]);
    for (const s of [-1, 1]) block(wood, [0.1, 1.2, 0.1], local(s * (wide / 2 + 0.05), 0, 0.06), C(DARK_WOOD[0]!), [0, yaw, 0]);
    block(wood, [0.045, 1.05, 0.05], local(0, 0, 0.06), C(DARK_WOOD[2]!), [0, yaw, 0], 0.01);
    block(wood, [wide, 0.045, 0.05], local(0, 0.05, 0.06), C(DARK_WOOD[2]!), [0, yaw, 0], 0.01);
    for (const s of [-1, 1]) {
      block(wood, [0.42, 1.12, 0.05], local(s * (wide / 2 + 0.34), 0, 0.05), shutter.clone().multiplyScalar(0.9 + rand(850, x * 7 + s) * 0.2), [0, yaw, 0]);
      block(wood, [0.36, 0.05, 0.03], local(s * (wide / 2 + 0.34), 0.3, 0.085), shutter.clone().multiplyScalar(0.7), [0, yaw, 0], 0.01);
      block(wood, [0.36, 0.05, 0.03], local(s * (wide / 2 + 0.34), -0.3, 0.085), shutter.clone().multiplyScalar(0.7), [0, yaw, 0], 0.01);
    }
    // Ящик с цветами.
    block(wood, [wide + 0.1, 0.2, 0.24], local(0, -0.76, 0.2), C(0x6b4a31), [0, yaw, 0]);
    for (let k = 0; k < 9; k++) {
      const fx = (k / 8 - 0.5) * wide * 0.92;
      const tall = 0.1 + rand(851, k + x * 3) * 0.12;
      wood.add(new THREE.IcosahedronGeometry(0.075, 1), new THREE.Matrix4().makeTranslation(...local(fx, -0.62 + tall, 0.2 + (rand(852, k) - 0.5) * 0.1)), k % 3 === 0 ? C(0x5c8f3f) : pick([0xd9443f, 0xf2b53a, 0xf0e9dc, 0xd96aa8], 853, k + Math.round(x * 5)));
    }
  };
  windowAt(-2.1, 2.25, D / 2, 0);
  windowAt(2.2, 2.25, D / 2, 0);
  windowAt(-W / 2, 2.25, 0.2, -Math.PI / 2);
  windowAt(W / 2, 2.25, 1.2, Math.PI / 2, 0.8);
  windowAt(-1.2, 2.25, -D / 2, Math.PI);
  // Круглое слуховое окно во фронтоне.
  glass.add(new THREE.CircleGeometry(0.33, 16), new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(-W / 2 - 0.01, TOP + 1.1, 0), C(0xffffff));
  wood.add(new THREE.TorusGeometry(0.36, 0.06, 6, 18), new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(-W / 2 - 0.03, TOP + 1.1, 0), C(DARK_WOOD[0]!));

  // ── Дверь, крыльцо, навес ──
  const doorX = 0.05;
  for (let k = 0; k < 5; k++) block(wood, [0.2, 1.95, 0.07], [doorX - 0.4 + k * 0.2, BASE + 1.0, D / 2 + 0.04], C(0x6e3f2a).multiplyScalar(0.9 + rand(860, k) * 0.2));
  for (const y of [BASE + 0.45, BASE + 1.55]) block(wood, [1.0, 0.09, 0.04], [doorX, y, D / 2 + 0.09], C(0x2e2620), [0, 0, 0], 0.01);
  wood.add(new THREE.SphereGeometry(0.05, 8, 6), new THREE.Matrix4().makeTranslation(doorX + 0.36, BASE + 1.0, D / 2 + 0.12), C(0x2a2622));
  for (const s of [-1, 1]) block(wood, [0.13, 2.15, 0.14], [doorX + s * 0.58, BASE + 1.05, D / 2 + 0.05], C(DARK_WOOD[0]!));
  block(wood, [1.3, 0.14, 0.14], [doorX, BASE + 2.12, D / 2 + 0.05], C(DARK_WOOD[0]!));
  block(stone, [1.9, 0.3, 0.9], [doorX, BASE - 0.15, D / 2 + 0.6], C(STONE[2]!), [0, 0, 0], 0.06);
  block(stone, [2.3, 0.3, 0.8], [doorX, BASE - 0.45, D / 2 + 1.2], C(STONE[0]!), [0, 0, 0], 0.06);
  block(stone, [2.6, 0.3, 0.7], [doorX, BASE - 0.75, D / 2 + 1.75], C(STONE[1]!), [0, 0, 0], 0.06);
  for (const s of [-1, 1]) block(wood, [0.16, 2.25, 0.16], [doorX + s * 1.05, BASE + 1.05, D / 2 + 1.25], pick(DARK_WOOD, 861, s + 2));
  slab(roof, [2.7, 0.08, 1.75], [doorX, BASE + 2.55, D / 2 + 0.8], C(0x3d2c1f), [0.32, 0, 0]);
  for (let r = 0; r < 5; r++) {
    for (let k = 0; k < 8; k++) {
      const id = 9000 + r * 10 + k;
      const along = 0.15 + r * 0.34;
      slab(roof, [0.33, 0.035, 0.46], [doorX - 1.2 + k * 0.345 + (r % 2) * 0.1, BASE + 2.86 - Math.sin(0.32) * along, D / 2 - 0.02 + Math.cos(0.32) * along], pick(SHINGLE, 862, id).multiplyScalar(0.85 + rand(863, id) * 0.3), [0.25, (rand(864, id) - 0.5) * 0.05, 0]);
    }
  }

  // ── Двор: поленница, бочка, скамья ──
  const ring = C(0xcaa873);
  const barkColor = C(0x5a4230);
  for (let row = 0; row < 3; row++) {
    for (let k = 0; k < 6 - row; k++) {
      const m = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(-W / 2 - 0.55, BASE * 0 + 0.2 + row * 0.33, -1.9 + k * 0.36 + row * 0.18);
      m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
      wood.add(new THREE.CylinderGeometry(0.17, 0.17, 0.85, 9), m, (_p, n) => (Math.abs(n.x) > 0.9 ? ring.clone().multiplyScalar(0.85 + rand(870, row * 9 + k) * 0.25) : barkColor));
    }
  }
  wood.add(new THREE.CylinderGeometry(0.38, 0.33, 0.95, 14), new THREE.Matrix4().makeTranslation(1.9, 0.48, D / 2 + 0.55), (p) => (Math.abs(p.y - 0.25) < 0.04 || Math.abs(p.y - 0.75) < 0.04 ? C(0x3a3632) : C(0x8a6240)));
  block(wood, [1.7, 0.08, 0.42], [-2.1, 0.5, D / 2 + 0.55], C(WOOD[2]!));
  for (const s of [-1, 1]) block(wood, [0.1, 0.5, 0.36], [-2.1 + s * 0.7, 0.25, D / 2 + 0.55], C(DARK_WOOD[1]!));

  // ── Фонарь у тропы ──
  const lantern: [number, number, number] = [-3.3, 0, D / 2 + 3.1];
  block(wood, [0.14, 2.5, 0.14], [lantern[0], 1.25, lantern[2]], C(DARK_WOOD[0]!));
  block(wood, [0.7, 0.1, 0.1], [lantern[0] + 0.3, 2.42, lantern[2]], C(DARK_WOOD[0]!));
  block(wood, [0.3, 0.06, 0.3], [lantern[0] + 0.58, 2.3, lantern[2]], C(0x2a2622));
  block(wood, [0.26, 0.05, 0.26], [lantern[0] + 0.58, 1.92, lantern[2]], C(0x2a2622));
  glass.add(new THREE.BoxGeometry(0.2, 0.32, 0.2), new THREE.Matrix4().makeTranslation(lantern[0] + 0.58, 2.11, lantern[2]), C(0xffffff));

  // ── Материалы ──
  const grain = (scale: number, amount: number) => attribute('color', 'vec3').mul(mx_noise_float(positionWorld.mul(scale)).mul(amount).add(1)).mul(mx_noise_float(positionWorld.mul(scale * 4.5)).mul(amount * 0.5).add(1));
  const woodMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.86 });
  woodMaterial.colorNode = grain(2.2, 0.16);
  const stoneMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.93 });
  stoneMaterial.colorNode = grain(3.5, 0.2);
  const roofMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  roofMaterial.colorNode = grain(3, 0.14);
  const glassMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x27323c, roughness: 0.25, side: THREE.DoubleSide });
  const flicker = sin(time.mul(6.3)).mul(0.03).add(sin(time.mul(14.7)).mul(0.015)).add(1);
  glassMaterial.emissiveNode = vec3(1.0, 0.68, 0.32).mul(sky.night.mul(3.4).add(float(0.04))).mul(flicker);

  const add = (builder: GeoBuilder, material: THREE.Material, parent: THREE.Object3D, cast = true) => {
    const mesh = new THREE.Mesh(builder.build(), material);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
  };
  add(wood, woodMaterial, house);
  add(stone, stoneMaterial, house);
  add(roof, roofMaterial, house);
  add(glass, glassMaterial, house, false);

  // ── Источники тёплого света ──
  const lights: HouseResult['lights'] = [];
  const warm = (x: number, y: number, z: number, power: number, distance: number) => {
    const light = new THREE.PointLight(0xffb463, 0, distance, 1.8);
    light.position.set(x, y, z);
    house.add(light);
    lights.push({ light, power });
  };
  warm(-2.1, 2.2, D / 2 + 1.2, 22, 11);
  warm(2.2, 2.2, D / 2 + 1.2, 22, 11);
  warm(lantern[0] + 0.58, 2.05, lantern[2], 34, 15);

  // ── Забор за домом и справа (в мировых координатах, по рельефу) ──
  const toWorld = (lx: number, lz: number): [number, number] => {
    const c = Math.cos(HOUSE.yaw);
    const s = Math.sin(HOUSE.yaw);
    return [HOUSE.x + lx * c + lz * s, HOUSE.z - lx * s + lz * c];
  };
  const fenceLine = (points: [number, number][]) => {
    const posts: THREE.Vector3[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i]!;
      const [bx, bz] = points[i + 1]!;
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 1.55));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n;
        const z = az + ((bz - az) * k) / n;
        posts.push(new THREE.Vector3(x, heightAt(x, z), z));
      }
    }
    posts.forEach((p, i) => {
      block(worldWood, [0.13, 1.25, 0.13], [p.x, p.y + 0.5, p.z], pick(WOOD, 880, i).multiplyScalar(0.8), [0, rand(881, i) * 0.4, (rand(882, i) - 0.5) * 0.08]);
      const q = posts[i + 1];
      if (!q) return;
      const length = p.distanceTo(q);
      const yaw = Math.atan2(q.x - p.x, q.z - p.z);
      const pitch = -Math.asin((q.y - p.y) / length);
      for (const h of [0.45, 0.9]) block(worldWood, [0.06, 0.11, length + 0.1], [(p.x + q.x) / 2, (p.y + q.y) / 2 + h, (p.z + q.z) / 2], pick(WOOD, 883, i * 2 + h).multiplyScalar(0.85), [pitch, yaw, 0], 0.02);
    });
  };
  fenceLine([toWorld(6.4, 6.2), toWorld(6.6, -5.6), toWorld(-6.2, -5.8), toWorld(-7.2, 1.6)]);

  // ── Мост через реку: дуга из досок с перилами ──
  const yaw = Math.atan2(bridge.nx, bridge.nz);
  const deckY = (along: number) => bridge.deck - 0.55 * (along / bridge.half) ** 2;
  const at = (along: number, side: number): [number, number] => [bridge.x + bridge.nx * along - bridge.nz * side, bridge.z + bridge.nz * along + bridge.nx * side];
  let plank = 0;
  for (let along = -bridge.half; along <= bridge.half; along += 0.31) {
    const [x, z] = at(along, 0);
    const pitch = Math.atan((1.1 * along) / (bridge.half * bridge.half));
    block(worldWood, [2.5, 0.08, 0.28], [x, deckY(along), z], pick(WOOD, 890, plank++).multiplyScalar(0.85 + rand(891, plank) * 0.25), [pitch, yaw, 0], 0.02);
  }
  for (const side of [-1.12, 1.12]) {
    const postsAlong: number[] = [];
    for (let k = 0; k <= 6; k++) postsAlong.push(-bridge.half + (k / 6) * bridge.half * 2);
    postsAlong.forEach((along, i) => {
      const [x, z] = at(along, side);
      const base = Math.min(deckY(along), heightAt(x, z) + 0.2);
      block(worldWood, [0.15, deckY(along) + 1.05 - base + 0.8, 0.15], [x, (deckY(along) + 1.05 + base - 0.8) / 2, z], pick(DARK_WOOD, 892, i), [0, yaw, 0]);
      const next = postsAlong[i + 1];
      if (next === undefined) return;
      const [x2, z2] = at(next, side);
      const length = Math.hypot(x2 - x, z2 - z, deckY(next) - deckY(along));
      const pitch = -Math.asin((deckY(next) - deckY(along)) / length);
      for (const h of [0.5, 1.0]) block(worldWood, [0.08, 0.1, length + 0.12], [(x + x2) / 2, (deckY(along) + deckY(next)) / 2 + h, (z + z2) / 2], pick(WOOD, 893, i).multiplyScalar(0.8), [pitch, yaw, 0], 0.02);
      // Продольная балка под настилом.
      block(worldWood, [0.16, 0.2, length + 0.1], [(x + x2) / 2 - Math.sign(side) * -0.0, (deckY(along) + deckY(next)) / 2 - 0.15, (z + z2) / 2], C(DARK_WOOD[2]!), [pitch, yaw, 0], 0.02);
    });
  }
  add(worldWood, woodMaterial, group);

  const chimneyTop = new THREE.Vector3(cx, chimneyTopY + 0.5, cz).applyAxisAngle(new THREE.Vector3(0, 1, 0), HOUSE.yaw).add(new THREE.Vector3(HOUSE.x, HOUSE.y, HOUSE.z));
  return { group, chimneyTop, lights };
}
