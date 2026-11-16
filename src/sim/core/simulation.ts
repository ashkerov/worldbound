// Фасад ядра симуляции. Не знает о браузере, воркере и рендере:
// одинаково работает в Web Worker и в Node (тесты, headless-стенд).

import type { Command, WorldInit } from '../../shared/protocol';
import { SNAPSHOT_STRIDE } from '../../shared/protocol';
import { EntityKind } from '../../shared/ids';
import { AgentStore } from './agentStore';
import { StateHasher } from './hash';
import { Scheduler, type Clock, type SystemTiming } from './scheduler';
import { heightAt, type World } from './world';
import { generateTestTerrain } from '../worldgen/testTerrain';
import { spawnTestAgents, testAgentDecisionSystem, testAgentMoveSystem } from '../systems/testAgents';

export const TEST_TERRAIN_SPACING = 4;
export const AGENT_CAPACITY = 16384;

export interface LoggedCommand {
  tick: number;
  command: Command;
}

export class Simulation {
  readonly world: World;
  private readonly scheduler: Scheduler<World>;
  private readonly pending: Command[] = [];
  /** Журнал применённых команд: причина «вмешательство создателя» и воспроизведение в тестах. */
  readonly commandLog: LoggedCommand[] = [];

  constructor(init: WorldInit, clock?: Clock) {
    this.world = {
      seed: init.seed >>> 0,
      worldSize: init.worldSize,
      tick: 0,
      speed: 1,
      terrain: generateTestTerrain(init.seed >>> 0, init.worldSize, TEST_TERRAIN_SPACING),
      agents: new AgentStore(AGENT_CAPACITY),
    };
    this.scheduler = new Scheduler<World>(clock).add(testAgentDecisionSystem).add(testAgentMoveSystem);
    spawnTestAgents(this.world, init.testAgents);
  }

  /** Команда будет применена на границе следующего такта. */
  enqueue(command: Command): void {
    this.pending.push(command);
  }

  /** Применяет накопленные команды. Вызывается в начале такта и на паузе. */
  applyCommands(): void {
    if (this.pending.length === 0) return;
    for (const command of this.pending) {
      this.apply(command);
      this.commandLog.push({ tick: this.world.tick, command });
    }
    this.pending.length = 0;
  }

  private apply(command: Command): void {
    switch (command.type) {
      case 'setSpeed':
        this.world.speed = command.speed;
        break;
      case 'spawnTestAgents':
        spawnTestAgents(this.world, command.count);
        break;
      case 'clearTestAgents':
        this.world.agents.clear();
        break;
    }
  }

  /** Один такт: команды → системы по расписанию → счётчик. */
  step(): void {
    this.applyCommands();
    this.scheduler.step(this.world, this.world.tick);
    this.world.tick++;
  }

  /** Сколько чисел Float32 нужно под снимок текущего состояния. */
  snapshotLength(): number {
    return this.world.agents.count * SNAPSHOT_STRIDE;
  }

  /** Пишет снимок кадра в `out`, возвращает число сущностей. */
  writeSnapshot(out: Float32Array): number {
    const a = this.world.agents;
    const terrain = this.world.terrain;
    let row = 0;
    for (let i = 0; i < a.highWater; i++) {
      if (a.alive[i] !== 1) continue;
      const o = row * SNAPSHOT_STRIDE;
      if (o + SNAPSHOT_STRIDE > out.length) break;
      const x = a.x[i]!;
      const z = a.z[i]!;
      out[o] = i;
      out[o + 1] = x;
      out[o + 2] = heightAt(terrain, x, z);
      out[o + 3] = z;
      out[o + 4] = a.heading[i]!;
      out[o + 5] = EntityKind.TestAgent;
      row++;
    }
    return row;
  }

  stateHash(): string {
    const w = this.world;
    const a = w.agents;
    return new StateHasher()
      .addInt(w.seed)
      .addInt(w.tick)
      .addInt(w.speed)
      .addInt(a.count)
      .addArray(w.terrain.heights)
      .addArray(a.x, a.highWater)
      .addArray(a.z, a.highWater)
      .addArray(a.heading, a.highWater)
      .addArray(a.targetHeading, a.highWater)
      .addArray(a.speed, a.highWater)
      .addArray(a.alive, a.highWater)
      .addArray(a.generation, a.highWater)
      .digest();
  }

  getTimings(): readonly SystemTiming[] {
    return this.scheduler.getTimings();
  }
}
