// Динамический биом ячейки (docs/PHASE3_PLAN.md, раздел 14.2).
// Биом — производная от настоящей растительности, а не отдельное состояние участка:
//  1) раз в сутки в вегетационный сезон показатели ячейки (травы по типам сообществ, покрытие кронами,
//     влага) подмешиваются в сглаженные значения — сезонные колебания (зимнее отмирание трав,
//     листопад) не меняют биом;
//  2) классификатор каталога (flora/biomes.ts) применяется к сглаженным значениям;
//  3) биом меняется, только если новый результат держится четверть года подряд и пересекает порог с запасом
//     (триггер Шмитта, flora/biomes.ts: confirmsChange) — у порогов он не мигает.
// Поэтому биом отстаёт от растительности примерно на год, но никогда с ней не расходится надолго.

import { WaterKind } from '../worldgen/geo';
import type { World } from '../core/world';
import { BIOMES, classifyBiome, confirmsChange, type BiomeInput } from './biomes';
import { Community, NO_SPECIES, SPECIES } from './species';
import { SLOTS } from './state';

/** Скорость подмешивания за сутки сезона в долях года. Учитываются только дни вегетации (≈ 40 % года), поэтому время отклика биома ≈ 0,8 года. */
const EMA_PER_YEAR = 3;
/** Сутки считаются вегетационными при средней температуре выше этой и до листопада. */
const GROWING_T = 8;
const AUTUMN = 0.68;

const input: BiomeInput = { water: 0, treeCover: 0, shrubCover: 0, tallShare: 0, herbBiomass: 0, coniferShare: 0, tMean: 0, moisture: 0, steppeShare: 0, wetShare: 0, pioneerShare: 0 };
const herbParts = new Float64Array(4);

/** Биомасса трав ячейки: [всего, степные, болотные, пионерные], г/м². */
function herbsOf(world: World, c: number): Float64Array {
  const f = world.flora;
  herbParts.fill(0);
  for (let k = 0; k < SLOTS; k++) {
    const s = f.slotSpecies[c * SLOTS + k]!;
    if (s === NO_SPECIES) continue;
    const b = f.slotBiomass[c * SLOTS + k]!;
    herbParts[0]! += b;
    const g = SPECIES.community[s]!;
    if (g === Community.steppe) herbParts[1]! += b;
    else if (g === Community.wetland) herbParts[2]! += b;
    else if (g === Community.pioneer) herbParts[3]! += b;
  }
  return herbParts;
}

function waterBiome(kind: number): number {
  return classifyBiomeOf({ ...input, water: kind });
}

function classifyBiomeOf(c: BiomeInput): number {
  return classifyBiome(c, BIOMES);
}

/** Классификация ячейки по её сглаженным показателям. */
export function classifyTracked(world: World, c: number): number {
  const b = world.flora.biome;
  const geo = world.geo;
  const herb = b.herb[c]!;
  const tree = b.tree[c]!;
  input.water = geo.waterKind[c]!;
  input.treeCover = tree;
  input.shrubCover = b.shrub[c]!;
  input.tallShare = tree > 1e-6 ? b.tall[c]! / tree : 0;
  input.herbBiomass = herb;
  input.coniferShare = tree > 1e-6 ? b.conifer[c]! / tree : 0;
  input.tMean = geo.tMean[c]!;
  input.moisture = b.moisture[c]!;
  input.steppeShare = herb > 1e-6 ? b.steppe[c]! / herb : 0;
  input.wetShare = herb > 1e-6 ? b.wet[c]! / herb : 0;
  input.pioneerShare = herb > 1e-6 ? b.pioneer[c]! / herb : 0;
  return classifyBiomeOf(input);
}

/** Сглаженные показатели = текущие, биом = классификация (создание мира, миграция сохранения). */
export function initBiomes(world: World): void {
  const f = world.flora;
  const b = f.biome;
  const geo = world.geo;
  const count = geo.n * geo.n;
  for (let c = 0; c < count; c++) {
    if (geo.waterKind[c] !== WaterKind.None) {
      const id = waterBiome(geo.waterKind[c]!);
      b.current[c] = id;
      b.candidate[c] = id;
      b.days[c] = 0;
      continue;
    }
    const h = herbsOf(world, c);
    b.herb[c] = h[0]!;
    b.steppe[c] = h[1]!;
    b.wet[c] = h[2]!;
    b.pioneer[c] = h[3]!;
    b.moisture[c] = f.dayW[c]!;
    b.tree[c] = f.treeCover[c]!;
    b.shrub[c] = f.shrubCover[c]!;
    b.conifer[c] = f.coniferCover[c]!;
    b.tall[c] = f.tallCover[c]!;
    const id = classifyTracked(world, c);
    b.current[c] = id;
    b.candidate[c] = id;
    b.days[c] = 0;
  }
}

/**
 * Суточное обновление биома ячейки суши (вызывается из суточного шага флоры после роста).
 * @param holdDays сколько суток подряд новый биом должен держаться, чтобы сменить текущий
 */
export function updateBiome(world: World, c: number, dt: number, yearFrac: number, holdDays: number): void {
  const f = world.flora;
  const b = f.biome;
  if (f.dayT[c]! > GROWING_T && yearFrac < AUTUMN) {
    const a = Math.min(1, EMA_PER_YEAR * dt);
    const h = herbsOf(world, c);
    b.herb[c] = b.herb[c]! + a * (h[0]! - b.herb[c]!);
    b.steppe[c] = b.steppe[c]! + a * (h[1]! - b.steppe[c]!);
    b.wet[c] = b.wet[c]! + a * (h[2]! - b.wet[c]!);
    b.pioneer[c] = b.pioneer[c]! + a * (h[3]! - b.pioneer[c]!);
    b.moisture[c] = b.moisture[c]! + a * (f.dayW[c]! - b.moisture[c]!);
    b.tree[c] = b.tree[c]! + a * (f.treeCover[c]! - b.tree[c]!);
    b.shrub[c] = b.shrub[c]! + a * (f.shrubCover[c]! - b.shrub[c]!);
    b.conifer[c] = b.conifer[c]! + a * (f.coniferCover[c]! - b.conifer[c]!);
    b.tall[c] = b.tall[c]! + a * (f.tallCover[c]! - b.tall[c]!);
  }
  let next = classifyTracked(world, c);
  // Пересечение порога без запаса не считается сменой.
  if (next !== b.current[c] && !confirmsChange(b.current[c]!, next, input)) next = b.current[c]!;
  if (next === b.current[c]) {
    b.candidate[c] = next;
    b.days[c] = 0;
    return;
  }
  if (next !== b.candidate[c]) {
    b.candidate[c] = next;
    b.days[c] = 1;
  } else if (b.days[c]! < 255) b.days[c] = b.days[c]! + 1;
  if (b.days[c]! >= holdDays) {
    b.current[c] = next;
    b.days[c] = 0;
  }
}

/** Число ячеек суши по биомам (для отчётов, слоя и тестов). */
export function biomeCounts(world: World): number[] {
  const out = new Array<number>(BIOMES.length).fill(0);
  const cur = world.flora.biome.current;
  for (let c = 0; c < cur.length; c++) out[cur[c]!]!++;
  return out;
}
