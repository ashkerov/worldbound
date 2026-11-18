// Динамика растительности на опытных участках с заданными условиями: отклик на воду и свет,
// рост древесных, сезонность, сохранение вещества за 20 лет (критерий 3), детерминизм (критерий 6).

import { describe, expect, it } from 'vitest';
import { NO_SPECIES, PLANTS, SPECIES, speciesIndex } from '../../src/sim/flora/species';
import { Ledger, SLOTS, nutrientBudget, nutrientStock } from '../../src/sim/flora/state';
import type { Simulation } from '../../src/sim/core/simulation';
import { plotSimulation, runDays } from '../support/plot';


const DAYS_PER_YEAR = 20;
const WET = { precip: 900, soil: 'loam', fertility: 0.8 } as const;
const DRY = { precip: 260, soil: 'sand', fertility: 0.3, tMean: 11 } as const;

function herbsBySpecies(sim: Simulation): Record<string, number> {
  const f = sim.world.flora;
  const cells = sim.world.geo.n * sim.world.geo.n;
  const out: Record<string, number> = {};
  for (let k = 0; k < cells * SLOTS; k++) {
    const s = f.slotSpecies[k]!;
    if (s !== NO_SPECIES) out[PLANTS[s]!.id] = (out[PLANTS[s]!.id] ?? 0) + f.slotBiomass[k]! / cells;
  }
  return out;
}

const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function woodyMass(sim: Simulation): number {
  const w = sim.world.flora.woody;
  let m = 0;
  for (let i = 0; i < w.highWater; i++) if (w.alive[i] === 1) m += w.biomass[i]!;
  return m;
}

function balanceError(sim: Simulation): number {
  const f = sim.world.flora;
  const initial = f.ledger[Ledger.initialStock]!;
  return Math.abs(nutrientStock(f, sim.world.geo) - initial - nutrientBudget(f)) / initial;
}

/** Середина лета года y (сутки от начала мира, мир стартует в середине весны). */
const midsummerOf = (sim: Simulation, years: number) => {
  const target = ((years - 1) * DAYS_PER_YEAR + 7.5) * 7200;
  while (sim.world.tick < target) sim.step();
};

describe('Отклик на воду: влажный участок — луг, сухой — степь', () => {
  const wet = plotSimulation(WET);
  const dry = plotSimulation(DRY);
  midsummerOf(wet, 3);
  midsummerOf(dry, 3);
  const wetHerbs = herbsBySpecies(wet);
  const dryHerbs = herbsBySpecies(dry);

  it('на сухом участке господствует ковыль, на влажном — луговые травы', () => {
    const dom = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1])[0]![0];
    expect(dom(dryHerbs)).toBe('feather-grass');
    expect(['meadow-grass', 'clover', 'meadow-flowers', 'fireweed', 'sedge']).toContain(dom(wetHerbs));
    expect(wetHerbs['feather-grass'] ?? 0).toBeLessThan(1);
  });

  it('травяной ярус держит правдоподобную биомассу (г/м²) и не исчезает', () => {
    expect(total(wetHerbs)).toBeGreaterThan(100);
    expect(total(wetHerbs)).toBeLessThan(900);
    expect(total(dryHerbs)).toBeGreaterThan(60);
  });

  it('древесные на влажном плодородном участке растут; влага почвы различается', () => {
    expect(wet.world.flora.dayW[100]!).toBeGreaterThan(dry.world.flora.dayW[100]!);
    expect(woodyMass(wet)).toBeGreaterThan(0);
  });
});

describe('Рост дерева по аллометрии и сезонность', () => {
  it('берёза на открытом влажном участке набирает массу, лиственная — облиственна летом и голая зимой', () => {
    const sim = plotSimulation(WET, { scenario: 'genesis' });
    const w = sim.world.flora.woody;
    const birch = speciesIndex('birch');
    const id = w.spawn(birch, 128, 128, 16 * 32 + 16, 0.5, 2);
    midsummerOf(sim, 1);
    expect(w.leaf[id]).toBeGreaterThan(0.9);
    const summer = w.biomass[id]!;
    runDays(sim, 10); // середина зимы
    expect(w.leaf[id]).toBeLessThan(0.1);
    midsummerOf(sim, 4);
    expect(w.alive[id]).toBe(1);
    expect(w.biomass[id]!).toBeGreaterThan(summer * 3);
    // Листопад вернул вещество в опад.
    expect(sim.world.flora.ledger[Ledger.litterfall]).toBeGreaterThan(0);
  });

  it('вечнозелёная сосна остаётся с хвоей зимой', () => {
    const sim = plotSimulation(DRY, { scenario: 'genesis' });
    const w = sim.world.flora.woody;
    const id = w.spawn(speciesIndex('pine'), 128, 128, 16 * 32 + 16, 0.5, 2);
    runDays(sim, 15);
    expect(w.leaf[id]).toBe(1);
  });
});

