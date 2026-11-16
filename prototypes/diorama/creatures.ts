// Существа диорамы: олень-самец, самка, оленёнок и житель. Модели Quaternius (CC0),
// см. assets/manifest.json. При загрузке нормали пересчитываются для сглаженного затенения,
// а материалы заменяются собственными с подобранной палитрой.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Polyline} from './layout';
import { doeLoop, stagLoop, trail, walkHeight } from './layout';

const STAG_PALETTE: Record<string, number> = {
  'Material.003': 0xdcbd90,
  Material: 0xa9764a,
  'Material.010': 0x5c3e29,
  'Material.001': 0x2b2019,
  'Material.011': 0x15110f,
};
const FARMER_PALETTE: Record<string, number> = {
  Skin: 0xe2a57c,
  Brown: 0x8c5b38,
  Brown2: 0x4b3223,
  LightBlue: 0x4d6f9c,
  Beige: 0xdcc48c,
  Eyebrows: 0x3b2a1d,
  Red: 0xb8392f,
  Eye: 0x1a1410,
};

interface Model {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

async function load(url: string, palette: Record<string, number>, hornsColor?: number): Promise<Model> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const cache = new Map<string, THREE.Material>();
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Сглаживание: вершины с одинаковым положением и привязкой к костям объединяются, нормали пересчитываются.
    let g = mesh.geometry;
    g.deleteAttribute('normal');
    g = BufferGeometryUtils.mergeVertices(g, 2e-5);
    g.computeVertexNormals();
    mesh.geometry = g;
    const source = mesh.material as THREE.MeshStandardMaterial;
    const isHorns = hornsColor !== undefined && /horn/i.test(mesh.name);
    const key = isHorns ? '__horns' : source.name;
    let material = cache.get(key);
    if (!material) {
      const hex = isHorns ? hornsColor : palette[source.name];
      material = new THREE.MeshStandardNodeMaterial({ color: hex ?? source.color.getHex(), roughness: isHorns ? 0.6 : 0.85, metalness: 0 });
      cache.set(key, material);
    }
    mesh.material = material;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  });
  return { scene: gltf.scene, clips: gltf.animations };
}

function findClip(clips: THREE.AnimationClip[], name: string): THREE.AnimationClip {
  const clip = clips.find((c) => c.name === name) ?? clips.find((c) => c.name.endsWith(`|${name}`));
  if (!clip) throw new Error(`Нет анимации «${name}»`);
  return clip;
}

/** Высота модели и уровень её подошв в исходных единицах — для приведения к метрам. */
function nativeSize(scene: THREE.Object3D, skipHorns: boolean): { height: number; minY: number } {
  const box = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (skipHorns && /horn/i.test(mesh.name))) return;
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  });
  return { height: box.max.y - box.min.y, minY: box.min.y };
}

export interface ActorOptions {
  path: Polyline;
  /** Замкнутый маршрут или ходьба туда-обратно. */
  loop: boolean;
  speed: number;
  start: number;
  walk: string;
  rests: string[];
  /** Средняя длина перехода между остановками, м. */
  stride: number;
  restSeconds: [number, number];
  animationRate: number;
  /** Точки (длина дуги), в которых существо останавливается обязательно. */
  stops?: number[];
  /** Боковое смещение от маршрута, м. */
  side?: number;
}

export class Actor {
  readonly root = new THREE.Group();
  readonly focus = new THREE.Vector3();
  private readonly mixer: THREE.AnimationMixer;
  private readonly walk: THREE.AnimationAction;
  private readonly rests: THREE.AnimationAction[];
  private current: THREE.AnimationAction;
  private s: number;
  private direction = 1;
  private untilRest: number;
  private restLeft = 0;
  private yaw = 0;
  private turns = 0;

  constructor(
    model: THREE.Object3D,
    clips: THREE.AnimationClip[],
    readonly height: number,
    private readonly o: ActorOptions,
  ) {
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    this.walk = this.mixer.clipAction(findClip(clips, o.walk));
    this.walk.timeScale = o.animationRate;
    this.rests = o.rests.map((name) => this.mixer.clipAction(findClip(clips, name)));
    this.current = this.walk;
    this.walk.play();
    this.s = o.start;
    this.untilRest = o.stride * 0.6;
    this.place(0);
    this.yaw = this.targetYaw();
    this.root.rotation.y = this.yaw;
  }

  /** Курс существа, рад. */
  get heading(): number {
    return this.yaw;
  }

  private fade(to: THREE.AnimationAction): void {
    if (to === this.current) return;
    to.reset().fadeIn(0.45).play();
    this.current.fadeOut(0.45);
    this.current = to;
  }

