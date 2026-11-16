// Камеры (ARCHITECTURE.md, раздел 12.4): стратегическая и свободная, плавный переход, столкновение с рельефом.
// Камера — чисто зрительная сущность: симуляция о ней не знает и от неё не зависит.

import * as THREE from 'three/webgpu';

export type CameraMode = 'strategic' | 'free';

export interface CameraView {
  mode: CameraMode;
  target: [number, number, number];
  yaw: number;
  pitch: number;
  distance: number;
}

const STRATEGIC_FOV = 32;
const FREE_FOV = 55;

export class CameraRig {
  mode: CameraMode = 'strategic';
  readonly camera = new THREE.PerspectiveCamera(STRATEGIC_FOV, 1, 0.5, 30000);
  readonly target = new THREE.Vector3();
  yaw = 0.7;
  pitch = 0.85;
  distance = 2600;
  /** Мировые границы, в которых держится точка интереса. */
  bounds = 4096;
  ground: (x: number, z: number) => number = () => 0;
  onPick: ((x: number, z: number) => void) | null = null;
  onModeChange: ((mode: CameraMode) => void) | null = null;
  private readonly goalTarget = new THREE.Vector3();
  private goalYaw = 0.7;
  private goalPitch = 0.85;
  private goalDistance = 2600;
  private fov = STRATEGIC_FOV;
  private readonly keys = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();

