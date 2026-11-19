// Рендер растительности (этап 5 фазы 3). Получает только сообщения протокола (FloraWoodyMessage, FloraFieldMessage)
// и ничего не знает о ядре симуляции. Растение существует в рендере, только если оно есть в симуляции:
// каждый экземпляр — строка данных воркера (вид, место, высота, крона, облиственность, номер растения).
//
// Уровни детализации древесных (расстояние от камеры до растения):
//   LOD0 < r0 — ветви и сотни листовых карточек; LOD1 < r1 — тот же силуэт из крупных карточек;
//   импостор < rMax — перекрещенные плоскости; дальше растений нет — полог виден в цвете рельефа.
// На границах уровней экземпляры растворяются попиксельно (materials.ts) — без скачков.
// За rThin импосторы прореживаются: доля p(d) = (rThin/d)² — по рангу растения (детерминированно),
// оставшиеся растягиваются на 1/√p, чтобы покрытие кронами не менялось с расстоянием.
// Отсечение — по чанкам 128 м (усечённая пирамида камеры с запасом).
// Трава — экземпляры пучков вокруг камеры по полю трав: число пучков — по биомассе вида в ячейке,
// места — детерминированно по номеру ячейки (не меняются при движении камеры).

import * as THREE from 'three/webgpu';
import { FLORA_CHUNK_CELLS, FLORA_WOODY_STRIDE, HERB_FIELD_MAX, type FloraFieldMessage, type FloraWoodyMessage, type PlantVisualInfo } from '../../shared/protocol';
import type { WorldData } from '../worldData';
import { rand } from './geometry';
import { HERB_PROFILES, type HerbProfile } from './herbs';
import { herbMaterial, impostorMaterial, windUniforms, woodyMaterial, type WindUniforms } from './materials';
import { lodParts, type LodPart } from './lod';
import { impostorAtlas, leafAtlas } from './textures';
import { WOODY_PROFILES, modelExtent, type WoodyProfile } from './woody';

export interface FloraQuality {
  /** Границы уровней, м. */
  r0: number;
  r1: number;
  rThin: number;
  rMax: number;
  /** Вариантов модели на вид для LOD0 и LOD1. */
  variants0: number;
  variants1: number;
  /** Радиус травы, м, и множитель плотности пучков. */
  grassRadius: number;
  grassDensity: number;
  /** Тени от растений ближних уровней. */
  shadows: boolean;
}

export const FLORA_QUALITY: Record<'low' | 'medium' | 'high', FloraQuality> = {
  low: { r0: 22, r1: 70, rThin: 300, rMax: 1100, variants0: 2, variants1: 2, grassRadius: 30, grassDensity: 0.45, shadows: false },
  medium: { r0: 32, r1: 105, rThin: 450, rMax: 1500, variants0: 3, variants1: 2, grassRadius: 48, grassDensity: 0.7, shadows: true },
  high: { r0: 50, r1: 170, rThin: 700, rMax: 2200, variants0: 3, variants1: 2, grassRadius: 75, grassDensity: 1, shadows: true },
};

/** Строка подготовленного растения: x, y, z, cos, sin, sxz, sy, облиственность, ранг, здоровье, вариант. */
const P = 11;

export interface FloraStats {
  woodyTotal: number;
  chunksLoaded: number;
  lod0: number;
  lod1: number;
  impostors: number;
  grass: number;
  meshes: number;
  rebuildMs: number;
  chunkUpdatesSent: number;
  chunkUpdatesTotal: number;
}

/** Пакет экземпляров: матрицы и чередующийся буфер inst — 12 чисел на экземпляр (iA, iB, iC по 4). */
interface Batch {
  mesh: THREE.InstancedMesh;
  count: number;
  capacity: number;
  matrices: Float32Array;
  inst: Float32Array;
  buffer: THREE.InstancedInterleavedBuffer;
}

const I = 12;

interface SpeciesRender {
  index: number;
  profile: WoodyProfile;
  lod0: Batch[];
  lod1: Batch[];
  impostor: Batch;
  /** Эталонные размеры вариантов (для растяжения до размеров из симуляции). */
  ext0: { height: number; crown: number }[];
  ext1: { height: number; crown: number }[];
  /** Номер столбца в атласе импосторов. */
  column: number;
}

interface ChunkPlants {
  /** Подготовленные строки (P чисел), упорядочены по виду, внутри вида — по рангу. */
  rows: Float32Array;
  /** Для каждого вида каталога: [начало, конец) в rows. */
  ranges: Int32Array;
  cx: number;
  cz: number;
  minY: number;
  maxY: number;
}

interface HerbRender {
  slot: number;
  profile: HerbProfile;
  batches: Batch[];
}

const _frustum = new THREE.Frustum();
const _proj = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