describe('Свет: травы под пологом', () => {
  it('под сомкнутым пологом светолюбивый мятлик даёт меньше биомассы, чем на открытом месте', () => {
    const open = plotSimulation(WET);
    const shaded = plotSimulation(WET);
    const w = shaded.world.flora.woody;
    const spruce = speciesIndex('spruce');
    // Взрослые ели в каждой ячейке левой половины участка.
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 16; x++) {
        w.spawn(spruce, x * 8 + 2, z * 8 + 2, z * 32 + x, 900, 60);
        w.spawn(spruce, x * 8 + 6, z * 8 + 6, z * 32 + x, 900, 60);
      }
    }
    midsummerOf(open, 2);
    midsummerOf(shaded, 2);
    const meadow = speciesIndex('meadow-grass');
    const half = (sim: Simulation) => {
      const f = sim.world.flora;
      let b = 0;
      for (let z = 0; z < 32; z++) for (let x = 0; x < 16; x++) for (let k = 0; k < SLOTS; k++) if (f.slotSpecies[(z * 32 + x) * SLOTS + k] === meadow) b += f.slotBiomass[(z * 32 + x) * SLOTS + k]!;
      return b;
    };
    expect(shaded.world.flora.treeCover[5 * 32 + 5]!).toBeGreaterThan(0.5);
    expect(half(shaded)).toBeLessThan(half(open) * 0.5);
  });
});

describe('Критерий 3: баланс элемента питания за 20 игровых лет', () => {
  for (const [name, plot] of [
    ['влажный плодородный участок', WET],
    ['сухой бедный участок', DRY],
  ] as const) {
    it(`${name}: изменение запаса = выветривание + фиксация − вымывание (погрешность ≤ 10⁻⁴)`, () => {
      const sim = plotSimulation(plot);
      // Дополнительно — взрослые деревья, чтобы через баланс прошли гибель, листопад и древесный опад.
      const w = sim.world.flora.woody;
      for (let k = 0; k < 40; k++) w.spawn(k % 2 ? speciesIndex('alder') : speciesIndex('birch'), (k % 8) * 30 + 10, Math.floor(k / 8) * 40 + 20, Math.floor((Math.floor(k / 8) * 40 + 20) / 8) * 32 + Math.floor(((k % 8) * 30 + 10) / 8), 40, 15);
      // Деревья, добавленные тестом, входят в начальный запас (точку отсчёта баланса).
      sim.world.flora.ledger[Ledger.initialStock] = nutrientStock(sim.world.flora, sim.world.geo);
      runDays(sim, 20 * DAYS_PER_YEAR);
      const f = sim.world.flora;
      expect(f.ledger[Ledger.weathering]).toBeGreaterThan(0);
      expect(f.ledger[Ledger.fixation]).toBeGreaterThan(0);
      expect(f.ledger[Ledger.decomposition]).toBeGreaterThan(0);
      expect(balanceError(sim)).toBeLessThan(1e-4);
      // Отрицательных запасов нет.
      let negative = 0;
      for (let i = 0; i < f.nutrient.length; i++) if (f.nutrient[i]! < 0 || f.litterFast[i]! < 0 || f.litterWood[i]! < 0) negative++;
      expect(negative).toBe(0);
    }, 300_000);
  }
});

describe('Критерий 6: детерминизм растительности', () => {
  it('одинаковые условия дают побитно одинаковое состояние; другой seed — другое', () => {
    const a = plotSimulation(WET);
    const b = plotSimulation(WET);
    const c = plotSimulation(WET, { seed: 8 });
    for (const s of [a, b, c]) runDays(s, 30);
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.stateHash()).not.toBe(c.stateHash());
    expect(SPECIES.count).toBe(PLANTS.length);
  });
});