  constructor(private readonly canvas: HTMLCanvasElement) {
    let button = -1;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;
    let downAt = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      button = e.button;
      lastX = downX = e.clientX;
      lastY = downY = e.clientY;
      downAt = performance.now();
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (button === 0 && Math.hypot(e.clientX - downX, e.clientY - downY) < 5 && performance.now() - downAt < 400) this.pick(e.clientX, e.clientY);
      button = -1;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
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
        this.pan(-dx, -dy, (this.goalDistance * 0.0012 * this.fov) / STRATEGIC_FOV);
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.goalDistance *= Math.exp(e.deltaY * 0.0012);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      this.keys.add(e.code);
      if (e.code === 'Tab') {
        e.preventDefault();
        this.setMode(this.mode === 'strategic' ? 'free' : 'strategic');
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private pan(right: number, forward: number, scale: number): void {
    const sin = Math.sin(this.goalYaw);
    const cos = Math.cos(this.goalYaw);
    this.goalTarget.x += (right * cos + forward * sin) * scale;
    this.goalTarget.z += (-right * sin + forward * cos) * scale;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'strategic') {
      this.goalPitch = Math.max(this.goalPitch, 0.75);
      this.goalDistance = Math.max(this.goalDistance, 300);
    } else {
      this.goalPitch = 0.22;
      this.goalDistance = Math.min(this.goalDistance, 60);
    }
    this.onModeChange?.(mode);
  }

  /** Плавный перелёт к точке мира. */
  goTo(x: number, z: number, distance?: number): void {
    this.goalTarget.set(x, this.ground(x, z), z);
    if (distance !== undefined) this.goalDistance = distance;
  }

  /** Мгновенная установка вида (для автоматических проверок и скриншотов). */
  setView(view: Partial<CameraView>): void {
    if (view.mode && view.mode !== this.mode) {
      this.mode = view.mode;
      this.onModeChange?.(view.mode);
    }
    if (view.target) this.goalTarget.set(view.target[0], view.target[1], view.target[2]);
    if (view.yaw !== undefined) this.goalYaw = view.yaw;
    if (view.pitch !== undefined) this.goalPitch = view.pitch;
    if (view.distance !== undefined) this.goalDistance = view.distance;
    this.target.copy(this.goalTarget);
    this.yaw = this.goalYaw;
    this.pitch = this.goalPitch;
    this.distance = this.goalDistance;
    this.fov = this.mode === 'strategic' ? STRATEGIC_FOV : FREE_FOV;
  }

  view(): CameraView {
    return { mode: this.mode, target: [this.target.x, this.target.y, this.target.z], yaw: this.yaw, pitch: this.pitch, distance: this.distance };
  }

  update(dt: number): void {
    const strategic = this.mode === 'strategic';
    const k = this.keys;
    const move = dt * (strategic ? 0.5 : 0.8) * Math.max(10, this.goalDistance);
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const kz = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    if (kx !== 0 || kz !== 0) this.pan(kx, kz, move);
    this.goalYaw += ((k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0)) * dt * 1.2;
    if (k.has('KeyR') || k.has('PageUp')) this.goalDistance *= 1 - dt * 1.5;
    if (k.has('KeyF') || k.has('PageDown')) this.goalDistance *= 1 + dt * 1.5;

    const b = this.bounds;
    this.goalTarget.x = THREE.MathUtils.clamp(this.goalTarget.x, 0, b);
    this.goalTarget.z = THREE.MathUtils.clamp(this.goalTarget.z, 0, b);
    this.goalTarget.y = Math.max(0, this.ground(this.goalTarget.x, this.goalTarget.z)) + (strategic ? 2 : 1.6);
    this.goalDistance = THREE.MathUtils.clamp(this.goalDistance, strategic ? 40 : 3, strategic ? b * 1.5 : 900);
    // Стратегический вид: чем ближе к земле, тем положе взгляд — переход к виду «с плеча» одним колесом.
    const minPitch = strategic ? THREE.MathUtils.lerp(0.3, 0.6, THREE.MathUtils.smoothstep(this.goalDistance, 80, 900)) : 0.02;
    this.goalPitch = THREE.MathUtils.clamp(this.goalPitch, minPitch, strategic ? 1.35 : 1.4);

    const ease = 1 - Math.exp(-dt * 6);
    this.target.lerp(this.goalTarget, ease);
    this.yaw += (this.goalYaw - this.yaw) * ease;
    this.pitch += (this.goalPitch - this.pitch) * ease;
    this.distance += (this.goalDistance - this.distance) * ease;
    this.fov += ((strategic ? STRATEGIC_FOV : FREE_FOV) - this.fov) * ease;

    const cosP = Math.cos(this.pitch);
    const cam = this.camera;
    cam.position.set(this.target.x + Math.sin(this.yaw) * cosP * this.distance, this.target.y + Math.sin(this.pitch) * this.distance, this.target.z + Math.cos(this.yaw) * cosP * this.distance);
    const floor = this.ground(cam.position.x, cam.position.z);
    cam.position.y = Math.max(cam.position.y, Math.max(floor, 0) + 1.5);
    cam.lookAt(this.target);
    const altitude = cam.position.y - Math.max(0, floor);
    const near = THREE.MathUtils.clamp(altitude * 0.02, 0.3, 30);
    const far = Math.max(14000, this.distance * 4);
    if (Math.abs(cam.fov - this.fov) > 0.01 || Math.abs(cam.near - near) > near * 0.1 || cam.far !== far) {
      cam.fov = this.fov;
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  altitude(): number {
    return this.camera.position.y - Math.max(0, this.ground(this.camera.position.x, this.camera.position.z));
  }

  /** Точка рельефа под экранной координатой: шаг по лучу, затем уточнение делением пополам. */
  rayGround(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const p = new THREE.Vector3();
    let prev = 0;
    const step = Math.max(1, this.distance / 400);
    for (let t = 0; t < 30000; t += step * (1 + t / 3000)) {
      p.copy(origin).addScaledVector(direction, t);
      const above = p.y - Math.max(0, this.ground(p.x, p.z));
      if (above <= 0) {
        let lo = prev;
        let hi = t;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          p.copy(origin).addScaledVector(direction, mid);
          if (p.y - Math.max(0, this.ground(p.x, p.z)) > 0) lo = mid;
          else hi = mid;
        }
        return p;
      }
      prev = t;
    }
    return null;
  }

  private pick(clientX: number, clientY: number): void {
    const p = this.rayGround(clientX, clientY);
    if (p && this.onPick && p.x >= 0 && p.z >= 0 && p.x <= this.bounds && p.z <= this.bounds) this.onPick(p.x, p.z);
  }

  /** Пересечение углов экрана с плоскостью точки интереса — рамка видимой области для мини-карты. */
  footprint(): [number, number][] {
    const out: [number, number][] = [];
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.target.y);
    const hit = new THREE.Vector3();
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
      if (this.raycaster.ray.intersectPlane(plane, hit) && hit.distanceTo(this.camera.position) < 20000) out.push([hit.x, hit.z]);
      else {
        // Луч ушёл за горизонт: берём далёкую точку по направлению взгляда.
        const d = this.raycaster.ray.direction;
        out.push([this.camera.position.x + d.x * 6000, this.camera.position.z + d.z * 6000]);
      }
    }
    return out;
  }
}
