// Сериализация динамического состояния мира по секциям. Статика (рельеф, гидрология, климатические
// нормы, почвы, провинции) не сохраняется: она побитно воспроизводится генератором из параметров мира,
// а совпадение проверяется по хешу генерации. Каждая секция версионируется отдельно.

import { cellAt, type World } from '../core/world';
import { populateFromGreenness } from '../flora/populate';
import { refreshCover } from '../flora/system';
import { SectionReader, SectionWriter } from './binary';

export const SECTION_SCHEMAS = {
  core: 1,
  env: 1,
  agents: 1,
  /** 2 — этап 3 фазы 3: банк семян трав, качество опада, число древесных в ячейке. */
  flora: 2,
} as const;
export type SectionId = keyof typeof SECTION_SCHEMAS;
/** Без этих секций мир не загружается; остальные при отсутствии восстанавливаются миграцией. */
export const REQUIRED_SECTIONS: readonly SectionId[] = ['core', 'env'];

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
  const f = world.flora;
  const w = f.woody;
  const wh = w.highWater;
  const flora = new SectionWriter()
    .f64(f.lastSliceHour)
    .array(f.slotSpecies)
    .array(f.slotBiomass)
    .array(f.litterFast)
    .array(f.litterFastN)
    .array(f.litterFastQ)
    .array(f.litterWood)
    .array(f.litterWoodN)
    .array(f.nutrient)
    .array(f.accT)
    .array(f.accW)
    .array(f.accRunoff)
    .array(f.accMinT)
    .array(f.accHours)
    .array(f.dayT)
    .array(f.dayW)
    .array(f.capillary)
    .array(f.canopy)
    .array(f.treeCover)
    .array(f.shrubCover)
    .array(f.coniferCover)
    .array(f.seedBank)
    .array(f.woodyCount)
    .array(f.ledger)
    .f64(wh)
    .f64(w.count)
    .array(w.freeSlots())
    .array(w.x.subarray(0, wh))
    .array(w.z.subarray(0, wh))
    .array(w.species.subarray(0, wh))
    .array(w.age.subarray(0, wh))
    .array(w.biomass.subarray(0, wh))
    .array(w.leaf.subarray(0, wh))
    .array(w.health.subarray(0, wh))
    .array(w.stage.subarray(0, wh))
    .array(w.stressW.subarray(0, wh))
    .array(w.stressL.subarray(0, wh))
    .array(w.alive.subarray(0, wh))
    .array(w.generation.subarray(0, wh))
    .finish('flora', SECTION_SCHEMAS.flora);
  return { core, env, agents, flora };
}

/** Что пришлось восстановить миграцией при загрузке. */
export type Migration = 'agents:absent' | 'flora:from-greenness' | 'flora:schema1';

const SPEEDS = [0, 1, 2, 4, 8];

/**
 * Применяет секции к свежесозданному миру с той же статикой (без начального заселения).
 * Ошибка — исключение, мир тогда не используется. Возвращает список выполненных миграций.
 */
export function applySections(world: World, sections: Partial<Record<SectionId, Uint8Array>>): Migration[] {
  for (const id of REQUIRED_SECTIONS) if (!sections[id]) throw new Error(`Нет обязательной секции ${id}`);
  const migrations: Migration[] = [];
  const core = new SectionReader(sections.core!, 'core');
  if (core.header.schema !== SECTION_SCHEMAS.core) throw new Error(`Секция core: неизвестная версия схемы ${core.header.schema}`);
  const tick = core.f64();
  const speed = core.f64();
  if (!Number.isInteger(tick) || tick < 0) throw new Error('Секция core: неверный такт');
  if (!SPEEDS.includes(speed)) throw new Error('Секция core: неверная скорость');
  world.tick = tick;
  world.speed = speed as World['speed'];

  const env = new SectionReader(sections.env!, 'env');
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

  if (!sections.agents) migrations.push('agents:absent');
  else readAgents(world, sections.agents);

  if (sections.flora) {
    if (readFlora(world, sections.flora)) migrations.push('flora:schema1');
  } else {
    // Сохранение фазы 2: растений не было — травяной ярус восстанавливается из сохранённого индекса зелени.
    populateFromGreenness(world);
    refreshCover(world, false);
    migrations.push('flora:from-greenness');
  }
  return migrations;
}

