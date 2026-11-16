// Состояние растительности после создания мира: сценарии, точка отсчёта баланса вещества.

import { describe, expect, it } from 'vitest';
import { NO_SPECIES, PLANTS, SPECIES } from '../../src/sim/flora/species';
import { Ledger, SLOTS, herbBiomass, nutrientBudget, nutrientStock } from '../../src/sim/flora/state';
import { WaterKind } from '../../src/sim/worldgen/geo';
import { simulation } from '../support/worlds';

describe('Начальное заселение', () => {
  it('Genesis: растений нет вообще', () => {
    const sim = simulation({ seed: 42, scenario: 'genesis' });
    const f = sim.world.flora;
    expect(f.slotSpecies.every((s) => s === NO_SPECIES)).toBe(true);
    expect(f.woody.count).toBe(0);
  });

  it('Дикая природа: травяной покров на суше, редкий подрост древесных подходящих видов', () => {
    const sim = simulation({ seed: 42 });
    const { geo, flora } = sim.world;
    let land = 0;
    let covered = 0;
    let onWater = 0;
    for (let i = 0; i < geo.n * geo.n; i++) {
      const b = herbBiomass(flora, i);
      if (geo.waterKind[i] === WaterKind.None) {
        land++;
        if (b > 0) covered++;
      } else if (b > 0) onWater++;
    }
    expect(covered / land).toBeGreaterThan(0.7);
    expect(onWater).toBe(0);
    const w = flora.woody;
    expect(w.count).toBeGreaterThan(50);
    expect(w.count).toBeLessThan(land * 0.05);
    for (let i = 0; i < w.highWater; i++) {
      expect(SPECIES.woody[w.species[i]!]).toBe(1);
      expect(geo.waterKind[w.cell[i]!]).toBe(WaterKind.None);
    }
    // В слотах трав — только травы.
    for (let k = 0; k < flora.slotSpecies.length; k++) {
      const s = flora.slotSpecies[k]!;
      if (s !== NO_SPECIES) expect(PLANTS[s]!.form).toBe('herb');
    }
    expect(SLOTS).toBe(4);
  });

  it('ведомость начинается с полного запаса и нулевых потоков', () => {
    const sim = simulation({ seed: 42 });
    const f = sim.world.flora;
    expect(f.ledger[Ledger.initialStock]).toBeCloseTo(nutrientStock(f, sim.world.geo), 0);
    expect(nutrientBudget(f)).toBe(0);
  });

  it('заселение детерминировано и не меняет статику мира', () => {
    const a = simulation({ seed: 42 });
    const b = simulation({ seed: 42 });
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.world.geoHash).toBe(simulation({ seed: 42, scenario: 'genesis' }).world.geoHash);
    expect(a.stateHash()).not.toBe(simulation({ seed: 42, scenario: 'genesis' }).stateHash());
  });
});
