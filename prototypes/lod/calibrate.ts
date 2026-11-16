// Калибровка дальнего уровня по пространственной модели S0.
// Мир целиком считается на S0; по суточным выборкам чанков строятся таблицы,
// которыми затем пользуются meanfield и когорты. Это и есть «способ калибровки» из плана фазы 1.

import { FOX, GRASS, LodWorld, RABBIT, SPECIES, Table, Table2, type ChunkSample, type FarParams } from './model';

class Bins {
  readonly num: number[];
  readonly den: number[];
  constructor(
    readonly lo: number,
    readonly hi: number,
    readonly count: number,
  ) {
    this.num = new Array<number>(count).fill(0);
    this.den = new Array<number>(count).fill(0);
  }

  add(x: number, num: number, den: number): void {
    if (den <= 0) return;
    let i = Math.floor(((x - this.lo) / (this.hi - this.lo)) * this.count);
    if (i < 0) i = 0;
    else if (i >= this.count) i = this.count - 1;
    this.num[i]! += num;
    this.den[i]! += den;
  }

  /** Отношение сумм по интервалам; пустые интервалы заполняются ближайшим непустым. */
  table(): Table {
    const values = this.num.map((n, i) => (this.den[i]! > 0 ? n / this.den[i]! : NaN));
    for (let i = 0; i < values.length; i++) {
      if (!Number.isNaN(values[i]!)) continue;
      for (let d = 1; d < values.length; d++) {
        const a = values[i - d];
        const b = values[i + d];
        if (a !== undefined && !Number.isNaN(a)) {
          values[i] = a;
          break;
        }
        if (b !== undefined && !Number.isNaN(b)) {
          values[i] = b;
          break;
        }
      }
      if (Number.isNaN(values[i]!)) values[i] = 0;
    }
    return new Table(this.lo, this.hi, values);
  }
}

class Bins2 {
  readonly num: number[];
  readonly den: number[];
  constructor(
    readonly xLo: number,
    readonly xHi: number,
    readonly nx: number,
    readonly yLo: number,
    readonly yHi: number,
    readonly ny: number,
  ) {
    this.num = new Array<number>(nx * ny).fill(0);
    this.den = new Array<number>(nx * ny).fill(0);
  }

  add(x: number, y: number, num: number, den: number): void {
    if (den <= 0) return;
    let i = Math.floor(((x - this.xLo) / (this.xHi - this.xLo)) * this.nx);
    let j = Math.floor(((y - this.yLo) / (this.yHi - this.yLo)) * this.ny);
    if (i < 0) i = 0;
    else if (i >= this.nx) i = this.nx - 1;
    if (j < 0) j = 0;
    else if (j >= this.ny) j = this.ny - 1;
    this.num[j * this.nx + i]! += num;
    this.den[j * this.nx + i]! += den;
  }

  /** Пустые клетки заполняются ближайшей непустой (по сетке, манхэттенское расстояние). */
  table(): Table2 {
    const values = this.num.map((n, k) => (this.den[k]! > 0 ? n / this.den[k]! : NaN));
    const filled = values.slice();
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        if (!Number.isNaN(values[j * this.nx + i]!)) continue;
        let best = Infinity;
        let value = 0;
        for (let jj = 0; jj < this.ny; jj++) {
          for (let ii = 0; ii < this.nx; ii++) {
            const v = values[jj * this.nx + ii]!;
            // Расстояние по оси травы весит больше: укрытие влияет сильнее числа кроликов.
            const d = Math.abs(ii - i) + Math.abs(jj - j) * 3;
            if (!Number.isNaN(v) && d < best) {
              best = d;
              value = v;
            }
          }
        }
        filled[j * this.nx + i] = value;
      }
    }
    return new Table2(this.xLo, this.xHi, this.nx, this.yLo, this.yHi, this.ny, filled);
  }
}

