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

  it('Genesis: нет и семян, подготовки нет', () => {
    const sim = simulation({ seed: 42, scenario: 'genesis' });
    expect(sim.world.flora.seedBank.every((v) => v === 0)).toBe(true);
    expect(sim.preparation).toBeNull();
    expect(sim.world.flora.regionalSeedRain).toBe(false);
  });

  it('Wildlands до подготовки: ни одного растения, почвенный банк семян только на суше, подготовка на 20 лет', () => {
    const sim = simulation({ seed: 42 }, 0, 20);
    const { geo, flora } = sim.world;
    const count = geo.n * geo.n;
    let landWithBank = 0;
    let land = 0;
    for (let i = 0; i < count; i++) {
      expect(herbBiomass(flora, i)).toBe(0);
      let bank = 0;
      for (let h = 0; h < SPECIES.herbs.length; h++) bank += flora.seedBank[h * count + i]!;
      if (geo.waterKind[i] === WaterKind.None) {
        land++;
        if (bank > 0) landWithBank++;
      } else expect(bank).toBe(0);
    }
    expect(flora.woody.count).toBe(0);
    expect(landWithBank / land).toBeGreaterThan(0.7);
    expect(sim.preparation?.years).toBe(20);
    expect(flora.regionalSeedRain).toBe(true);
    expect(PLANTS.filter((p) => p.form === 'herb').length).toBe(SPECIES.herbs.length);
    expect(SLOTS).toBe(4);
    expect(NO_SPECIES).toBe(255);
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
