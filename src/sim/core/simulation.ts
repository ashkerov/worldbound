// Фасад ядра симуляции. Не знает о браузере, воркере и рендере:
// одинаково работает в Web Worker и в Node (тесты, headless-стенд).

import type { Command, WorldInit } from '../../shared/protocol';
import { SNAPSHOT_STRIDE } from '../../shared/protocol';
import { EntityKind } from '../../shared/ids';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../shared/time';
import { WORLD_SIZES, normalizeConfig, type WorldConfig } from '../../shared/worldConfig';
import { AgentStore } from './agentStore';
import { StateHasher } from './hash';
import { Scheduler, type Clock, type SystemTiming } from './scheduler';
import { heightAt, type World, type WorldDerived } from './world';
import { generateWorld, type GeneratedWorld, type ProgressFn } from '../worldgen/generate';
import type { Geo } from '../worldgen/geo';
import { createEnv, precipFactor } from '../env/envState';
import { SOILS } from '../env/soils';
import { weatherSystem } from '../env/weather';
import { greennessTarget, waterSystem } from '../env/water';
import { cellTemperature, timeContext } from '../env/climate';
import { WaterKind } from '../worldgen/geo';
import { createFlora } from '../flora/state';
import { populateGenesis, populateWild } from '../flora/populate';
import { spawnTestAgents, testAgentDecisionSystem, testAgentMoveSystem } from '../systems/testAgents';

export const AGENT_CAPACITY = 16384;
/** Мир начинается в середине весны, в 7:00. */
export function startTick(daysPerSeason: number): number {
  return Math.floor(daysPerSeason / 2) * TICKS_PER_DAY + 7 * TICKS_PER_HOUR;
}

export interface LoggedCommand {
  tick: number;
  command: Command;
}

function derive(geo: Geo): WorldDerived {
  const { factor, landMean, landCells } = precipFactor(geo);
  const count = geo.n * geo.n;
  const capacity = new Float32Array(count);
  const drainHour = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const soil = SOILS[geo.soil[i]!]!;
    capacity[i] = soil.fieldCapacityMm;
    drainHour[i] = soil.drainagePerDay / 24;
  }
  return { pFactor: factor, landMeanPrecip: landMean, landCells, capacity, drainHour };
}

/** Начальный покров — в равновесии с условиями момента старта (а не «голая земля»). */
function initGreenness(world: World): void {
  const geo = world.geo;
  const ctx = timeContext(world.seed, world.tick, world.config.daysPerSeason);
  for (let i = 0; i < geo.n * geo.n; i++) {
    if (geo.waterKind[i] !== WaterKind.None) continue;
    const t = cellTemperature(geo, i, ctx, 0.2);
    world.env.greenness[i] = greennessTarget(geo, i, ctx, t, world.env.moisture[i]! / world.derived.capacity[i]!, 0);
  }
}

export class Simulation {
  readonly world: World;
  private readonly scheduler: Scheduler<World>;
  private readonly pending: Command[] = [];
  /** Журнал применённых команд: причина «вмешательство создателя» и воспроизведение в тестах. */
  readonly commandLog: LoggedCommand[] = [];

  /**
   * @param generated готовый результат генератора для этого же config (повторное использование в тестах);
   *                  если не передан — мир генерируется здесь.
   */
  constructor(init: WorldInit, clock?: Clock, generated?: GeneratedWorld, progress?: ProgressFn) {
    const config: WorldConfig = normalizeConfig(init.config);
    const gen = generated ?? generateWorld(config, progress);
    const worldSize = WORLD_SIZES[config.size];
    this.world = {
      seed: config.seed,
      config,
      worldSize,
      tick: startTick(config.daysPerSeason),
      speed: 1,
      terrain: gen.geo.terrain,
      geo: gen.geo,
      geoHash: gen.hash,
      env: createEnv(gen.geo, worldSize),
      derived: derive(gen.geo),
      agents: new AgentStore(AGENT_CAPACITY),
      flora: createFlora(gen.geo),
    };
    initGreenness(this.world);
    // При загрузке сохранения растения приходят из секций, а не из начального заселения.
    if (init.populate !== false) {
      if (config.scenario === 'genesis') populateGenesis(this.world);
      else populateWild(this.world);
    }
    this.scheduler = new Scheduler<World>(clock).add(weatherSystem).add(waterSystem).add(testAgentDecisionSystem).add(testAgentMoveSystem);
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

  /** Хеш всего авторитетного состояния: статика (через хеш генерации), среда, агенты, время. */
  stateHash(): string {
    const w = this.world;
    const a = w.agents;
    const e = w.env;
    const f = w.flora;
    const wd = f.woody;
    const hasher = new StateHasher().addInt(w.seed).addInt(w.config.daysPerSeason).addInt(w.config.size === 'M' ? 2 : 1).addInt(w.config.scenario === 'genesis' ? 1 : 0).addInt(w.config.isolated ? 1 : 0);
    for (let i = 0; i < w.config.climate.length; i++) hasher.addInt(w.config.climate.charCodeAt(i));
    for (let i = 0; i < w.geoHash.length; i++) hasher.addInt(w.geoHash.charCodeAt(i));
    hasher
      .addInt(w.tick % 0x40000000)
      .addInt(Math.floor(w.tick / 0x40000000))
      .addInt(w.speed)
      .addArray(e.moisture)
      .addArray(e.snow)
      .addArray(e.greenness)
      .addArray(e.discharge)
      .addArray(e.runoff)
      .addArray(e.waterTotals)
      .addArray(e.weather.cells)
      .addArray(e.weather.chunkRate)
      .addArray(e.weather.chunkCloud)
      .addArray(e.weather.chunkAccum)
      .addArray(e.weather.balance)
      .addInt(e.lastHourStep)
      .addInt(a.count)
      .addArray(a.x, a.highWater)
      .addArray(a.z, a.highWater)
      .addArray(a.heading, a.highWater)
      .addArray(a.targetHeading, a.highWater)
      .addArray(a.speed, a.highWater)
      .addArray(a.alive, a.highWater)
      .addArray(a.generation, a.highWater)
      .addArray(f.slotSpecies)
      .addArray(f.slotBiomass)
      .addArray(f.litterFast)
      .addArray(f.litterFastN)
      .addArray(f.litterWood)
      .addArray(f.litterWoodN)
      .addArray(f.nutrient)
      .addArray(f.accT)
      .addArray(f.accW)
      .addArray(f.accRunoff)
      .addArray(f.accMinT)
      .addArray(f.accHours)
      .addArray(f.ledger)
      .addInt(f.lastSliceHour)
      .addInt(wd.count)
      .addArray(wd.x, wd.highWater)
      .addArray(wd.z, wd.highWater)
      .addArray(wd.species, wd.highWater)
      .addArray(wd.age, wd.highWater)
      .addArray(wd.biomass, wd.highWater)
      .addArray(wd.leaf, wd.highWater)
      .addArray(wd.health, wd.highWater)
      .addArray(wd.stage, wd.highWater)
      .addArray(wd.stressW, wd.highWater)
      .addArray(wd.stressL, wd.highWater)
      .addArray(wd.alive, wd.highWater)
      .addArray(wd.generation, wd.highWater);
    return hasher.digest();
  }

  getTimings(): readonly SystemTiming[] {
    return this.scheduler.getTimings();
  }
}