export interface CalibrationOptions {
  seeds: number[];
  nx: number;
  ny: number;
  days: number;
  /** Сколько первых суток отбросить (переходный процесс от начальных условий). */
  warmup: number;
}

export function calibrate(options: CalibrationOptions): FarParams {
  const rabbit = SPECIES[RABBIT]!;
  const fox = SPECIES[FOX]!;
  const intake = new Bins(0, GRASS.K, 10);
  const kill = new Bins2(0, 60, 12, 0, GRASS.K, 5);
  const killExposed = new Bins(0, 40, 10);
  const desire = new Bins(0, rabbit.eMax, 10);
  const hungry = new Bins(0, fox.eMax, 7);
  const starve = [new Bins(0, rabbit.eMax, 10), new Bins(0, fox.eMax, 7)];
  const repro = [new Bins(0, rabbit.eMax, 10), new Bins(0, fox.eMax, 7)];
  const crossed = [0, 0];
  const oldAge = [0, 0];
  const adultDays = [0, 0];
  const present = [0, 0];

  for (const seed of options.seeds) {
    const world = new LodWorld(seed, options.nx, options.ny, 'meanfield', null);
    world.sampler = (_chunk: number, s: ChunkSample) => {
      if (world.day < options.warmup) return;
      intake.add(s.grass, s.got, s.desired);
      kill.add(s.n[RABBIT], s.grass, s.kills, s.hungryFoxDays);
      killExposed.add(s.exposed, s.kills, s.hungryFoxDays);
      if (s.n[RABBIT] > 0) desire.add(s.energy[RABBIT] / s.n[RABBIT], s.desired, s.n[RABBIT] * rabbit.intakeMax);
      if (s.n[FOX] > 0) hungry.add(s.energy[FOX] / s.n[FOX], s.hungryFoxDays, s.n[FOX]);
      for (const species of [RABBIT, FOX]) {
        const n = s.n[species]!;
        if (n > 0) starve[species]!.add(s.energy[species]! / n, s.starved[species]!, n);
        const adults = s.adults[species]!;
        if (adults > 0) repro[species]!.add(s.adultEnergy[species]! / adults, s.litters[species]!, adults);
        crossed[species]! += s.crossed[species]!;
        oldAge[species]! += s.oldAge[species]!;
        adultDays[species]! += adults;
        present[species]! += n;
      }
    };
    for (let day = 0; day < options.days; day++) world.stepDay();
  }

  return {
    intake: intake.table(),
    kill: kill.table(),
    disperse: [present[0]! > 0 ? crossed[0]! / present[0]! : 0, present[1]! > 0 ? crossed[1]! / present[1]! : 0],
    desire: desire.table(),
    hungry: hungry.table(),
    starve: [starve[0]!.table(), starve[1]!.table()],
    repro: [repro[0]!.table(), repro[1]!.table()],
    killExposed: killExposed.table(),
    oldAge: [adultDays[0]! > 0 ? oldAge[0]! / adultDays[0]! : 0, adultDays[1]! > 0 ? oldAge[1]! / adultDays[1]! : 0],
  };
}

export function describeParams(fp: FarParams): Record<string, unknown> {
  const round = (t: Table) => ({ lo: t.lo, hi: t.hi, values: t.values.map((v) => +v.toFixed(4)) });
  return {
    intake: round(fp.intake),
    kill: { rabbitsPerColumn: 5, grassPerRow: 0.2, values: fp.kill.values.map((v) => +v.toFixed(3)) },
    disperse: fp.disperse.map((v) => +v.toFixed(4)),
    desire: round(fp.desire),
    hungry: round(fp.hungry),
    starveRabbit: round(fp.starve[0]),
    starveFox: round(fp.starve[1]),
    reproRabbit: round(fp.repro[0]),
    reproFox: round(fp.repro[1]),
    oldAge: fp.oldAge.map((v) => +v.toFixed(5)),
    killExposed: round(fp.killExposed),
  };
}