export class FloraView {
  readonly group = new THREE.Group();
  readonly wind: WindUniforms = windUniforms();
  private readonly species: (SpeciesRender | null)[] = [];
  private readonly herbs: HerbRender[] = [];
  private readonly chunks = new Map<number, ChunkPlants>();
  /** Пришедшие, но ещё не подготовленные чанки (подготовка — с бюджетом времени на кадр). */
  private readonly pending = new Map<number, Float32Array>();
  private chunksPerSide = 0;
  private woodyTotal = 0;
  private field: FloraFieldMessage | null = null;
  private herbBytes: Uint8Array | null = null;
  private readonly herbOrder: number[];
  private readonly lastPos = new THREE.Vector3(1e9, 0, 0);
  private readonly lastDir = new THREE.Vector3();
  private lastGrassPos = new THREE.Vector3(1e9, 0, 0);
  private dirty = true;
  private grassDirty = true;
  private yearFrac = 0.3;
  private quality: FloraQuality;
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private stats: FloraStats = { woodyTotal: 0, chunksLoaded: 0, lod0: 0, lod1: 0, impostors: 0, grass: 0, meshes: 0, rebuildMs: 0, chunkUpdatesSent: 0, chunkUpdatesTotal: 0 };
  /** Включён ли рендер растительности (переключатель для проверки: выключенный рендер не меняет мир). */
  enabled = true;

  constructor(
    private readonly data: WorldData,
    plants: PlantVisualInfo[],
    herbOrder: number[],
    quality: FloraQuality,
  ) {
    this.quality = quality;
    this.herbOrder = herbOrder;
    this.group.name = 'flora';
    const leaves = leafAtlas();
    this.textures.push(leaves);
    const woodyMat = woodyMaterial(leaves, this.wind);
    this.materials.push(woodyMat);
    const woody = plants.map((p, i) => ({ p, i })).filter(({ p }) => p.form !== 'herb' && WOODY_PROFILES[p.id]);
    const { texture: impostorTex, columns } = impostorAtlas(woody.map(({ p }) => WOODY_PROFILES[p.id]!.impostor));
    this.textures.push(impostorTex);
    const impMat = impostorMaterial(impostorTex, this.wind);
    this.materials.push(impMat);
    const herbMat = herbMaterial(this.wind);
    this.materials.push(herbMat);

    plants.forEach(() => this.species.push(null));
    woody.forEach(({ p, i }, column) => {
      const profile = WOODY_PROFILES[p.id]!;
      const g0 = Array.from({ length: quality.variants0 }, (_, v) => scaleSway(profile.build(1000 + i * 17 + v, 0), profile.wind));
      const g1 = Array.from({ length: quality.variants1 }, (_, v) => scaleSway(profile.build(1000 + i * 17 + v, 1), profile.wind));
      const render: SpeciesRender = {
        index: i,
        profile,
        lod0: g0.map((g) => this.batch(g, woodyMat, quality.shadows)),
        // Тени отбрасывает только ближний уровень: средний вдвое увеличивал число треугольников кадра.
        lod1: g1.map((g) => this.batch(g, woodyMat, false)),
        impostor: this.batch(impostorGeometry(column, columns, profile), impMat, false),
        ext0: g0.map(modelExtent),
        ext1: g1.map(modelExtent),
        column,
      };
      this.species[i] = render;
    });
    herbOrder.forEach((plant, slot) => {
      const profile = HERB_PROFILES[plants[plant]!.id];
      if (!profile) return;
      const geometries = profile.build().map((g) => scaleSway(g, profile.wind * 0.35));
      this.herbs.push({ slot, profile, batches: geometries.map((g) => this.batch(g, herbMat, false)) });
    });
  }

  private batch(geometry: THREE.BufferGeometry, material: THREE.Material, shadow: boolean, capacity = 64): Batch {
    const b: Batch = { mesh: null as unknown as THREE.InstancedMesh, count: 0, capacity: 0, matrices: new Float32Array(0), inst: new Float32Array(0), buffer: null as unknown as THREE.InstancedInterleavedBuffer };
    this.allocate(b, geometry, material, capacity);
    b.mesh.castShadow = shadow;
    b.mesh.receiveShadow = true;
    return b;
  }

