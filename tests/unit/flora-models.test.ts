// Этап 5 фазы 3: процедурные модели растений. Детерминизм по seed, бюджеты треугольников уровней
// детализации, различие видов по форме (не только по цвету), все виды каталога имеют модель.

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { HERB_PROFILES } from '../../src/render/flora/herbs';
import { WOODY_PROFILES, modelExtent } from '../../src/render/flora/woody';
import { PLANTS } from '../../src/sim/flora/species';

function tris(g: THREE.BufferGeometry): number {
  return g.getAttribute('position').count / 3;
}

/** Описание формы: высота, радиус кроны, высота начала кроны, доля листвы ниже середины, вытянутость. */
function shape(g: THREE.BufferGeometry): number[] {
  const pos = g.getAttribute('position');
  const extra = g.getAttribute('extra');
  const { height, crown } = modelExtent(g);
  let leafMin = Infinity;
  let low = 0;
  let leaves = 0;
  let spread = 0;
  for (let i = 0; i < pos.count; i++) {
    if (extra.getY(i) < 1) continue;
    const y = pos.getY(i);
    leaves++;
    leafMin = Math.min(leafMin, y);
    if (y < height / 2) low++;
    spread += Math.hypot(pos.getX(i), pos.getZ(i));
  }
  return [height, crown / height, leafMin / height, low / leaves, spread / leaves / height];
}

describe('Модели растений', () => {
  it('у каждого вида каталога есть модель', () => {
    for (const p of PLANTS) {
      if (p.form === 'herb') expect(HERB_PROFILES[p.id], p.id).toBeDefined();
      else expect(WOODY_PROFILES[p.id], p.id).toBeDefined();
    }
  });

  it('детерминизм: один seed — та же геометрия; другой — другая (изменчивость внутри вида)', () => {
    for (const p of Object.values(WOODY_PROFILES)) {
      const a = p.build(11, 0).getAttribute('position').array;
      const b = p.build(11, 0).getAttribute('position').array;
      const c = p.build(12, 0).getAttribute('position').array;
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(Array.from(a)).not.toEqual(Array.from(c));
    }
  });

  it('бюджеты треугольников: LOD0 ≤ 4000, LOD1 ≤ 900 и не больше трети LOD0; пучок травы ≤ 400', () => {
    for (const p of Object.values(WOODY_PROFILES)) {
      const t0 = tris(p.build(5, 0));
      const t1 = tris(p.build(5, 1));
      expect(t0, p.id).toBeLessThanOrEqual(4000);
      expect(t1, p.id).toBeLessThanOrEqual(900);
      expect(t1, p.id).toBeLessThanOrEqual(t0 / 3);
    }
    for (const h of Object.values(HERB_PROFILES)) for (const g of h.build()) expect(tris(g), h.id).toBeLessThanOrEqual(400);
  });

  it('деревья различаются формой: у каждой пары видов описание формы расходится заметно', () => {
    const trees = PLANTS.filter((p) => p.form === 'tree').map((p) => ({ id: p.id, s: shape(WOODY_PROFILES[p.id]!.build(3, 0)) }));
    for (let i = 0; i < trees.length; i++) {
      for (let j = i + 1; j < trees.length; j++) {
        const a = trees[i]!.s;
        const b = trees[j]!.s;
        // Сравниваем пропорции (без абсолютной высоты): крона/высота, начало кроны, распределение листвы.
        const diff = Math.max(...a.slice(1).map((v, k) => Math.abs(v - b[k + 1]!) / Math.max(0.05, (v + b[k + 1]!) / 2)));
        expect(diff, `${trees[i]!.id} — ${trees[j]!.id}`).toBeGreaterThan(0.1);
      }
    }
  });

  it('у видов свой лист и своё сезонное поведение', () => {
    const p = WOODY_PROFILES;
    expect(new Set(['birch', 'pine', 'spruce', 'oak', 'linden', 'alder'].map((id) => p[id]!.tile)).size).toBe(6);
    for (const id of ['pine', 'spruce', 'juniper']) expect(p[id]!.evergreen).toBe(true);
    for (const id of ['birch', 'oak', 'linden', 'alder', 'hazel', 'wild-rose', 'willow-shrub']) expect(p[id]!.evergreen).toBe(false);
    // Каталог и рендер согласны: вечнозелёные — те же.
    for (const plant of PLANTS) if (plant.form !== 'herb') expect(p[plant.id]!.evergreen, plant.id).toBe(plant.leafHabit === 'evergreen');
    expect(new Set(Object.values(p).map((x) => x.autumn.getHexString())).size).toBeGreaterThan(5);
  });
});
