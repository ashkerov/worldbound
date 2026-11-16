// Многочастотный планировщик (ARCHITECTURE.md, раздел 7).
// Каждая система объявляет период в тактах и фазу; порядок выполнения внутри
// такта фиксирован порядком регистрации — это часть детерминизма.

export interface System<W> {
  readonly name: string;
  /** Период в тактах: 1 — каждый такт. */
  readonly period: number;
  /** Сдвиг внутри периода, чтобы разнести тяжёлые системы по тактам. */
  readonly phase?: number;
  run(world: W, tick: number): void;
}

export interface SystemTiming {
  name: string;
  runs: number;
  totalMs: number;
  maxMs: number;
}

/** Источник времени для профилирования. Ядро само часы не читает. */
export type Clock = () => number;

export class Scheduler<W> {
  private readonly systems: System<W>[] = [];
  private readonly timings: SystemTiming[] = [];

  constructor(private readonly clock?: Clock) {}

  add(system: System<W>): this {
    if (!Number.isInteger(system.period) || system.period < 1) {
      throw new RangeError(`Система ${system.name}: период должен быть целым ≥ 1`);
    }
    this.systems.push(system);
    this.timings.push({ name: system.name, runs: 0, totalMs: 0, maxMs: 0 });
    return this;
  }

  step(world: W, tick: number): void {
    const clock = this.clock;
    for (let i = 0; i < this.systems.length; i++) {
      const system = this.systems[i]!;
      if ((tick - (system.phase ?? 0)) % system.period !== 0) continue;
      if (clock) {
        const start = clock();
        system.run(world, tick);
        const elapsed = clock() - start;
        const timing = this.timings[i]!;
        timing.runs++;
        timing.totalMs += elapsed;
        if (elapsed > timing.maxMs) timing.maxMs = elapsed;
      } else {
        system.run(world, tick);
      }
    }
  }

  getTimings(): readonly SystemTiming[] {
    return this.timings;
  }
}
