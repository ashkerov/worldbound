// Этап 5 фазы 3: переходы уровней детализации без скачков — покрытие пикселей в сумме всегда 1
// (кроме дальнего края, где растения плавно уходят в цвет полога), уровни меняются монотонно.

import { describe, expect, it } from 'vitest';
import { FLORA_QUALITY } from '../../src/render/flora/FloraView';
import { coverage, lodParts } from '../../src/render/flora/lod';

describe('Уровни детализации растений', () => {
  for (const [name, q] of Object.entries(FLORA_QUALITY)) {
    it(`${name}: сумма покрытий = 1 до дальнего края, переход непрерывный, уровень растёт с расстоянием`, () => {
      let prevTier = 0;
      let prevSum = 1;
      for (let d = 0; d <= q.rMax * 1.05; d += 0.25) {
        const parts = lodParts(d, q);
        const sum = parts.reduce((a, p) => a + coverage(p), 0);
        if (d < q.rMax * 0.85) expect(sum).toBeCloseTo(1, 9);
        // Непрерывность: за шаг 0,25 м покрытие меняется мало.
        expect(Math.abs(sum - prevSum)).toBeLessThan(0.02);
        prevSum = sum;
        const tier = parts.length ? Math.max(...parts.map((p) => p.tier)) : 2;
        expect(tier).toBeGreaterThanOrEqual(prevTier);
        prevTier = tier;
        // В полосе перехода — ровно два соседних уровня с дополняющими растворениями.
        if (parts.length === 2) {
          expect(parts[1]!.tier - parts[0]!.tier).toBe(1);
          expect(parts[0]!.fade).toBeGreaterThan(0);
          expect(parts[1]!.fade).toBeLessThan(0);
        }
      }
      expect(lodParts(q.rMax + 1, q)).toEqual([]);
    });
  }
});