function readAgents(world: World, bytes: Uint8Array): void {
  const agents = new SectionReader(bytes, 'agents');
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

/**
 * Читает секцию flora. Схема 2 — текущая. Схема 1 существовала в двух раскладках (сборки 824aa8f и 8a3be81
 * этапов 1–2 фазы 3): без суточных средних и полога и с ними; распознаются обе. Возвращает true, если была миграция.
 */
function readFlora(world: World, bytes: Uint8Array): boolean {
  const probe = new SectionReader(bytes, 'flora');
  const schema = probe.header.schema;
  if (schema === 2) {
    readFloraLayout(world, new SectionReader(bytes, 'flora'), 'v2');
    return false;
  }
  if (schema !== 1) throw new Error(`Секция flora: неизвестная версия схемы ${schema}`);
  try {
    readFloraLayout(world, new SectionReader(bytes, 'flora'), 'v1b');
  } catch {
    readFloraLayout(world, new SectionReader(bytes, 'flora'), 'v1a');
  }
  // Миграция схемы 1: опад считается опадом среднего качества, банк семян пуст (его не было), полог и счётчики — по растениям.
  const f = world.flora;
  for (let i = 0; i < f.litterFast.length; i++) f.litterFastQ[i] = f.litterFast[i]!;
  f.seedBank.fill(0);
  refreshCover(world, false);
  return true;
}

function readFloraLayout(world: World, r: SectionReader, layout: 'v1a' | 'v1b' | 'v2'): void {
  const f = world.flora;
  f.lastSliceHour = r.f64();
  r.into(f.slotSpecies);
  r.into(f.slotBiomass);
  r.into(f.litterFast);
  r.into(f.litterFastN);
  if (layout === 'v2') r.into(f.litterFastQ);
  r.into(f.litterWood);
  r.into(f.litterWoodN);
  r.into(f.nutrient);
  r.into(f.accT);
  r.into(f.accW);
  r.into(f.accRunoff);
  r.into(f.accMinT);
  r.into(f.accHours);
  if (layout !== 'v1a') {
    r.into(f.dayT);
    r.into(f.dayW);
    r.into(f.capillary);
    r.into(f.canopy);
    r.into(f.treeCover);
    r.into(f.shrubCover);
    r.into(f.coniferCover);
  }
  if (layout === 'v2') {
    r.into(f.seedBank);
    r.into(f.woodyCount);
  }
  r.into(f.ledger);
  const w = f.woody;
  const wh = r.f64();
  const count = r.f64();
  const free = r.int32();
  if (!Number.isInteger(wh) || wh < 0 || wh > w.capacity) throw new Error('Секция flora: неверное число растений');
  r.into(w.x.subarray(0, wh));
  r.into(w.z.subarray(0, wh));
  r.into(w.species.subarray(0, wh));
  r.into(w.age.subarray(0, wh));
  r.into(w.biomass.subarray(0, wh));
  r.into(w.leaf.subarray(0, wh));
  r.into(w.health.subarray(0, wh));
  r.into(w.stage.subarray(0, wh));
  r.into(w.stressW.subarray(0, wh));
  r.into(w.stressL.subarray(0, wh));
  r.into(w.alive.subarray(0, wh));
  r.into(w.generation.subarray(0, wh));
  r.end();
  w.restore(wh, count, free);
  for (let i = 0; i < wh; i++) w.cell[i] = cellAt(world, w.x[i]!, w.z[i]!);
}
