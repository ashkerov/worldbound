// Тестовые агенты фазы 0. Проверяют конвейер «такт → снимок → интерполяция»
// и разделение частот: движение каждый такт, решения — с разбросом.
// Игровой механикой не являются и будут заменены фауной (фаза 4).

import { counterRandom } from '../../shared/rng';
import { TICK_SECONDS } from '../../shared/time';
import type { System } from '../core/scheduler';
import type { World } from '../core/world';

const TWO_PI = Math.PI * 2;
const SYSTEM_SPAWN = 1;
const SYSTEM_DECIDE = 2;
const DECISION_INTERVAL = 20;
const TURN_RATE = 1.6; // рад/с
const BORDER = 12; // м

export function spawnTestAgents(world: World, count: number): number {
  const agents = world.agents;
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    const key = agents.highWater + i * 7919 + agents.count;
    const x = BORDER + counterRandom(world.seed, SYSTEM_SPAWN, key, 1) * (world.worldSize - 2 * BORDER);
    const z = BORDER + counterRandom(world.seed, SYSTEM_SPAWN, key, 2) * (world.worldSize - 2 * BORDER);
    const heading = counterRandom(world.seed, SYSTEM_SPAWN, key, 3) * TWO_PI;
    const speed = 0.8 + counterRandom(world.seed, SYSTEM_SPAWN, key, 4) * 1.4;
    if (world.agents.spawn(x, z, heading, speed) < 0) break;
    spawned++;
  }
  return spawned;
}

/** Решения: агент раз в DECISION_INTERVAL тактов выбирает новый курс. Разброс по индексу. */
export const testAgentDecisionSystem: System<World> = {
  name: 'testAgents.decide',
  period: 1,
  run(world, tick) {
    const a = world.agents;
    const slot = tick % DECISION_INTERVAL;
    for (let i = slot; i < a.highWater; i += DECISION_INTERVAL) {
      if (a.alive[i] !== 1) continue;
      a.targetHeading[i] = counterRandom(world.seed, SYSTEM_DECIDE, i, tick) * TWO_PI;
    }
  },
};

/** Движение: каждый такт. Поворот к целевому курсу, шаг вперёд, разворот у края мира. */
export const testAgentMoveSystem: System<World> = {
  name: 'testAgents.move',
  period: 1,
  run(world) {
    const a = world.agents;
    const size = world.worldSize;
    const maxTurn = TURN_RATE * TICK_SECONDS;
    for (let i = 0; i < a.highWater; i++) {
      if (a.alive[i] !== 1) continue;
      let x = a.x[i]!;
      let z = a.z[i]!;
      if (x < BORDER || x > size - BORDER || z < BORDER || z > size - BORDER) {
        a.targetHeading[i] = Math.atan2(size / 2 - z, size / 2 - x);
      }
      let heading = a.heading[i]!;
      let delta = a.targetHeading[i]! - heading;
      delta -= Math.round(delta / TWO_PI) * TWO_PI;
      if (delta > maxTurn) delta = maxTurn;
      else if (delta < -maxTurn) delta = -maxTurn;
      heading += delta;
      const step = a.speed[i]! * TICK_SECONDS;
      x += Math.cos(heading) * step;
      z += Math.sin(heading) * step;
      a.heading[i] = heading;
      a.x[i] = x < 0 ? 0 : x > size ? size : x;
      a.z[i] = z < 0 ? 0 : z > size ? size : z;
    }
  },
};
