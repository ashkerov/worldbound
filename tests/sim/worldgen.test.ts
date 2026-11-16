// Генерация мира: воспроизводимость, естественные границы, реки → озёра → море, климат, почвы, провинции.

import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { generateWorld } from '../../src/sim/worldgen/generate';
import { EdgeKind, WaterKind, type Geo } from '../../src/sim/worldgen/geo';
import { SOILS } from '../../src/sim/env/soils';
import { config, generated } from '../support/worlds';

const SEEDS = [42, 7, 1234];

function boundaryCells(geo: Geo, edge: number): number[] {
  const n = geo.n;
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(edge === 0 ? k : edge === 1 ? k * n + n - 1 : edge === 2 ? (n - 1) * n + k : k * n);
  return out;
}

/** Ячейка моря, в которую в итоге стекает вода из ячейки c (−1 — цикл или тупик). */
function mouth(geo: Geo, c: number): number {
  let i = c;
  for (let steps = 0; steps < geo.n * geo.n; steps++) {
    if (geo.waterKind[i] === WaterKind.Sea) return i;
    const r = geo.receiver[i]!;
    if (r < 0) return -1;
    i = r;
  }
  return -1;
}

describe('Генерация мира: воспроизводимость', () => {
  it('один seed и параметры дают побитно одинаковый мир', () => {
    const cfg = config({ seed: 99 });
    const a = generateWorld(cfg);
    const b = generateWorld(cfg);
    expect(a.hash).toBe(b.hash);
    expect(Buffer.from(a.geo.terrain.heights.buffer).equals(Buffer.from(b.geo.terrain.heights.buffer))).toBe(true);
    expect(a.geo.provinces.map((p) => p.name)).toEqual(b.geo.provinces.map((p) => p.name));
  });

  it('другой seed и другой климат дают другой мир; имя мира на генерацию не влияет', () => {
    const base = generated(config({ seed: 42 }));
    expect(generated(config({ seed: 43 })).hash).not.toBe(base.hash);
    expect(generated(config({ seed: 42, climate: 'cold' })).hash).not.toBe(base.hash);
    expect(generateWorld(config({ seed: 42, name: 'Другое имя' })).hash).toBe(base.hash);
  });

  it('эталонный хеш малого мира seed 42 не меняется (то же значение проверяется в браузерах)', () => {
    expect(generated(config({ seed: 42 })).hash).toMatchInlineSnapshot(`"267530a6fcb45b57"`);
  });
});

