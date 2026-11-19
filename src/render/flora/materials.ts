// Материалы растительности (TSL; один и тот же код для WebGPU и WebGL 2).
// Атрибут вершины extra = (sway, part, rnd) (flora/geometry.ts); у импостора extra = (sway, v «в листве», v «без листвы»).
// Экземплярные атрибуты (заполняет FloraView; один чередующийся буфер):
//   iA = (облиственность 0..1, растворение LOD, снег 0..1, ранг 0..1)
//   iB = (множитель цвета листвы r, g, b, цветение: 0..1 — цветки, 1..2 — плоды)
//   iC = (масштаб ветра — высота экземпляра к эталону, 0, 0, 0)
// Растворение LOD: fade > 0 — рисовать там, где шум экрана < fade; fade < 0 — где шум ≥ 1 + fade.
// Пара экземпляров (ближний и дальний уровень) с fade = 1 − t и −t даёт попиксельно дополняющие друг друга
// изображения — переход без скачка и без полупрозрачности.
// Ветер — из модели погоды (направление и скорость передаются в uniforms каждый шаг погоды).

import * as THREE from 'three/webgpu';
import { abs, attribute, dot, float, interleavedGradientNoise, mix, mx_noise_float, normalWorld, positionLocal, positionWorld, screenCoordinate, sin, smoothstep, step, texture, time, transformNormalToView, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { UniformNode } from 'three/webgpu';

export interface WindUniforms {
  dir: UniformNode<'vec2', THREE.Vector2>;
  strength: UniformNode<'float', number>;
}

export function windUniforms(): WindUniforms {
  return { dir: uniform(new THREE.Vector2(1, 0)), strength: uniform(0.3) };
}

/** Видимость по растворению LOD (общая для всех уровней). */
function fadeVisible() {
  const iA = attribute('iA', 'vec4');
  const dither = interleavedGradientNoise(screenCoordinate.xy);
  const f = iA.y;
  const positive = step(dither, f);
  const negative = step(f.add(1), dither);
  return mix(positive, negative, step(f, 0));
}

/** Смещение вершины ветром: изгиб по направлению ветра, порывы и мелкая дрожь листвы. */
function windPosition(w: WindUniforms, amplitude: number) {
  const iC = attribute('iC', 'vec4');
  const sway = attribute('extra', 'vec3').x.mul(iC.x).mul(amplitude);
  const p = positionLocal;
  const along = dot(vec2(p.x, p.z), w.dir);
  const gust = sin(time.mul(0.55).sub(along.mul(0.018))).mul(0.5).add(0.5);
  const s = w.strength;
  const bend = s.mul(s).mul(0.55).add(s.mul(gust).mul(0.45));
  const wave = sin(time.mul(1.6).sub(along.mul(0.12)).add(p.x.mul(0.07))).mul(s.mul(0.35).add(0.06));
  const flutter = sin(time.mul(6.3).add(p.x.mul(2.1)).add(p.y.mul(2.9)).add(p.z.mul(1.7))).mul(s.mul(0.18).add(0.03));
  const push = bend.add(wave);
  const dx = w.dir.x.mul(push).sub(w.dir.y.mul(flutter));
  const dz = w.dir.y.mul(push).add(w.dir.x.mul(flutter));
  // Наклон опускает конец ветви — без «растяжения» растения по ветру.
  return p.add(vec3(dx, abs(push).mul(-0.25), dz).mul(sway));
}

/** Деревья и кустарники (LOD0, LOD1): кора, листовые карточки атласа, цветки и плоды. */
export function woodyMaterial(atlas: THREE.Texture, wind: WindUniforms): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
  m.alphaTest = 0.5;
  const extra = attribute('extra', 'vec3');
  const part = extra.y;
  const rnd = extra.z;
  const iA = attribute('iA', 'vec4');
  const iB = attribute('iB', 'vec4');
  const vcol = attribute('color', 'vec3');
  const tex = texture(atlas, uv());
  const isWood = float(1).sub(step(0.5, part));
  const isLeaf = step(0.5, part).mul(float(1).sub(step(1.5, part)));
  const isBloom = step(1.5, part);
  const leafOn = step(rnd, iA.x);
  const fruit = step(1, iB.w);
  const bloomOn = step(rnd, iB.w.sub(fruit));
  const bark = vcol.mul(mx_noise_float(vec3(positionWorld.x.mul(3.5), positionWorld.y.mul(0.8), positionWorld.z.mul(3.5))).mul(0.22).add(1));
  const leaf = tex.rgb.mul(vcol).mul(iB.xyz);
  const bloom = mix(vcol, vec3(0.75, 0.13, 0.12), fruit);
  let col = bark.mul(isWood).add(leaf.mul(isLeaf)).add(bloom.mul(isBloom));
  // Снег на верхних поверхностях кроны и ветвей.
  const snowK = iA.z.mul(smoothstep(0.15, 0.75, normalWorld.y));
  col = mix(col, vec3(0.93, 0.95, 0.98), snowK.mul(0.85));
  const visible = isWood.add(isLeaf.mul(tex.a).mul(leafOn)).add(isBloom.mul(bloomOn));
  // Альфа цвета — видимость без растворения LOD: по ней проход теней (alphaTest) отбрасывает невидимое —
  // голая крона отбрасывает тень только ветвями. (maskShadowNode в three 0.187 перестраивал конвейер теней
  // на каждый объект — кадр 2 с; альфа цвета — штатный путь.)
  m.colorNode = vec4(col, visible);
  m.opacityNode = visible.mul(fadeVisible());
  // Листва освещается как объём (нормаль карточки — от центра кроны), кора — по своим нормалям.
  m.positionNode = windPosition(wind, 1);
  return m;
}

