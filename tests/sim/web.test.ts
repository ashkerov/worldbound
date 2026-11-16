// Тесты расширенной пищевой сети (прототип фазы 1): книга учёта, детерминизм,
// правила размножения и смертности, сезонная миграция, трофические каскады.

import { describe, expect, it } from 'vitest';
import { CAUSES, DEER, FOX, RABBIT, SPECS, WOLF, WebWorld, type WebOptions } from '../../prototypes/web/model';

const NX = 6;
const NY = 16;
const LENGTH = NY * 128;

function run(seed: number, days: number, options: WebOptions = {}, each?: (world: WebWorld, day: number) => void): WebWorld {
  const world = new WebWorld(seed, NX, NY, options);
  for (let day = 0; day < days; day++) {
    world.stepDay();
    each?.(world, day);
  }
  return world;
}

describe('Расширенная пищевая сеть', () => {
  it('книга учёта: численность каждого вида = начальная + рождения − смерти, каждые сутки', () => {
    const world = new WebWorld(3, NX, NY);
    const start = [0, 1, 2, 3].map((s) => world.count(s));
    for (let day = 0; day < 160; day++) {
      world.stepDay();
      for (let s = 0; s < 4; s++) expect(world.count(s), `сутки ${day}, вид ${s}`).toBe(start[s]! + world.totalBirths(s) - world.totalDeaths(s));
    }
    expect(world.totalBirths(RABBIT)).toBeGreaterThan(200);
    expect(world.totalDeaths(DEER)).toBeGreaterThan(20);
  }, 120_000);

  it('детерминизм: один seed — одно состояние, другой seed — другое', () => {
    expect(run(7, 60).stateHash()).toBe(run(7, 60).stateHash());
    expect(run(7, 60).stateHash()).not.toBe(run(8, 60).stateHash());
  }, 120_000);

  it('все шесть звеньев сети живы через 15 игровых лет', () => {
    // Мир 8×24 чанка (1 × 3 км), как в экспериментах. В мире вдвое меньше (6×16) лисы
    // вымерли на одном seed из трёх: малые популяции хищников неустойчивы — см. PHASE1_REPORT.md.
    for (const seed of [11, 12]) {
      const world = new WebWorld(seed, 8, 24);
      for (let day = 0; day < 300; day++) world.stepDay();
      for (let s = 0; s < 4; s++) expect(world.count(s), `seed ${seed}, вид ${s}`).toBeGreaterThan(0);
      // Замер приходится на конец зимы; проверяется лишь, что трава не выбита до несъедаемого остатка (0.1).
      expect(world.fieldMean(world.grass)).toBeGreaterThan(0.1);
      expect(world.fieldMean(world.shrub)).toBeGreaterThan(0.06);
    }
  }, 240_000);

  it('размножение: только в свой сезон, только взрослые, только при достаточной энергии', () => {
    const world = run(21, 300);
    for (let s = 0; s < 4; s++) {
      const spec = SPECS[s]!;
      expect(world.totalBirths(s), `вид ${s} размножался`).toBeGreaterThan(0);
      spec.breeds.forEach((allowed, season) => {
        if (!allowed) expect(world.births[s]![season], `вид ${s}, сезон ${season}`).toBe(0);
      });
      expect(world.minParentAge[s]).toBeGreaterThanOrEqual(spec.matureDays);
      expect(world.minParentEnergy[s]).toBeGreaterThanOrEqual(spec.reproThreshold);
    }
    // Зимой не размножается никто.
    for (let s = 0; s < 4; s++) expect(world.births[s]![3]).toBe(0);
  }, 120_000);

  it('смертность: причины записываются, старость наступает в конце срока, хищники не гибнут от хищников', () => {
    const world = run(22, 400);
    const byCause = (s: number, cause: number) => world.deaths[s]![cause]!.reduce((a, b) => a + b, 0);
    for (let s = 0; s < 4; s++) {
      expect(CAUSES.reduce((a, _c, cause) => a + byCause(s, cause), 0)).toBe(world.totalDeaths(s));
      if (byCause(s, 2) > 0) expect(world.minOldAgeFraction[s]).toBeGreaterThanOrEqual(0.8);
    }
    expect(byCause(RABBIT, 1)).toBeGreaterThan(0);
    expect(byCause(DEER, 1)).toBeGreaterThan(0);
    expect(byCause(FOX, 1)).toBe(0);
    expect(byCause(WOLF, 1)).toBe(0);
    // Останки возвращают вещества: плодородие нигде не ниже базового и в среднем выше.
    expect(Math.min(...world.nutrient)).toBeGreaterThanOrEqual(1);
    expect(world.fieldMean(world.nutrient)).toBeGreaterThan(1.001);
  }, 180_000);

  it('миграция: олени зимой держатся южнее, чем летом; оседлые кролики не смещаются', () => {
    const summer = [0, 0];
    const winter = [0, 0];
    let summers = 0;
    let winters = 0;
    run(31, 400, {}, (world, day) => {
      if (day < 100) return;
      const dayOfYear = day % 20;
      if (dayOfYear === 9) {
        summer[0]! += world.meanZ(DEER);
        summer[1]! += world.meanZ(RABBIT);
        summers++;
      } else if (dayOfYear === 19) {
        winter[0]! += world.meanZ(DEER);
        winter[1]! += world.meanZ(RABBIT);
        winters++;
      }
    });
    const deerShift = winter[0]! / winters - summer[0]! / summers;
    const rabbitShift = winter[1]! / winters - summer[1]! / summers;
    expect(deerShift).toBeGreaterThan(LENGTH * 0.06);
    expect(Math.abs(rabbitShift)).toBeLessThan(LENGTH * 0.03);
  }, 180_000);

  it('без сезонов миграции нет — сдвиг вызван именно сменой сезонов', () => {
    const positions: number[] = [];
    run(31, 300, { noSeasons: true }, (world, day) => {
      if (day >= 100 && day % 10 === 9) positions.push(world.meanZ(DEER));
    });
    const mean = positions.reduce((a, b) => a + b, 0) / positions.length;
    const spread = Math.max(...positions.map((p) => Math.abs(p - mean)));
    expect(spread).toBeLessThan(LENGTH * 0.06);
  }, 180_000);

  it('каскад: без волков оленей больше, кустарника меньше', () => {
    const mean = (options: WebOptions, seed: number) => {
      let deer = 0;
      let shrub = 0;
      let n = 0;
      run(seed, 360, options, (world, day) => {
        if (day < 160) return;
        deer += world.count(DEER);
        shrub += world.fieldMean(world.shrub);
        n++;
      });
      return { deer: deer / n, shrub: shrub / n };
    };
    let deerUp = 0;
    let shrubDown = 0;
    for (const seed of [41, 42, 43]) {
      const control = mean({}, seed);
      const noWolves = mean({ absent: [WOLF] }, seed);
      if (noWolves.deer > control.deer * 1.1) deerUp++;
      if (noWolves.shrub < control.shrub) shrubDown++;
    }
    expect(deerUp).toBeGreaterThanOrEqual(2);
    expect(shrubDown).toBeGreaterThanOrEqual(2);
  }, 400_000);
});
