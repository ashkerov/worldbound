// Сериализация динамического состояния мира по секциям. Статика (рельеф, гидрология, климатические
// нормы, почвы, провинции) не сохраняется: она побитно воспроизводится генератором из параметров мира,
// а совпадение проверяется по хешу генерации. Каждая секция версионируется отдельно.

import type { World } from '../core/world';
import { SectionReader, SectionWriter } from './binary';

export const SECTION_SCHEMAS = {
  core: 1,
  env: 1,
  agents: 1,
} as const;
export type SectionId = keyof typeof SECTION_SCHEMAS;

export function serializeWorld(world: World): Record<SectionId, Uint8Array> {
  const e = world.env;
  const a = world.agents;
  const core = new SectionWriter().f64(world.tick).f64(world.speed).finish('core', SECTION_SCHEMAS.core);
  const env = new SectionWriter()
    .array(e.moisture)
    .array(e.snow)
    .array(e.greenness)
    .array(e.discharge)
    .array(e.runoff)
    .array(e.waterTotals)
    .array(e.weather.cells)
    .array(e.weather.chunkRate)
    .array(e.weather.chunkCloud)
    .array(e.weather.chunkAccum)
    .array(e.weather.balance)
    .f64(e.lastHourStep)
    .finish('env', SECTION_SCHEMAS.env);
  const hw = a.highWater;
  const agents = new SectionWriter()
    .f64(hw)
    .f64(a.count)
    .array(a.freeSlots())
    .array(a.x.subarray(0, hw))
    .array(a.z.subarray(0, hw))
    .array(a.heading.subarray(0, hw))
    .array(a.targetHeading.subarray(0, hw))
    .array(a.speed.subarray(0, hw))
    .array(a.alive.subarray(0, hw))
    .array(a.generation.subarray(0, hw))
    .finish('agents', SECTION_SCHEMAS.agents);
  return { core, env, agents };
}

const SPEEDS = [0, 1, 2, 4, 8];

/** Применяет секции к свежесозданному миру с той же статикой. Ошибка — исключение, мир тогда не используется. */
export function applySections(world: World, sections: Record<SectionId, Uint8Array>): void {
  const core = new SectionReader(sections.core, 'core');
  if (core.header.schema !== SECTION_SCHEMAS.core) throw new Error(`Секция core: неизвестная версия схемы ${core.header.schema}`);
  const tick = core.f64();
  const speed = core.f64();
  if (!Number.isInteger(tick) || tick < 0) throw new Error('Секция core: неверный такт');
  if (!SPEEDS.includes(speed)) throw new Error('Секция core: неверная скорость');
  world.tick = tick;
  world.speed = speed as World['speed'];

  const env = new SectionReader(sections.env, 'env');
  if (env.header.schema !== SECTION_SCHEMAS.env) throw new Error(`Секция env: неизвестная версия схемы ${env.header.schema}`);
  const e = world.env;
  env.into(e.moisture);
  env.into(e.snow);
  env.into(e.greenness);
  env.into(e.discharge);
  env.into(e.runoff);
  env.into(e.waterTotals);
  env.into(e.weather.cells);
  env.into(e.weather.chunkRate);
  env.into(e.weather.chunkCloud);
  env.into(e.weather.chunkAccum);
  env.into(e.weather.balance);
  e.lastHourStep = env.f64();

  const agents = new SectionReader(sections.agents, 'agents');
  if (agents.header.schema !== SECTION_SCHEMAS.agents) throw new Error(`Секция agents: неизвестная версия схемы ${agents.header.schema}`);
  const a = world.agents;
  const hw = agents.f64();
  const count = agents.f64();
  const free = agents.int32();
  if (!Number.isInteger(hw) || hw < 0 || hw > a.capacity) throw new Error('Секция agents: неверное число слотов');
  a.clear();
  agents.into(a.x.subarray(0, hw));
  agents.into(a.z.subarray(0, hw));
  agents.into(a.heading.subarray(0, hw));
  agents.into(a.targetHeading.subarray(0, hw));
  agents.into(a.speed.subarray(0, hw));
  agents.into(a.alive.subarray(0, hw));
  agents.into(a.generation.subarray(0, hw));
  a.restore(hw, count, free);
}
