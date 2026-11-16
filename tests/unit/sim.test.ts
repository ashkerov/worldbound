import { describe, expect, it } from 'vitest';
import { SNAPSHOT_STRIDE, type Command } from '../../src/shared/protocol';
import { idGeneration } from '../../src/shared/ids';
import { TICK_SECONDS } from '../../src/shared/time';
import { AgentStore } from '../../src/sim/core/agentStore';
import { Scheduler } from '../../src/sim/core/scheduler';
import { Simulation } from '../../src/sim/core/simulation';
import { heightAt } from '../../src/sim/core/world';
import { generateTestTerrain } from '../../src/sim/worldgen/testTerrain';

const INIT = { seed: 42, worldSize: 512, testAgents: 500 };

function run(ticks: number, commands: Record<number, Command[]> = {}, init = INIT): Simulation {
  const sim = new Simulation(init);
  for (let t = 0; t < ticks; t++) {
    for (const command of commands[t] ?? []) sim.enqueue(command);
    sim.step();
  }
  return sim;
}

describe('Детерминизм', () => {
  it('один seed и одни команды дают один и тот же хеш состояния', () => {
    const commands: Record<number, Command[]> = {
      100: [{ type: 'spawnTestAgents', count: 200 }],
      400: [{ type: 'setSpeed', speed: 4 }],
      900: [{ type: 'clearTestAgents' }, { type: 'spawnTestAgents', count: 50 }],
    };
    const a = run(1500, commands);
    const b = run(1500, commands);
    expect(a.world.tick).toBe(1500);
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('другой seed даёт другое состояние', () => {
    expect(run(200).stateHash()).not.toBe(run(200, {}, { ...INIT, seed: 43 }).stateHash());
  });

  it('другая команда даёт другое состояние', () => {
    const a = run(300, { 100: [{ type: 'spawnTestAgents', count: 10 }] });
    const b = run(300, { 100: [{ type: 'spawnTestAgents', count: 11 }] });
    expect(a.stateHash()).not.toBe(b.stateHash());
  });

  it('тестовый рельеф воспроизводим побитно и имеет эталонный хеш', () => {
    const a = generateTestTerrain(42, 512, 4);
    const b = generateTestTerrain(42, 512, 4);
    expect(a.samples).toBe(129);
    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
    // Эталон: генерация использует только целочисленный хеш и + − ×, значит хеш обязан совпасть в любом движке.
    expect(new Simulation({ seed: 42, worldSize: 512, testAgents: 0 }).stateHash()).toMatchInlineSnapshot(`"f6f397b4bb9c3305"`);
  });
});

describe('Команды', () => {
  it('применяются на границе такта и попадают в журнал с номером такта', () => {
    const sim = new Simulation(INIT);
    sim.step();
    sim.step();
    sim.enqueue({ type: 'spawnTestAgents', count: 5 });
    expect(sim.world.agents.count).toBe(500);
    sim.step();
    expect(sim.world.agents.count).toBe(505);
    expect(sim.commandLog).toEqual([{ tick: 2, command: { type: 'spawnTestAgents', count: 5 } }]);
  });

  it('applyCommands работает без такта — нужно для снятия паузы', () => {
    const sim = new Simulation(INIT);
    sim.enqueue({ type: 'setSpeed', speed: 0 });
    sim.applyCommands();
    expect(sim.world.speed).toBe(0);
    expect(sim.world.tick).toBe(0);
  });
});

describe('Планировщик', () => {
  it('соблюдает период и фазу и сохраняет порядок регистрации', () => {
    const log: string[] = [];
    const scheduler = new Scheduler<null>()
      .add({ name: 'a', period: 1, run: (_w, t) => log.push(`a${t}`) })
      .add({ name: 'b', period: 3, run: (_w, t) => log.push(`b${t}`) })
      .add({ name: 'c', period: 3, phase: 1, run: (_w, t) => log.push(`c${t}`) });
    for (let t = 0; t < 6; t++) scheduler.step(null, t);
    expect(log).toEqual(['a0', 'b0', 'a1', 'c1', 'a2', 'a3', 'b3', 'a4', 'c4', 'a5']);
  });

  it('собирает время систем, если передан источник времени', () => {
    let now = 0;
    const scheduler = new Scheduler<null>(() => now).add({ name: 'slow', period: 2, run: () => void (now += 5) });
    for (let t = 0; t < 4; t++) scheduler.step(null, t);
    expect(scheduler.getTimings()[0]).toEqual({ name: 'slow', runs: 2, totalMs: 10, maxMs: 5 });
  });

  it('отклоняет некорректный период', () => {
    expect(() => new Scheduler<null>().add({ name: 'x', period: 0, run: () => {} })).toThrow(RangeError);
  });
});

describe('Хранилище агентов', () => {
  it('переиспользует слоты и увеличивает поколение', () => {
    const store = new AgentStore(4);
    const a = store.spawn(1, 1, 0, 1);
    const b = store.spawn(2, 2, 0, 1);
    const idA = store.idOf(a);
    store.despawn(a);
    expect(store.count).toBe(1);
    expect(store.isCurrent(idA, a)).toBe(false);
    const c = store.spawn(3, 3, 0, 1);
    expect(c).toBe(a);
    expect(idGeneration(store.idOf(c))).toBe(1);
    expect(store.isCurrent(idA, c)).toBe(false);
    expect(store.alive[b]).toBe(1);
  });

  it('возвращает −1 при переполнении и не портит данные', () => {
    const store = new AgentStore(2);
    store.spawn(0, 0, 0, 1);
    store.spawn(0, 0, 0, 1);
    expect(store.spawn(0, 0, 0, 1)).toBe(-1);
    expect(store.count).toBe(2);
  });
});

describe('Тестовые агенты и снимок', () => {
  it('агенты остаются в границах мира и не дают NaN', () => {
    const sim = run(3000);
    const a = sim.world.agents;
    for (let i = 0; i < a.highWater; i++) {
      expect(Number.isFinite(a.x[i]!) && Number.isFinite(a.z[i]!) && Number.isFinite(a.heading[i]!)).toBe(true);
      expect(a.x[i]!).toBeGreaterThanOrEqual(0);
      expect(a.x[i]!).toBeLessThanOrEqual(512);
      expect(a.z[i]!).toBeGreaterThanOrEqual(0);
      expect(a.z[i]!).toBeLessThanOrEqual(512);
    }
  });

  it('за такт агент проходит не больше скорость × длительность такта', () => {
    const sim = new Simulation(INIT);
    const a = sim.world.agents;
    const x0 = Array.from(a.x.subarray(0, a.highWater));
    const z0 = Array.from(a.z.subarray(0, a.highWater));
    sim.step();
    for (let i = 0; i < a.highWater; i++) {
      const moved = Math.hypot(a.x[i]! - x0[i]!, a.z[i]! - z0[i]!);
      expect(moved).toBeLessThanOrEqual(a.speed[i]! * TICK_SECONDS + 1e-4);
      expect(moved).toBeGreaterThan(0);
    }
  });

  it('снимок содержит всех живых агентов, высота взята с рельефа', () => {
    const sim = run(50);
    const out = new Float32Array(sim.snapshotLength());
    const count = sim.writeSnapshot(out);
    expect(count).toBe(500);
    for (let row = 0; row < count; row++) {
      const o = row * SNAPSHOT_STRIDE;
      const index = out[o]!;
      expect(out[o + 1]).toBeCloseTo(sim.world.agents.x[index]!, 4);
      expect(out[o + 3]).toBeCloseTo(sim.world.agents.z[index]!, 4);
      expect(out[o + 2]).toBeCloseTo(heightAt(sim.world.terrain, out[o + 1]!, out[o + 3]!), 3);
    }
  });

  it('снимок не выходит за границы слишком маленького буфера', () => {
    const sim = run(1);
    const out = new Float32Array(10 * SNAPSHOT_STRIDE);
    expect(sim.writeSnapshot(out)).toBe(10);
  });
});

describe('Выборка высоты', () => {
  it('в узлах сетки совпадает с отсчётом, между узлами — линейна, за краем — зажата', () => {
    const terrain = { samples: 3, spacing: 10, heights: new Float32Array([0, 10, 20, 0, 10, 20, 0, 10, 20]) };
    expect(heightAt(terrain, 0, 0)).toBe(0);
    expect(heightAt(terrain, 10, 10)).toBe(10);
    expect(heightAt(terrain, 20, 20)).toBe(20);
    expect(heightAt(terrain, 5, 3)).toBeCloseTo(5);
    expect(heightAt(terrain, 15, 17)).toBeCloseTo(15);
    expect(heightAt(terrain, -50, 5)).toBe(0);
    expect(heightAt(terrain, 500, 5)).toBe(20);
  });
});
