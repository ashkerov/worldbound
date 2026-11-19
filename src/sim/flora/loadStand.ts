// Нагрузочный стенд (этапы 3 и 5 фазы 3): мир с заданным числом древесных растений — для замеров
// симуляции (tools/flora-load.ts) и рендера в браузере (?loadTrees=N). Растения — настоящие растения симуляции
// (растут, размножаются, гибнут), расставленные детерминированно по seed стенда: виды и возраст — случайные,
// биомасса — по возрасту. Это стенд, а не сценарий мира: в меню создания его нет.

import { counterRandom } from '../../shared/rng';
import type { World } from '../core/world';
import { WaterKind } from '../worldgen/geo';
import { initBiomes } from './biomeState';
import { SPECIES } from './species';
import { MAX_WOODY_PER_CELL } from './state';
import { refreshCover } from './system';

export function plantLoadStand(world: World, target: number): number {
  const geo = world.geo;
  const f = world.flora;
  const w = f.woody;
  const woody = Array.from({ length: SPECIES.count }, (_, s) => s).filter((s) => SPECIES.woody[s] === 1);
  const land: number[] = [];
  for (let c = 0; c < geo.n * geo.n; c++) if (geo.waterKind[c] === WaterKind.None) land.push(c);
  let k = 0;
  const limit = Math.min(target, w.capacity);
  while (w.count < limit && k < limit * 4) {
    const c = land[Math.floor(counterRandom(1, 1, k, 0) * land.length)]!;
    const s = woody[Math.floor(counterRandom(1, 2, k, 0) * woody.length)]!;
    const age = 1 + counterRandom(1, 3, k, 0) * 60;
    const b = Math.min(SPECIES.maxBiomass[s]!, 0.02 + 0.6 * age * age * 0.05);
    k++;
    if (f.woodyCount[c]! >= MAX_WOODY_PER_CELL) continue;
    w.spawn(s, ((c % geo.n) + counterRandom(1, 4, k - 1, 0)) * geo.cellSize, (Math.floor(c / geo.n) + counterRandom(1, 5, k - 1, 0)) * geo.cellSize, c, b, age);
    f.woodyCount[c] = f.woodyCount[c]! + 1;
  }
  refreshCover(world, true);
  initBiomes(world);
  return w.count;
}