  private targetYaw(): number {
    const p = this.o.path.at(this.s);
    return Math.atan2(p.tx * this.direction, p.tz * this.direction);
  }

  private place(dt: number): void {
    const p = this.o.path.at(this.s);
    const side = this.o.side ?? 0;
    const x = p.x - p.tz * side;
    const z = p.z + p.tx * side;
    this.root.position.set(x, walkHeight(x, z), z);
    let delta = this.targetYaw() - this.yaw;
    delta -= Math.round(delta / (Math.PI * 2)) * Math.PI * 2;
    this.yaw += delta * Math.min(1, dt * 3.5);
    this.root.rotation.y = this.yaw;
    this.focus.copy(this.root.position);
    this.focus.y += this.height * 0.6;
  }

  update(dt: number): void {
    const o = this.o;
    if (this.restLeft > 0) {
      this.restLeft -= dt;
      if (this.restLeft <= 0) this.fade(this.walk);
    } else {
      const step = o.speed * dt;
      const before = this.s;
      this.s += step * this.direction;
      this.untilRest -= step;
      let rest = this.untilRest <= 0;
      for (const stop of o.stops ?? []) {
        if ((before - stop) * (this.s - stop) < 0) rest = true;
      }
      if (o.loop) {
        this.s = ((this.s % o.path.length) + o.path.length) % o.path.length;
      } else if (this.s >= o.path.length - 0.3 || this.s <= 0.3) {
        this.s = Math.max(0.3, Math.min(o.path.length - 0.3, this.s));
        this.direction = -this.direction;
        rest = true;
      }
      if (rest) {
        this.untilRest = o.stride * (0.7 + ((this.turns * 0.37) % 0.6));
        this.restLeft = o.restSeconds[0] + ((this.turns * 0.61) % 1) * (o.restSeconds[1] - o.restSeconds[0]);
        this.fade(this.rests[this.turns % this.rests.length]!);
        this.turns++;
      }
    }
    this.place(dt);
    this.mixer.update(dt);
  }
}

export interface Creatures {
  group: THREE.Group;
  stag: Actor;
  doe: Actor;
  fawn: Actor;
  farmer: Actor;
  all: Actor[];
}

export async function loadCreatures(base: string): Promise<Creatures> {
  const [stagModel, farmerModel] = await Promise.all([load(`${base}models/stag/Stag.glb`, STAG_PALETTE, 0xd9cbab), load(`${base}models/farmer/Farmer.glb`, FARMER_PALETTE)]);
  const group = new THREE.Group();

  const stagNative = nativeSize(stagModel.scene, true);
  const deer = (height: number, horns: boolean, o: ActorOptions): Actor => {
    const model = SkeletonUtils.clone(stagModel.scene);
    model.scale.setScalar(height / stagNative.height);
    model.position.y = (-stagNative.minY * height) / stagNative.height;
    model.traverse((object) => {
      if (/horn/i.test(object.name)) object.visible = horns;
    });
    const actor = new Actor(model, stagModel.clips, height, o);
    group.add(actor.root);
    return actor;
  };
  const stag = deer(1.62, true, { path: stagLoop, loop: true, speed: 0.95, start: 4, walk: 'Walk', rests: ['Eating', 'Idle', 'Idle_Headlow', 'Idle_2'], stride: 15, restSeconds: [5, 9], animationRate: 0.95 });
  const doe = deer(1.38, false, { path: doeLoop, loop: true, speed: 0.9, start: 20, walk: 'Walk', rests: ['Eating', 'Idle_Headlow', 'Idle'], stride: 12, restSeconds: [5, 10], animationRate: 1.05 });
  const fawn = deer(0.86, false, { path: doeLoop, loop: true, speed: 0.9, start: 16.8, walk: 'Walk', rests: ['Idle', 'Eating', 'Idle_2'], stride: 12, restSeconds: [4, 8], animationRate: 1.7, side: 1.3 });

  const farmerNative = nativeSize(farmerModel.scene, false);
  farmerModel.scene.scale.setScalar(1.76 / farmerNative.height);
  farmerModel.scene.position.y = (-farmerNative.minY * 1.76) / farmerNative.height;
  const farmer = new Actor(farmerModel.scene, farmerModel.clips, 1.76, {
    path: trail,
    loop: false,
    speed: 1.2,
    start: 2,
    walk: 'Walk',
    rests: ['Wave', 'Idle', 'Interact', 'Idle_Neutral'],
    stride: 1e9,
    restSeconds: [4, 6],
    animationRate: 1.0,
    stops: [trail.length * 0.42],
  });
  group.add(farmer.root);
  return { group, stag, doe, fawn, farmer, all: [stag, doe, fawn, farmer] };
}
