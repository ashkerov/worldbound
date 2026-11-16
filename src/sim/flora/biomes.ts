// Каталог биомов (content/biomes/biomes.json) и классификатор. Биом не хранится и не задаётся:
// он вычисляется из фактической растительности и условий ячейки (ARCHITECTURE.md, раздел 5).

import catalog from '../../../content/biomes/biomes.json' with { type: 'json' };
import { ID_PATTERN, validateCatalog, type CatalogSchema, type FieldSpec } from '../content/schema';

export const BIOME_WATER = ['river', 'lake', 'sea'] as const;

export interface BiomeRule {
  water?: (typeof BIOME_WATER)[number][];
  treeCoverMin?: number;
  treeCoverMax?: number;
  shrubCoverMin?: number;
  herbBiomassMin?: number;
  herbBiomassMax?: number;
  coniferShareMin?: number;
  coniferShareMax?: number;
  tMeanMin?: number;
  tMeanMax?: number;
  moistureMin?: number;
  moistureMax?: number;
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
        herbBiomassMin: { kind: 'number', min: 0, max: 5000, optional: true },
        herbBiomassMax: { kind: 'number', min: 0, max: 5000, optional: true },
        coniferShareMin: share,
        coniferShareMax: share,
        tMeanMin: { kind: 'number', min: -40, max: 40, optional: true },
        tMeanMax: { kind: 'number', min: -40, max: 40, optional: true },
        moistureMin: { kind: 'number', min: 0, max: 2, optional: true },
        moistureMax: { kind: 'number', min: 0, max: 2, optional: true },
      },
    },
  },
};

export function loadBiomes(raw: unknown): Biome[] {
  const biomes = validateCatalog<Biome>(BIOMES_SCHEMA, raw);
  const last = biomes[biomes.length - 1]!;
  if (Object.keys(last.rule).length !== 0) throw new Error(`${BIOMES_SCHEMA.file}: последний биом должен быть без условий (биом по умолчанию)`);
  return biomes;
}

export const BIOMES: readonly Biome[] = loadBiomes(catalog);

/** Показатели ячейки, по которым определяется биом. */
export interface BiomeInput {
  /** 0 — суша, 1 — река, 2 — озеро, 3 — море. */
  water: number;
  treeCover: number;
  shrubCover: number;
  herbBiomass: number;
  coniferShare: number;
  tMean: number;
  moisture: number;
}

const WATER_INDEX: Record<(typeof BIOME_WATER)[number], number> = { river: 1, lake: 2, sea: 3 };

export function classifyBiome(c: BiomeInput, biomes: readonly Biome[] = BIOMES): number {
  for (let i = 0; i < biomes.length; i++) {
    const r = biomes[i]!.rule;
    if (r.water) {
      if (!r.water.some((w) => WATER_INDEX[w] === c.water)) continue;
    } else if (c.water !== 0) continue;
    if (r.treeCoverMin !== undefined && c.treeCover < r.treeCoverMin) continue;
    if (r.treeCoverMax !== undefined && c.treeCover > r.treeCoverMax) continue;
    if (r.shrubCoverMin !== undefined && c.shrubCover < r.shrubCoverMin) continue;
    if (r.herbBiomassMin !== undefined && c.herbBiomass < r.herbBiomassMin) continue;
    if (r.herbBiomassMax !== undefined && c.herbBiomass > r.herbBiomassMax) continue;
    if (r.coniferShareMin !== undefined && c.coniferShare < r.coniferShareMin) continue;
    if (r.coniferShareMax !== undefined && c.coniferShare > r.coniferShareMax) continue;
    if (r.tMeanMin !== undefined && c.tMean < r.tMeanMin) continue;
    if (r.tMeanMax !== undefined && c.tMean > r.tMeanMax) continue;
    if (r.moistureMin !== undefined && c.moisture < r.moistureMin) continue;
    if (r.moistureMax !== undefined && c.moisture > r.moistureMax) continue;
    return i;
  }
  return biomes.length - 1;
}