describe.each(SEEDS)('Мир M, seed %i', (seed) => {
  const t0 = performance.now();
  const { geo } = generated(config({ seed, size: 'M' }));
  const ms = performance.now() - t0;
  const n = geo.n;

  it('генерируется за разумное время', () => {
    // Первый вызов включает генерацию; эталон — Node на эталонной машине A.
    expect(ms).toBeLessThan(20000);
  });

  it('границы естественные: каждый край — море или горы, и они продолжаются за краем', () => {
    expect(geo.edges.filter((e) => e === EdgeKind.Sea).length).toBeGreaterThanOrEqual(1);
    expect(geo.edges.filter((e) => e === EdgeKind.Mountains).length).toBeGreaterThanOrEqual(1);
    for (let e = 0; e < 4; e++) {
      const cells = boundaryCells(geo, e);
      if (geo.edges[e] === EdgeKind.Sea) {
        const sea = cells.filter((c) => geo.waterKind[c] === WaterKind.Sea).length / cells.length;
        // Мысы могут доходить до края — за ним они уходят под воду в полосе горизонта.
        expect(sea, `край ${e}: доля моря`).toBeGreaterThan(0.6);
      } else {
        const high = cells.filter((c) => geo.height[c]! > 120).length / cells.length;
        expect(high, `край ${e}: доля гор`).toBeGreaterThan(0.85);
      }
    }
    // За краем: над горами рельеф выше, чем на краю, у моря — дно ниже уровня моря.
    const h = geo.horizon;
    const sample = (x: number, z: number) => h.heights[Math.round((z - h.originZ) / h.spacing) * h.samples + Math.round((x - h.originX) / h.spacing)]!;
    const size = n * geo.cellSize;
    const outside = [
      [size / 2, -1500],
      [size + 1500, size / 2],
      [size / 2, size + 1500],
      [-1500, size / 2],
    ];
    for (let e = 0; e < 4; e++) {
      const v = sample(outside[e]![0]!, outside[e]![1]!);
      if (geo.edges[e] === EdgeKind.Sea) expect(v, `горизонт за краем ${e}`).toBeLessThan(0);
      else expect(v, `горизонт за краем ${e}`).toBeGreaterThan(150);
    }
  });

  it('реки впадают в озёра и в море; вся суша стекает в море без циклов', () => {
    let riverCells = 0;
    let intoSea = 0;
    let intoLake = 0;
    let stuck = 0;
    for (let c = 0; c < n * n; c++) {
      if (geo.waterKind[c] === WaterKind.Sea) continue;
      // Проверка устья для каждой ячейки дорога; проверяются все ячейки рек и озёр и каждая 7-я ячейка суши.
      if ((geo.waterKind[c] !== WaterKind.None || c % 7 === 0) && mouth(geo, c) < 0) stuck++;
      if (geo.waterKind[c] !== WaterKind.River) continue;
      riverCells++;
      const r = geo.receiver[c]!;
      if (geo.waterKind[r] === WaterKind.Sea) intoSea++;
      if (geo.waterKind[r] === WaterKind.Lake) intoLake++;
    }
    expect(stuck, 'ячейки, не стекающие в море').toBe(0);
    expect(riverCells).toBeGreaterThan(200);
    expect(intoSea).toBeGreaterThanOrEqual(1);
    expect(intoLake).toBeGreaterThanOrEqual(1);
    expect(geo.lakes.length).toBeGreaterThanOrEqual(1);
    // Из каждого озера вода уходит дальше (сток озера тоже в итоге в море).
    for (const lake of geo.lakes) expect(lake.outlet).toBeGreaterThanOrEqual(-1);
  });

  it('уровень воды в реке не растёт вниз по течению, вода лежит выше дна', () => {
    let dry = 0;
    let uphill = 0;
    for (let c = 0; c < n * n; c++) {
      if (geo.waterKind[c] !== WaterKind.River) continue;
      if (!(geo.waterLevel[c]! > geo.height[c]!)) dry++;
      const r = geo.receiver[c]!;
      if (geo.waterKind[r] === WaterKind.River && geo.waterLevel[r]! > geo.waterLevel[c]! + 1e-3) uphill++;
    }
    expect(dry).toBe(0);
    expect(uphill).toBe(0);
    for (const lake of geo.lakes) expect(Number.isFinite(lake.level)).toBe(true);
  });

  it('условия различаются между провинциями: температура, осадки, высота', () => {
    expect(geo.provinces.length).toBeGreaterThanOrEqual(12);
    expect(geo.provinces.length).toBeLessThanOrEqual(48);
    const t = geo.provinces.map((p) => p.meanTemp);
    const p = geo.provinces.map((x) => x.meanPrecip);
    const h = geo.provinces.map((x) => x.meanHeight);
    expect(Math.max(...t) - Math.min(...t)).toBeGreaterThan(2);
    expect(Math.max(...p) - Math.min(...p)).toBeGreaterThan(150);
    expect(Math.max(...h) - Math.min(...h)).toBeGreaterThan(100);
    expect(new Set(geo.provinces.map((x) => x.kind)).size).toBeGreaterThanOrEqual(3);
  });

  it('у каждой ячейки суши есть провинция; названия уникальны', () => {
    let orphan = 0;
    for (let c = 0; c < n * n; c++) if (geo.waterKind[c] !== WaterKind.Sea && geo.province[c] === 0) orphan++;
    expect(orphan).toBe(0);
    const names = geo.provinces.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[А-ЯЁ][а-яё]+(ая|ий|ое|ие) [а-яё]+$/);
  });

  it('почвы и залежи: несколько типов, значения в допустимых границах', () => {
    const types = new Set<number>();
    let bad = 0;
    for (let c = 0; c < n * n; c++) {
      if (geo.soil[c]! >= SOILS.length || !(geo.fertility[c]! >= 0 && geo.fertility[c]! <= 1)) bad++;
      if (geo.waterKind[c] === WaterKind.None) types.add(geo.soil[c]!);
    }
    expect(bad).toBe(0);
    expect(types.size).toBeGreaterThanOrEqual(4);
    expect(new Set(geo.deposit).size).toBeGreaterThanOrEqual(3);
  });

  it('климатические поля конечны и правдоподобны', () => {
    let bad = 0;
    for (let c = 0; c < n * n; c++) {
      if (!(geo.tMean[c]! > -15 && geo.tMean[c]! < 25 && geo.precip[c]! > 150 && geo.precip[c]! < 2500)) bad++;
    }
    expect(bad).toBe(0);
  });
});
