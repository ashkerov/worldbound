// Общие сгенерированные миры для тестов: генерация занимает секунды, статика неизменяема —
// поэтому один результат генератора переиспользуется многими симуляциями.

import { generateWorld, type GeneratedWorld } from '../../src/sim/worldgen/generate';
import { normalizeConfig, type WorldConfig } from '../../src/shared/worldConfig';
import { Simulation } from '../../src/sim/core/simulation';

const cache = new Map<string, GeneratedWorld>();

export function config(partial: Partial<WorldConfig> = {}): WorldConfig {
  return normalizeConfig({ seed: 42, size: 'S', ...partial });
}

export function generated(cfg: WorldConfig): GeneratedWorld {
  const key = JSON.stringify({ ...cfg, name: '' });
  let g = cache.get(key);
  if (!g) {
    g = generateWorld(cfg);
    cache.set(key, g);
  }
  return g;
}

/**
 * @param prepareYears Wildlands: лет подготовки. В тестах по умолчанию 0 — мир Wildlands без предварительного
 *                     прогона (банк семян, без растений); подготовку проверяют отдельные тесты и замеры.
 */
/** Мир Wildlands, прошедший подготовку заданной длины (в тестах — короткой): с травами и всходами. */
export function preparedSimulation(partial: Partial<WorldConfig> = {}, years = 1, testAgents = 0): Simulation {
  const sim = simulation({ ...partial, scenario: 'wild' }, testAgents, years);
  while (sim.preparation) sim.advancePreparation(7200);
  return sim;
}

export function simulation(partial: Partial<WorldConfig> = {}, testAgents = 0, prepareYears = 0): Simulation {
  const cfg = config(partial);
  return new Simulation({ config: cfg, testAgents, prepareYears }, undefined, generated(cfg));
}