  private allocate(b: Batch, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): void {
    const old = b.mesh;
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color', 'uv', 'extra']) {
      const attr = geometry.getAttribute(name);
      if (attr && !(attr instanceof THREE.InterleavedBufferAttribute)) g.setAttribute(name, attr);
    }
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    b.capacity = capacity;
    b.matrices = new Float32Array(capacity * 16);
    b.inst = new Float32Array(capacity * I);
    b.buffer = new THREE.InstancedInterleavedBuffer(b.inst, I).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(b.buffer, 4, 0));
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(b.buffer, 4, 4));
    g.setAttribute('iC', new THREE.InterleavedBufferAttribute(b.buffer, 4, 8));
    const mesh = new THREE.InstancedMesh(g, material, capacity);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(b.matrices, 16).setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    if (old) {
      mesh.castShadow = old.castShadow;
      mesh.receiveShadow = old.receiveShadow;
      this.group.remove(old);
      old.geometry.dispose();
      old.dispose();
    }
    b.mesh = mesh;
    this.group.add(mesh);
  }

  private ensure(b: Batch, need: number): void {
    if (need <= b.capacity) return;
    const next = Math.max(need, Math.ceil(b.capacity * 1.6), 64);
    const old = b.mesh;
    const material = old.material as THREE.Material;
    const keep = { m: b.matrices, inst: b.inst };
    this.allocate(b, old.geometry, material, next);
    // Уже записанные в этом кадре экземпляры переносятся в новые массивы.
    b.matrices.set(keep.m);
    b.inst.set(keep.inst);
  }

  setQuality(quality: FloraQuality): void {
    this.quality = quality;
    for (const s of this.species) {
      if (!s) continue;
      for (const b of s.lod0) b.mesh.castShadow = quality.shadows;
    }
    this.dirty = true;
    this.grassDirty = true;
  }

  // ───────── данные ─────────

  setWoody(m: FloraWoodyMessage): void {
    this.chunksPerSide = m.chunksPerSide;
    this.woodyTotal = m.total;
    if (m.full) {
      this.chunks.clear();
      this.pending.clear();
    }
    const ids = new Int32Array(m.chunkIds);
    const offsets = new Int32Array(m.offsets);
    const data = new Float32Array(m.data);
    for (let k = 0; k < ids.length; k++) this.pending.set(ids[k]!, data.subarray(offsets[k]! * FLORA_WOODY_STRIDE, offsets[k + 1]! * FLORA_WOODY_STRIDE));
    this.stats.chunkUpdatesSent = ids.length;
    this.stats.chunkUpdatesTotal = m.chunksPerSide * m.chunksPerSide;
  }

  setField(m: FloraFieldMessage): void {
    this.field = m;
    this.herbBytes = new Uint8Array(m.herbs);
    this.data.setCanopy(m.canopy);
    this.grassDirty = true;
  }

  setWind(x: number, z: number, speed: number): void {
    const len = Math.hypot(x, z) || 1;
    this.wind.dir.value.set(x / len, z / len);
    // Скорость ветра, м/с → сила качания: штиль ≈ 0,1, свежий ветер 10 м/с ≈ 1, буря — до 1,6.
    this.wind.strength.value = Math.min(1.6, 0.08 + speed / 10);
  }

  /** Подготовка пришедших чанков: место на рельефе, поворот, растяжение, сортировка по виду и рангу. */
  private processPending(budgetMs: number): void {
    if (this.pending.size === 0) return;
    const start = performance.now();
    for (const [id, raw] of this.pending) {
      this.chunks.set(id, this.prepareChunk(id, raw));
      this.pending.delete(id);
      this.dirty = true;
      if (performance.now() - start > budgetMs) break;
    }
  }

  private prepareChunk(id: number, raw: Float32Array): ChunkPlants {
    const count = raw.length / FLORA_WOODY_STRIDE;
    const nSpecies = this.species.length;
    const counts = new Int32Array(nSpecies + 1);
    for (let r = 0; r < count; r++) counts[raw[r * FLORA_WOODY_STRIDE + 4]! + 1]!++;
    for (let s = 0; s < nSpecies; s++) counts[s + 1]! += counts[s]!;
    const order = new Int32Array(count);
    const fill = counts.slice(0, nSpecies);
    const rank = new Float32Array(count);
    for (let r = 0; r < count; r++) {
      const s = raw[r * FLORA_WOODY_STRIDE + 4]!;
      order[fill[s]!++] = r;
      rank[r] = rand(raw[r * FLORA_WOODY_STRIDE + 6]!, 77);
    }
    // Внутри вида — по рангу: прореживание вдали берёт префикс.
    for (let s = 0; s < nSpecies; s++) {
      const part = order.subarray(counts[s]!, counts[s + 1]!);
      part.sort((a, b) => rank[a]! - rank[b]!);
    }
    const rows = new Float32Array(count * P);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < count; k++) {
      const r = order[k]! * FLORA_WOODY_STRIDE;
      const s = raw[r + 4]!;
      const sp = this.species[s];
      const x = raw[r]!;
      const z = raw[r + 1]!;
      const y = this.data.groundAt(x, z) - 0.15;
      const seed = raw[r + 6]!;
      const yaw = rand(seed, 3) * Math.PI * 2;
      const o = k * P;
      rows[o] = x;
      rows[o + 1] = y;
      rows[o + 2] = z;
      rows[o + 3] = Math.cos(yaw);
      rows[o + 4] = Math.sin(yaw);
      // Высота и крона — из симуляции; небольшая индивидуальная изменчивость формы — по номеру растения.
      rows[o + 5] = raw[r + 3]! * (0.92 + rand(seed, 5) * 0.16);
      rows[o + 6] = raw[r + 2]!;
      rows[o + 7] = raw[r + 5]!;
      rows[o + 8] = rank[order[k]!]!;
      rows[o + 9] = raw[r + 7]!;
      rows[o + 10] = Math.floor(rand(seed, 9) * 6);
      if (sp) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + raw[r + 2]!);
      }
    }
    const cps = this.chunksPerSide;
    return { rows, ranges: counts, cx: id % cps, cz: Math.floor(id / cps), minY: Number.isFinite(minY) ? minY : 0, maxY: Number.isFinite(maxY) ? maxY : 0 };
  }

  // ───────── кадр ─────────

  update(camera: THREE.PerspectiveCamera, yearFrac: number): void {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    this.processPending(3);
    if (Math.abs(yearFrac - this.yearFrac) > 0.002) {
      this.yearFrac = yearFrac;
      this.dirty = true;
      this.grassDirty = true;
    }
    const pos = camera.position;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const moved = pos.distanceTo(this.lastPos);
    const turned = 1 - dir.dot(this.lastDir);
    if (this.dirty || moved > Math.max(1.5, this.altitude(pos) * 0.02) || turned > 0.0015) {
      const t0 = performance.now();
      this.rebuildWoody(camera);
      this.stats.rebuildMs = performance.now() - t0;
      this.lastPos.copy(pos);
      this.lastDir.copy(dir);
      this.dirty = false;
    }
    if (this.grassDirty || pos.distanceTo(this.lastGrassPos) > 2.5) {
      this.rebuildGrass(camera);
      this.lastGrassPos.copy(pos);
      this.grassDirty = false;
    }
  }

  private altitude(pos: THREE.Vector3): number {
    return Math.max(0, pos.y - this.data.groundAt(pos.x, pos.z));
  }

  private rebuildWoody(camera: THREE.PerspectiveCamera): void {
    const q = this.quality;
    for (const s of this.species) {
      if (!s) continue;
      for (const b of s.lod0) b.count = 0;
      for (const b of s.lod1) b.count = 0;
      s.impostor.count = 0;
    }
    camera.updateMatrixWorld();
    _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_proj);
    const cam = camera.position;
    const chunkM = FLORA_CHUNK_CELLS * this.data.cellSize;
    const reach = q.rMax + chunkM;
    const cps = this.chunksPerSide;
    const x0 = Math.max(0, Math.floor((cam.x - reach) / chunkM));
    const x1 = Math.min(cps - 1, Math.floor((cam.x + reach) / chunkM));
    const z0 = Math.max(0, Math.floor((cam.z - reach) / chunkM));
    const z1 = Math.min(cps - 1, Math.floor((cam.z + reach) / chunkM));
    const yf = this.yearFrac;
    const parts: LodPart[] = [];
    let n0 = 0;
    let n1 = 0;
    let nImp = 0;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const chunk = this.chunks.get(cz * cps + cx);
        if (!chunk || chunk.rows.length === 0) continue;
        const centreX = (cx + 0.5) * chunkM;
        const centreZ = (cz + 0.5) * chunkM;
        const centreY = (chunk.minY + chunk.maxY) / 2;
        _sphere.center.set(centreX, centreY, centreZ);
        _sphere.radius = chunkM * 0.75 + (chunk.maxY - chunk.minY) / 2;
        if (!_frustum.intersectsSphere(_sphere)) continue;
        const dCentre = _sphere.center.distanceTo(cam);
        const dMin = Math.max(0, dCentre - _sphere.radius);
        if (dMin > q.rMax) continue;
        const rows = chunk.rows;
        for (let s = 0; s < this.species.length; s++) {
          const sp = this.species[s];
          if (!sp) continue;
          const from = chunk.ranges[s]!;
          const to = chunk.ranges[s + 1]!;
          if (to <= from) continue;
          // Вдали — только префикс по рангу (прореживание); ближе — все.
          const pMax = dMin > q.rThin ? (q.rThin / dMin) ** 2 : 1;
          for (let k = from; k < to; k++) {
            const o = k * P;
            const rank = rows[o + 8]!;
            if (rank > pMax) break;
            const dx = rows[o]! - cam.x;
            const dy = rows[o + 1]! + rows[o + 6]! * 0.5 - cam.y;
            const dz = rows[o + 2]! - cam.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > q.rMax) continue;
            const p = d > q.rThin ? (q.rThin / d) ** 2 : 1;
            if (rank > p) continue;
            const variant = rows[o + 10]!;
            for (const part of lodParts(d, q, parts)) {
              if (part.tier === 0) {
                const v = variant % sp.lod0.length;
                this.put(sp.lod0[v]!, rows, o, sp, sp.ext0[v]!, part.fade, 1, yf);
                n0++;
              } else if (part.tier === 1) {
                const v = variant % sp.lod1.length;
                this.put(sp.lod1[v]!, rows, o, sp, sp.ext1[v]!, part.fade, 1, yf);
                n1++;
              } else {
                // Вдали покрытие кронами сохраняется растяжением оставшихся после прореживания, но не больше чем вдвое.
                this.put(sp.impostor, rows, o, sp, null, part.fade, Math.min(2, 1 / Math.sqrt(p)), yf);
                nImp++;
              }
            }
          }
        }
      }
    }
    let meshes = 0;
    for (const s of this.species) {
      if (!s) continue;
      for (const b of [...s.lod0, ...s.lod1, s.impostor]) meshes += commit(b);
    }
    this.stats.lod0 = n0;
    this.stats.lod1 = n1;
    this.stats.impostors = nImp;
    this.stats.meshes = meshes + this.herbs.reduce((n, h) => n + h.batches.filter((b) => b.count > 0).length, 0);
  }

  /** Экземпляр древесного растения в пакет. ext = null — импостор (геометрия в единицах кроны и высоты). */
  private put(b: Batch, rows: Float32Array, o: number, sp: SpeciesRender, ext: { height: number; crown: number } | null, fade: number, spread: number, yf: number): void {
    if (b.count >= b.capacity) this.ensure(b, b.count + 1);
    const i = b.count++;
    const x = rows[o]!;
    const y = rows[o + 1]!;
    const z = rows[o + 2]!;
    const cos = rows[o + 3]!;
    const sin = rows[o + 4]!;
    const crown = Math.max(0.05, rows[o + 5]!);
    const height = Math.max(0.05, rows[o + 6]!);
    const sxz = (ext ? crown / Math.max(0.1, ext.crown) : crown * 1.08) * spread;
    const sy = (ext ? height / Math.max(0.1, ext.height) : height) * (ext ? 1 : Math.sqrt(spread));
    const m = b.matrices;
    const k = i * 16;
    m[k] = cos * sxz;
    m[k + 1] = 0;
    m[k + 2] = -sin * sxz;
    m[k + 3] = 0;
    m[k + 4] = 0;
    m[k + 5] = sy;
    m[k + 6] = 0;
    m[k + 7] = 0;
    m[k + 8] = sin * sxz;
    m[k + 9] = 0;
    m[k + 10] = cos * sxz;
    m[k + 11] = 0;
    m[k + 12] = x;
    m[k + 13] = y;
    m[k + 14] = z;
    m[k + 15] = 1;
    const leaf = rows[o + 7]!;
    const rank = rows[o + 8]!;
    const health = rows[o + 9]!;
    const v = b.inst;
    const j = i * I;
    v[j] = sp.profile.evergreen ? 1 : leaf;
    v[j + 1] = fade;
    v[j + 2] = this.snowAt(x, z);
    v[j + 3] = rank;
    seasonTint(sp.profile, yf, leaf, health, rank, v, j + 4);
    v[j + 8] = ext ? Math.min(3, height / Math.max(0.1, ext.height)) : height * 0.08;
  }

  private snowAt(x: number, z: number): number {
    const d = this.data;
    const cx = Math.min(d.n - 1, Math.max(0, Math.floor(x / d.cellSize)));
    const cz = Math.min(d.n - 1, Math.max(0, Math.floor(z / d.cellSize)));
    const surface = d.surfaceTex.image.data as Uint8Array;
    // Снег, мм воды (0..120 → 0..255): на ветвях заметен уже при нескольких миллиметрах.
    return Math.min(1, (surface[(cz * d.n + cx) * 4]! / 255) * 6);
  }

  // ───────── трава ─────────

  private rebuildGrass(camera: THREE.PerspectiveCamera): void {
    for (const h of this.herbs) for (const b of h.batches) b.count = 0;
    const herbs = this.herbBytes;
    const field = this.field;
    const q = this.quality;
    const cam = camera.position;
    const R = q.grassRadius;
    let total = 0;
    if (herbs && field && this.altitude(cam) < R * 1.2) {
      const d = this.data;
      const n = d.n;
      const cs = d.cellSize;
      const H = this.herbOrder.length;
      const yf = this.yearFrac;
      const x0 = Math.max(0, Math.floor((cam.x - R) / cs));
      const x1 = Math.min(n - 1, Math.floor((cam.x + R) / cs));
      const z0 = Math.max(0, Math.floor((cam.z - R) / cs));
      const z1 = Math.min(n - 1, Math.floor((cam.z + R) / cs));
      camera.updateMatrixWorld();
      _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_proj);
      const surface = d.surfaceTex.image.data as Uint8Array;
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cz * n + cx;
          if (d.waterKind[c] !== 0) continue;
          const ccx = (cx + 0.5) * cs;
          const ccz = (cz + 0.5) * cs;
          const gy = d.groundAt(ccx, ccz);
          const dc = Math.hypot(ccx - cam.x, gy - cam.y, ccz - cam.z);
          if (dc > R + cs) continue;
          _sphere.center.set(ccx, gy, ccz);
          _sphere.radius = cs;
          if (!_frustum.intersectsSphere(_sphere)) continue;
          const snow = surface[c * 4]! / 255;
          // Под снегом (≥ 4 см воды) травы не видно.
          const snowKeep = clamp01(1 - snow * 9);
          if (snowKeep <= 0) continue;
          for (const h of this.herbs) {
            const v = herbs[c * H + h.slot]!;
            if (v === 0) continue;
            const grams = (v / 255) ** 2 * HERB_FIELD_MAX;
            // У камеры (до 14 м) травостой гуще: там видна каждая травинка; дальше пучки реже, но крупнее.
            const near = dc < 14 + cs ? 2.2 : 1;
            const tufts = Math.min(260, ((grams * cs * cs) / h.profile.gramsPerTuft / 8) * near) * q.grassDensity * snowKeep;
            const heightK = clamp01(Math.log2(1 + grams / 25) / 4);
            const height = h.profile.heightLow + (h.profile.heightHigh - h.profile.heightLow) * heightK;
            for (let j = 0; j < tufts; j++) {
              // Куртины: пучки вида собираются вокруг 3 центров ячейки — луг пятнистый, а не равномерный.
              const clump = Math.floor(rand(c, h.slot, j, 8) * 3);
              const ccx = rand(c, h.slot, clump, 9) * cs;
              const ccz = rand(c, h.slot, clump, 10) * cs;
              const spreadR = cs * (0.35 + rand(c, h.slot, j, 11) * 0.45);
              const ang = rand(c, h.slot, j, 1) * Math.PI * 2;
              const rad = Math.sqrt(rand(c, h.slot, j, 2)) * spreadR;
              const x = cx * cs + Math.min(cs, Math.max(0, ccx + Math.cos(ang) * rad));
              const z = cz * cs + Math.min(cs, Math.max(0, ccz + Math.sin(ang) * rad));
              const y = d.groundAt(x, z);
              const dd = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
              // Дальше половины радиуса — реже, но крупнее; у края — растворение.
              const keep = dd < R * 0.45 ? 1 : Math.max(0.12, ((R * 0.45) / dd) ** 2);
              const rk = rand(c, h.slot, j, 3);
              if (rk > keep) continue;
              const fade = dd > R * 0.85 ? clamp01((R - dd) / (R * 0.15)) : 1;
              if (fade <= 0) continue;
              const b = h.batches[Math.floor(rand(c, h.slot, j, 4) * h.batches.length)]!;
              if (b.count >= b.capacity) this.ensure(b, b.count + 1);
              const i = b.count++;
              const yaw = rand(c, h.slot, j, 5) * Math.PI * 2;
              const spread = 1 / Math.sqrt(keep);
              const sxz = (0.8 + rand(c, h.slot, j, 6) * 0.5) * Math.min(2.2, spread);
              const sy = height * (0.8 + rand(c, h.slot, j, 7) * 0.4);
              const m = b.matrices;
              const k = i * 16;
              const co = Math.cos(yaw);
              const si = Math.sin(yaw);
              m.set([co * sxz, 0, -si * sxz, 0, 0, sy, 0, 0, si * sxz, 0, co * sxz, 0, x, y - 0.02, z, 1], k);
              const v = b.inst;
              const jj = i * I;
              v[jj] = 1;
              v[jj + 1] = fade;
              v[jj + 2] = Math.min(1, snow * 4);
              v[jj + 3] = rk;
              herbTint(h.profile, yf, grams, rk, v, jj + 4);
              v[jj + 8] = sy;
              total++;
            }
          }
        }
      }
    }
    for (const h of this.herbs) for (const b of h.batches) commit(b);
    this.stats.grass = total;
  }

  /**
   * Характерные места по данным растительности (для снимков и проверок): центр клетки 64 м с наибольшей
   * площадью крон берёз, хвойных, всех деревьев; ячейка с наибольшей биомассой цветущих трав; ячейка у реки
   * с наибольшей площадью крон ивы и ольхи.
   */
  findSpots(): Record<string, [number, number] | null> {
    const cell = 64;
    const score = new Map<string, Map<number, number>>();
    const add = (kind: string, x: number, z: number, v: number) => {
      const k = Math.floor(z / cell) * 100000 + Math.floor(x / cell);
      let m = score.get(kind);
      if (!m) score.set(kind, (m = new Map()));
      m.set(k, (m.get(k) ?? 0) + v);
    };
    const d = this.data;
    const nearRiver = (x: number, z: number) => {
      const cx = Math.floor(x / d.cellSize);
      const cz = Math.floor(z / d.cellSize);
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx >= 0 && nz >= 0 && nx < d.n && nz < d.n && d.waterKind[nz * d.n + nx] === 1) return true;
      }
      return false;
    };
    for (const chunk of this.chunks.values()) {
      for (let s = 0; s < this.species.length; s++) {
        const sp = this.species[s];
        if (!sp) continue;
        const id = sp.profile.id;
        for (let k = chunk.ranges[s]!; k < chunk.ranges[s + 1]!; k++) {
          const o = k * P;
          const x = chunk.rows[o]!;
          const z = chunk.rows[o + 2]!;
          const area = chunk.rows[o + 5]! ** 2;
          if (chunk.rows[o + 6]! > 4) {
            add('forest', x, z, area);
            if (id === 'birch') add('birch', x, z, area);
            if (id === 'pine' || id === 'spruce') add('conifer', x, z, area);
          }
          if ((id === 'willow-shrub' || id === 'alder') && nearRiver(x, z)) add('river', x, z, area);
        }
      }
    }
    const herbs = this.herbBytes;
    if (herbs) {
      const H = this.herbOrder.length;
      const slots = this.herbs.filter((h) => h.profile.bloom && ['meadow-flowers', 'clover', 'fireweed'].includes(h.profile.id)).map((h) => h.slot);
      for (let c = 0; c < d.n * d.n; c++) {
        let v = 0;
        for (const sl of slots) v += herbs[c * H + sl]!;
        if (v > 0) add('meadow', (c % d.n + 0.5) * d.cellSize, (Math.floor(c / d.n) + 0.5) * d.cellSize, v * v);
      }
    }
    const out: Record<string, [number, number] | null> = {};
    for (const kind of ['forest', 'birch', 'conifer', 'meadow', 'river']) {
      const m = score.get(kind);
      let best = -1;
      let bestV = -1;
      if (m) for (const [k, v] of m) if (v > bestV) [best, bestV] = [k, v];
      out[kind] = best < 0 ? null : [((best % 100000) + 0.5) * cell, (Math.floor(best / 100000) + 0.5) * cell];
    }
    return out;
  }

  /** Ветер, по которому качаются растения сейчас (для проверки согласованности с погодой). */
  windState(): { dirX: number; dirZ: number; strength: number } {
    return { dirX: this.wind.dir.value.x, dirZ: this.wind.dir.value.y, strength: this.wind.strength.value };
  }

  getStats(): FloraStats {
    return { ...this.stats, woodyTotal: this.woodyTotal, chunksLoaded: this.chunks.size };
  }

  /** Сколько растений каждого вида сейчас показано (для проверки соответствия данным симуляции). */
  shownBySpecies(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.species) {
      if (!s) continue;
      const n = [...s.lod0, ...s.lod1, s.impostor].reduce((a, b) => a + b.mesh.count, 0);
      if (n > 0) out[s.profile.id] = n;
    }
    return out;
  }

  /** Растения в радиусе от точки по данным, пришедшим из симуляции (вид, высота, облиственность). */
  plantsNear(x: number, z: number, radius: number): { species: string; x: number; z: number; height: number; crown: number; leaf: number }[] {
    const out: { species: string; x: number; z: number; height: number; crown: number; leaf: number }[] = [];
    for (const chunk of this.chunks.values()) {
      for (let s = 0; s < this.species.length; s++) {
        const sp = this.species[s];
        if (!sp) continue;
        for (let k = chunk.ranges[s]!; k < chunk.ranges[s + 1]!; k++) {
          const o = k * P;
          if (Math.hypot(chunk.rows[o]! - x, chunk.rows[o + 2]! - z) > radius) continue;
          out.push({ species: sp.profile.id, x: chunk.rows[o]!, z: chunk.rows[o + 2]!, height: chunk.rows[o + 6]!, crown: chunk.rows[o + 5]!, leaf: chunk.rows[o + 7]! });
        }
      }
    }
    return out;
  }

  dispose(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.InstancedMesh) {
        child.geometry.dispose();
        child.dispose();
      }
    }
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function commit(b: Batch): number {
  b.mesh.count = b.count;
  if (b.count === 0) return 0;
  b.mesh.instanceMatrix.clearUpdateRanges();
  b.mesh.instanceMatrix.addUpdateRange(0, b.count * 16);
  b.mesh.instanceMatrix.needsUpdate = true;
  b.buffer.clearUpdateRanges();
  b.buffer.addUpdateRange(0, b.count * I);
  b.buffer.needsUpdate = true;
  return 1;
}

