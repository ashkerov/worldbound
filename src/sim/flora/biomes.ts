// Каталог биомов (content/biomes/biomes.json) и классификатор. Биом не задаётся участку:
// он вычисляется из фактической растительности и условий ячейки (ARCHITECTURE.md, раздел 5).
// Входы сглажены по вегетационному сезону, а переключение требует устойчивости (flora/biomeState.ts),
// поэтому биом следует за растительностью с запаздыванием порядка года и не мигает на границах порогов.

import catalog from '../../../content/biomes/biomes.json' with { type: 'json' };
import { ID_PATTERN, validateCatalog, type CatalogSchema, type FieldSpec } from '../content/schema';

export const BIOME_WATER = ['river', 'lake', 'sea'] as const;

export interface BiomeRule {
  water?: (typeof BIOME_WATER)[number][];
  treeCoverMin?: number;
  treeCoverMax?: number;
  shrubCoverMin?: number;
  /** Доля высоких деревьев (≥ 6 м) в покрытии деревьями. */
  tallShareMin?: number;
  tallShareMax?: number;
  herbBiomassMin?: number;
  herbBiomassMax?: number;
  coniferShareMin?: number;
  coniferShareMax?: number;
  tMeanMin?: number;
  tMeanMax?: number;
  moistureMin?: number;
  moistureMax?: number;
  /** Доли биомассы трав по типу сообщества: степные, болотные, пионерные. */
  steppeShareMin?: number;
  steppeShareMax?: number;
  wetShareMin?: number;
  pioneerShareMin?: number;
}

export interface Biome {
  id: string;
  name: string;
  color: string;
  rule: BiomeRule;
}

const share: FieldSpec = { kind: 'number', min: 0, max: 1, optional: true };

export const BIOMES_SCHEMA: CatalogSchema = {
  file: 'content/biomes/biomes.json',
  listField: 'biomes',
  maxEntries: 64,
  entry: {
    id: { kind: 'string', pattern: ID_PATTERN },
    name: { kind: 'string' },
    color: { kind: 'string', pattern: /^#[0-9a-f]{6}$/ },
    rule: {
      kind: 'object',
      fields: {
        water: { kind: 'list', item: { kind: 'enum', values: BIOME_WATER }, optional: true, minItems: 1 },
        treeCoverMin: share,
        treeCoverMax: share,
        shrubCoverMin: share,
        tallShareMin: share,
        tallShareMax: share,
        herbBiomassMin: { kind: 'number', min: 0, max: 5000, optional: true },
        herbBiomassMax: { kind: 'number', min: 0, max: 5000, optional: true },
        coniferShareMin: share,
        coniferShareMax: share,
        tMeanMin: { kind: 'number', min: -40, max: 40, optional: true },
        tMeanMax: { kind: 'number', min: -40, max: 40, optional: true },
        moistureMin: { kind: 'number', min: 0, max: 2, optional: true },
        moistureMax: { kind: 'number', min: 0, max: 2, optional: true },
        steppeShareMin: share,
        steppeShareMax: share,
        wetShareMin: share,
        pioneerShareMin: share,
      },
    },
  },
};

export function loadBiomes(raw: unknown): Biome[] {
  const biomes = validateCatalog<Biome>(BIOMES_SCHEMA, raw);
  const last = biomes[biomes.length - 1]!;
  if (Object.keys(last.rule).length !== 0) throw new Error(`${BIOMES_SCHEMA.file}: последний биом должен быть без условий (биом по умолчанию)`);
  if (biomes.length > 255) throw new Error(`${BIOMES_SCHEMA.file}: не больше 255 биомов (номер хранится байтом)`);
  return biomes;
}

export const BIOMES: readonly Biome[] = loadBiomes(catalog);

/** Показатели ячейки, по которым определяется биом. */
export interface BiomeInput {
  /** 0 — суша, 1 — река, 2 — озеро, 3 — море. */
  water: number;
  treeCover: number;
  shrubCover: number;
  tallShare: number;
  herbBiomass: number;
  coniferShare: number;
  tMean: number;
  moisture: number;
  steppeShare: number;
  wetShare: number;
  pioneerShare: number;
}

const WATER_INDEX: Record<(typeof BIOME_WATER)[number], number> = { river: 1, lake: 2, sea: 3 };

/**
 * Совпадение с правилом биома. mode: 0 — точные пороги; +1 — с запасом (войти в биом); −1 — с допуском
 * (остаться в биоме). Запас — 10 % порога, но не меньше 0,02 для долей, 2 г/м² для биомассы, 0,5 °C.
 */
export function ruleMatches(r: BiomeRule, c: BiomeInput, mode: -1 | 0 | 1 = 0): boolean {
  if (r.water) {
    if (!r.water.some((w) => WATER_INDEX[w] === c.water)) return false;
  } else if (c.water !== 0) return false;
  const min = (v: number, t: number | undefined, abs = 0.02) => t === undefined || v >= t + mode * Math.max(0.1 * Math.abs(t), abs);
  const max = (v: number, t: number | undefined, abs = 0.02) => t === undefined || v <= t - mode * Math.max(0.1 * Math.abs(t), abs);
  return (
    min(c.treeCover, r.treeCoverMin) &&
    max(c.treeCover, r.treeCoverMax) &&
    min(c.shrubCover, r.shrubCoverMin) &&
    min(c.tallShare, r.tallShareMin) &&
    max(c.tallShare, r.tallShareMax) &&
    min(c.herbBiomass, r.herbBiomassMin, 2) &&
    max(c.herbBiomass, r.herbBiomassMax, 2) &&
    min(c.coniferShare, r.coniferShareMin) &&
    max(c.coniferShare, r.coniferShareMax) &&
    min(c.tMean, r.tMeanMin, 0.5) &&
    max(c.tMean, r.tMeanMax, 0.5) &&
    min(c.moisture, r.moistureMin) &&
    max(c.moisture, r.moistureMax) &&
    min(c.steppeShare, r.steppeShareMin) &&
    max(c.steppeShare, r.steppeShareMax) &&
    min(c.wetShare, r.wetShareMin) &&
    min(c.pioneerShare, r.pioneerShareMin)
  );
}

export function classifyBiome(c: BiomeInput, biomes: readonly Biome[] = BIOMES): number {
  for (let i = 0; i < biomes.length; i++) if (ruleMatches(biomes[i]!.rule, c)) return i;
  return biomes.length - 1;
}

/**
 * Устойчивая смена биома (триггер Шмитта): из текущего биома current в новый next переходим, только если
 * новый биом — более приоритетный и совпадает с запасом, или текущий не совпадает даже с допуском.
 * Так колебания у порога (доля осоки около 0,3) не переключают биом туда и обратно.
 */
export function confirmsChange(current: number, next: number, c: BiomeInput, biomes: readonly Biome[] = BIOMES): boolean {
  if (next < current) return ruleMatches(biomes[next]!.rule, c, 1);
  return !ruleMatches(biomes[current]!.rule, c, -1);
}

export function biomeIndex(id: string): number {
  const i = BIOMES.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`Нет биома ${id}`);
  return i;
}
