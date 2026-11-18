// Проверка дефекта из ревизии заказчика: рост нескольких видов травяного яруса от общей биомассы,
// посчитанной до цикла по видам, не должен выводить сумму за вместимость ячейки.

import { describe, expect, it } from 'vitest';
import { SPECIES, speciesIndex } from '../../src/sim/flora/species';
import { Ledger, MAX_WOODY_PER_CELL, SLOTS, WOODY_PER_CELL_MEAN, nutrientBudget, nutrientStock, woodyCapacity } from '../../src/sim/flora/state';
import { refreshCover } from '../../src/sim/flora/system';
import { MAX_INDEX } from '../../src/shared/ids';
import { lightResponse, moistureResponse, soilResponse, tempResponse } from '../../src/sim/flora/suitability';
import { plotGeo, plotSimulation, runDays } from '../support/plot';

const IDS = ['meadow-grass', 'fireweed', 'clover', 'meadow-flowers'];

describe('Вместимость ячейки для травяного яруса', () => {
  for (const days of [5, 3]) {
    it(`сумма биомассы видов не превышает вместимость лучшего из них (сезон ${days} сут., ${IDS.length} вида)`, () => {
      const sim = plotSimulation({ precip: 750, soil: 'loam', fertility: 1 }, { scenario: 'genesis', isolated: true, daysPerSeason: days });
      const f = sim.world.flora;
      const cells = sim.world.geo.n * sim.world.geo.n;
      const species = IDS.map(speciesIndex);
      // Много питания, чтобы рост ограничивала именно вместимость.
      for (let c = 0; c < cells; c++) {
        f.nutrient[c] = 50;
        species.forEach((s, k) => {
          f.slotSpecies[c * SLOTS + k] = s;
          f.slotBiomass[c * SLOTS + k] = 0.2 * SPECIES.maxBiomass[s]!;
        });
      }
      // Вместимость меняется с погодой: если день стал холоднее, лишняя биомасса не исчезает мгновенно,
      // а отмирает. Поэтому проверяется главное: в сутки, когда суммарная биомасса выросла, она не вышла за вместимость.
      let worst = 0;
      let grewDays = 0;
      const before = new Float64Array(cells);
      const dayTicks = 7200;
      for (let d = 0; d < 6 * days; d++) {
        for (let c = 0; c < cells; c++) {
          let b = 0;
          for (let k = 0; k < SLOTS; k++) b += f.slotBiomass[c * SLOTS + k]!;
          before[c] = b;
        }
        for (let t = 0; t < dayTicks; t++) sim.step();
        for (let c = 0; c < cells; c++) {
          let total = 0;
          let capacity = 0;
          for (let k = 0; k < SLOTS; k++) {
            const s = f.slotSpecies[c * SLOTS + k]!;
            if (s === 255) continue;
            total += f.slotBiomass[c * SLOTS + k]!;
            const fit = tempResponse(SPECIES, s, f.dayT[c]!) * moistureResponse(SPECIES, s, f.dayW[c]!) * lightResponse(SPECIES, s, 1) * soilResponse(SPECIES, s, sim.world.geo.soil[c]!);
            capacity = Math.max(capacity, SPECIES.maxBiomass[s]! * Math.sqrt(fit));
          }
          if (capacity > 0 && total > before[c]! + 1e-3) {
            grewDays++;
            worst = Math.max(worst, total / capacity);
          }
        }
      }
      console.log(`сезон ${days}: худшее отношение к вместимости в дни роста ${worst.toFixed(4)} (${grewDays} ячейко-суток роста)`);
      expect(grewDays).toBeGreaterThan(0);
      expect(worst).toBeLessThanOrEqual(1 + 1e-4);
    });
  }
});

describe('Худший случай дискретного шага', () => {
  it('один вид у 75 % вместимости при оптимуме и сезоне 3 суток не перескакивает вместимость', () => {
    const sim = plotSimulation({ precip: 750, soil: 'loam', fertility: 1 }, { scenario: 'genesis', isolated: true, daysPerSeason: 3 });
    const f = sim.world.flora;
    const cells = sim.world.geo.n * sim.world.geo.n;
    const meadow = speciesIndex('meadow-grass');
    // Дойти до середины лета, затем поставить вид у 75 % предельной биомассы.
    while (sim.world.tick < 4.5 * 7200) sim.step();
    for (let c = 0; c < cells; c++) {
      f.nutrient[c] = 50;
      f.slotSpecies[c * SLOTS] = meadow;
      f.slotBiomass[c * SLOTS] = 0.75 * SPECIES.maxBiomass[meadow]!;
    }
    for (let t = 0; t < 7200; t++) sim.step();
    let worst = 0;
    for (let c = 0; c < cells; c++) {
      const fit = tempResponse(SPECIES, meadow, f.dayT[c]!) * moistureResponse(SPECIES, meadow, f.dayW[c]!) * soilResponse(SPECIES, meadow, sim.world.geo.soil[c]!);
      const capacity = SPECIES.maxBiomass[meadow]! * Math.sqrt(fit);
      worst = Math.max(worst, f.slotBiomass[c * SLOTS]! / capacity);
    }
    expect(worst).toBeLessThanOrEqual(1 + 1e-4);
  });
});

describe('Предел численности древесных (замечание заказчика к этапу 3)', () => {
  it('предел мира не выше адресуемого идентификатором; на ячейку — не больше MAX_WOODY_PER_CELL', () => {
    expect(woodyCapacity(plotGeo({ n: 512 }))).toBe(MAX_INDEX + 1);
    expect(woodyCapacity(plotGeo({ n: 256 }))).toBe(256 * 256 * WOODY_PER_CELL_MEAN);
    expect(WOODY_PER_CELL_MEAN).toBeLessThan(MAX_WOODY_PER_CELL);
  });

  it('при заполненном хранилище семена уходят в опад, вещество не теряется', () => {
    const sim = plotSimulation({ precip: 750, soil: 'loam', fertility: 0.9, n: 32 }, { scenario: 'genesis', isolated: true, seed: 3 });
    const w = sim.world;
    const f = w.flora;
    const store = f.woody;
    const birch = speciesIndex('birch');
    // Взрослые плодоносящие берёзы, затем хранилище добивается мелкими всходами до отказа.
    for (let k = 0; k < 64; k++) {
      const c = (4 + (k >> 3) * 3) * 32 + 4 + (k & 7) * 3;
      store.spawn(birch, ((c % 32) + 0.5) * 8, (Math.floor(c / 32) + 0.5) * 8, c, 300, 30);
    }
    let c = 0;
    while (store.spawn(birch, ((c % 32) + 0.5) * 8, (Math.floor(c / 32) + 0.5) * 8, c, 0.002, 0) >= 0) c = (c + 1) % (32 * 32);
    expect(store.count).toBe(store.capacity);
    refreshCover(w, false);
    f.ledger[Ledger.initialStock] = nutrientStock(f, w.geo);
    const litterBefore = f.litterFast.reduce((s, v) => s + v, 0);
    // Год с днём рассева: семена есть, места в хранилище нет.
    runDays(sim, 20);
    expect(store.count).toBeLessThanOrEqual(store.capacity);
    expect(f.litterFast.reduce((s, v) => s + v, 0)).toBeGreaterThan(litterBefore);
    const err = Math.abs(nutrientStock(f, w.geo) - f.ledger[Ledger.initialStock]! - nutrientBudget(f)) / f.ledger[Ledger.initialStock]!;
    expect(err).toBeLessThan(1e-4);
  });
});