/** Множитель амплитуды ветра вида — запекается в атрибут sway (один материал на все виды). */
function scaleSway(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const extra = g.getAttribute('extra');
  for (let i = 0; i < extra.count; i++) extra.setX(i, extra.getX(i) * k);
  return g;
}

/** Импостор вида: две перекрещенные плоскости (крона радиуса 1, высота 1) и плоскость кроны сверху. */
function impostorGeometry(column: number, columns: number, profile: WoodyProfile): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const nor: number[] = [];
  const u0 = column / columns + 0.002;
  const u1 = (column + 1) / columns - 0.002;
  // Атлас: 4 строки по 0,25; v = 1 − строка·0,25 — сверху вниз; строку выбирает материал (атрибут rows).
  const side = (ax: number, az: number) => {
    const quad = [
      [-ax, 0, -az, u0, 0],
      [ax, 0, az, u1, 0],
      [ax, 1, az, u1, 0.25],
      [-ax, 0, -az, u0, 0],
      [ax, 1, az, u1, 0.25],
      [-ax, 1, -az, u0, 0.25],
    ];
    for (const [x, y, z, u, v] of quad) {
      pos.push(x!, y!, z!);
      uvs.push(u!, v!);
      nor.push(0, 1, 0);
    }
  };
  side(1, 0);
  side(0, 1);
  const sideVerts = pos.length / 3;
  const top = profile.impostor.shape === 'cone' || profile.impostor.shape === 'column' ? 0.55 : profile.impostor.shape === 'umbrella' ? 0.8 : 0.7;
  const quad = [
    [-1, top, -1, u0, 0],
    [1, top, -1, u1, 0],
    [1, top, 1, u1, 0.25],
    [-1, top, -1, u0, 0],
    [1, top, 1, u1, 0.25],
    [-1, top, 1, u0, 0.25],
  ];
  for (const [x, y, z, u, v] of quad) {
    pos.push(x! * 0.85, y!, z! * 0.85);
    uvs.push(u!, v!);
    nor.push(0, 1, 0);
  }
  const verts = pos.length / 3;
  // rows: сдвиг v для «в листве» и «без листвы»: сбоку — строки 0 и 1, сверху — 2 и 3 (v отсчитывается снизу).
  const rows = new Float32Array(verts * 2);
  for (let i = 0; i < verts; i++) {
    const isTop = i >= sideVerts;
    rows[i * 2] = isTop ? 0.25 : 0.75;
    rows[i * 2 + 1] = isTop ? 0 : 0.5;
  }
  const extra = new Float32Array(verts * 3);
  for (let i = 0; i < verts; i++) {
    extra[i * 3] = pos[i * 3 + 1]! * 0.6;
    extra[i * 3 + 1] = rows[i * 2]!;
    extra[i * 3 + 2] = rows[i * 2 + 1]!;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('extra', new THREE.Float32BufferAttribute(extra, 3));
  return g;
}