/** Импосторы: перекрещенные плоскости сбоку и плоскость сверху из атласа импосторов. */
export function impostorMaterial(atlas: THREE.Texture, wind: WindUniforms): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  m.alphaTest = 0.5;
  const iA = attribute('iA', 'vec4');
  const iB = attribute('iB', 'vec4');
  const rows = attribute('extra', 'vec3').yz; // (строка «в листве», строка «без листвы») — сдвиг v
  const dither = interleavedGradientNoise(screenCoordinate.xy);
  // Облиственность: попиксельно выбираем изображение «в листве» или «без листвы».
  const leafy = step(dither, iA.x);
  const base = uv();
  const v = base.y.add(mix(rows.y, rows.x, leafy));
  const tex = texture(atlas, vec2(base.x, v));
  const snowK = iA.z.mul(0.6);
  m.colorNode = mix(tex.rgb.mul(mix(vec3(1), iB.xyz, leafy)), vec3(0.92, 0.94, 0.97), snowK);
  m.opacityNode = tex.a.mul(fadeVisible());
  m.normalNode = transformNormalToView(vec3(0, 1, 0));
  m.positionNode = windPosition(wind, 0.5);
  return m;
}

/** Травы и цветы: цвет вершин × сезонный множитель экземпляра; соцветия — в окно цветения. */
export function herbMaterial(wind: WindUniforms): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  m.alphaTest = 0.5;
  const extra = attribute('extra', 'vec3');
  const part = extra.y;
  const rnd = extra.z;
  const iA = attribute('iA', 'vec4');
  const iB = attribute('iB', 'vec4');
  const vcol = attribute('color', 'vec3');
  const isBloom = step(1.5, part);
  const bloomOn = step(rnd, iB.w);
  const col = mix(vcol.mul(iB.xyz), vcol, isBloom);
  const snowK = iA.z;
  m.colorNode = mix(col, vec3(0.92, 0.94, 0.97), snowK.mul(0.7));
  m.opacityNode = float(1).sub(isBloom).add(isBloom.mul(bloomOn)).mul(fadeVisible());
  // Травинки освещаются как покров (нормаль вверх), иначе тонкие ленты темнеют сбоку.
  m.normalNode = transformNormalToView(vec3(0, 1, 0));
  m.positionNode = windPosition(wind, 1);
  return m;
}