const _c = new THREE.Color();
const _w = new THREE.Color();

/**
 * Сезонный цвет листвы экземпляра. Время года — из времени мира; облиственность — из симуляции.
 * Осенний цвет появляется у листопадных с середины осени, у каждого растения — со своим сдвигом.
 */
function seasonTint(p: WoodyProfile, yf: number, leaf: number, health: number, rank: number, out: Float32Array, o: number): void {
  _c.copy(p.summer);
  if (!p.evergreen) {
    const shift = (rank - 0.5) * 0.05;
    const autumn = smooth(0.54 + shift, 0.66 + shift, yf) * (yf < 0.8 ? 1 : 0) + (yf >= 0.8 && leaf > 0.02 ? 1 : 0);
    const spring = (1 - smooth(0.06, 0.2, yf)) * (yf < 0.3 ? 1 : 0);
    _c.lerp(p.autumn, autumn);
    _c.lerp(p.spring, spring * (1 - autumn));
  } else if (yf > 0.75 || yf < 0.04) {
    // Зимой хвоя темнее и тусклее.
    _c.multiplyScalar(0.86);
  }
  // Ослабленные растения бледнее; лёгкая индивидуальная изменчивость.
  _w.setRGB(0.86, 0.82, 0.55);
  _c.lerp(_w, (1 - health) * 0.35);
  const v = 0.9 + rank * 0.2;
  out[o] = _c.r * v;
  out[o + 1] = _c.g * v;
  out[o + 2] = _c.b * v;
  // Цветение и плоды.
  const bl = p.blossom;
  let bloom = 0;
  if (bl) {
    if (yf >= bl.from && yf <= bl.to) bloom = Math.min(1, Math.min(yf - bl.from, bl.to - yf) / 0.05);
    else if (bl.fruit && yf > 0.55 && yf < 0.85 && leaf > 0.05) bloom = 1 + Math.min(1, (yf - 0.55) / 0.05);
  }
  out[o + 3] = bloom;
}

function herbTint(p: HerbProfile, yf: number, grams: number, rank: number, out: Float32Array, o: number): void {
  // Весна — свежая зелень, лето — полная, осень — желтеет, зима — сухая (если травы ещё видны).
  _c.setRGB(1, 1, 1);
  const spring = (1 - smooth(0.05, 0.22, yf)) * (yf < 0.3 ? 1 : 0);
  const autumn = smooth(0.52, 0.7, yf) * (yf < 0.98 ? 1 : 0);
  _w.setRGB(1.08, 1.12, 0.82);
  _c.lerp(_w, spring * 0.6);
  _c.lerp(p.autumn, autumn);
  if (grams < 20) _c.lerp(_w.setRGB(0.85, 0.8, 0.55), (1 - grams / 20) * 0.5);
  const v = 0.88 + rank * 0.24;
  out[o] = _c.r * v;
  out[o + 1] = _c.g * v;
  out[o + 2] = _c.b * v;
  let bloom = 0;
  if (p.bloom) {
    const [a, b] = p.bloom;
    if (yf >= a && yf <= b) bloom = Math.min(1, Math.min(yf - a, b - yf) / 0.04);
  }
  out[o + 3] = bloom;
}

function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
