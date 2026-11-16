// Каталог видов растений (content/plants/plants.json) со схемой и проверкой при загрузке.
// Симуляция видит вид как индекс записи; параметры — плоские числа для быстрых расчётов.

import catalog from '../../../content/plants/plants.json' with { type: 'json' };
import { CatalogError, ID_PATTERN, ordered, validateCatalog, type CatalogSchema, type FieldSpec } from '../content/schema';
import { SOILS } from '../env/soils';

export const PLANT_FORMS = ['herb', 'shrub', 'tree'] as const;
export type PlantForm = (typeof PLANT_FORMS)[number];
export const LEAF_HABITS = ['annualDieback', 'deciduous', 'evergreen'] as const;
export type LeafHabit = (typeof LEAF_HABITS)[number];

interface Range4 {
  min: number;
  optMin: number;
  optMax: number;
  max: number;
}

export interface PlantSpecies {
  id: string;
  name: string;
  form: PlantForm;
  leafHabit: LeafHabit;
  /** Среднесуточная температура роста, °C. */
  temperature: Range4;
  /** Среднесуточная температура, ниже которой растение повреждается даже в покое, °C. */
  frostKill: number;
  /** Влага почвы, доля полевой влагоёмкости. */
  moisture: Range4;
  /** Теневыносливость 0..1: доля света, достаточная для полного роста, — 1 − 0,85 × теневыносливость. */
  shadeTolerance: number;
  /** Потребность в элементе питания 0..1. */
  nutrientDemand: number;
  /** Темп роста за игровой год: у трав — относительный (год⁻¹), у древесных — множитель B^0,75 (кг^0,25/год). */
  growthRate: number;
  /** Предельная биомасса: травы — г/м², древесные — кг на растение. */
  maxBiomass: number;
  /** Древесные: биомасса половины предельной высоты, кг. */
  halfBiomass?: number;
  maxHeight?: number;
  maxCrownRadius?: number;
  /** Содержание элемента питания в сухом веществе, доля. */
  nutrientContent: number;
  /** Древесные: доля листвы в биомассе. */
  leafFraction?: number;
  maturityYears?: number;
  lifespanYears?: number;
  /** Травы — оборот биомассы за год; древесные — фоновая смертность за год. */
  baseMortality: number;
  /** Масса семени, г. */
  seedMass: number;
  /** Древесные: семян на м² кроны за год. */
  fecundity?: number;
  dispersal?: { mean: number; max: number };
  /** Вероятность приживания при подходящих условиях. */
  establishment: number;
  /** Травы: доля биомассы, уходящая за год в соседние ячейки (расселение). */
  spreadRate?: number;
  /** Фиксация элемента питания при полном развитии, г/м² за год. */
  fixesNutrient?: number;
  /** Скорость разложения опада относительно средней. */
  litterQuality: number;
  /** Вес вида среди колонистов извне. */
  colonistWeight: number;
  /** Предпочтение почв 0..1 по идентификатору почвы; нет записи — 0,6. */
  soilPreference?: Record<string, number>;
}

const range4 = (min: number, max: number): FieldSpec => ({
  kind: 'object',
  fields: {
    min: { kind: 'number', min, max },
    optMin: { kind: 'number', min, max },
    optMax: { kind: 'number', min, max },
    max: { kind: 'number', min, max },
  },
  check: ordered('min', 'optMin', 'optMax', 'max'),
});

export const PLANTS_SCHEMA: CatalogSchema = {
  file: 'content/plants/plants.json',
  listField: 'plants',
  maxEntries: 254,
  entry: {
    id: { kind: 'string', pattern: ID_PATTERN },
    name: { kind: 'string' },
    form: { kind: 'enum', values: PLANT_FORMS },
    leafHabit: { kind: 'enum', values: LEAF_HABITS },
    temperature: range4(-30, 45),
    frostKill: { kind: 'number', min: -70, max: 5 },
    moisture: range4(0, 2),
    shadeTolerance: { kind: 'number', min: 0, max: 1 },
    nutrientDemand: { kind: 'number', min: 0, max: 1 },
    growthRate: { kind: 'number', min: 0.01, max: 100 },
    maxBiomass: { kind: 'number', min: 1, max: 20000 },
    halfBiomass: { kind: 'number', min: 0.1, max: 10000, optional: true },
    maxHeight: { kind: 'number', min: 0.2, max: 80, optional: true },
    maxCrownRadius: { kind: 'number', min: 0.2, max: 20, optional: true },
    nutrientContent: { kind: 'number', min: 0.001, max: 0.06 },
    leafFraction: { kind: 'number', min: 0.01, max: 0.5, optional: true },
    maturityYears: { kind: 'number', min: 1, max: 200, optional: true },
    lifespanYears: { kind: 'number', min: 2, max: 2000, optional: true },
    baseMortality: { kind: 'number', min: 0, max: 5 },
    seedMass: { kind: 'number', min: 0.00001, max: 50 },
    fecundity: { kind: 'number', min: 0, max: 10000, optional: true },
    dispersal: {
      kind: 'object',
      optional: true,
      fields: { mean: { kind: 'number', min: 0.5, max: 5000 }, max: { kind: 'number', min: 1, max: 20000 } },
      check: ordered('mean', 'max'),
    },
    establishment: { kind: 'number', min: 0, max: 1 },
    spreadRate: { kind: 'number', min: 0, max: 20, optional: true },
    fixesNutrient: { kind: 'number', min: 0, max: 20, optional: true },
    litterQuality: { kind: 'number', min: 0.05, max: 5 },
    colonistWeight: { kind: 'number', min: 0, max: 1 },
    soilPreference: { kind: 'map', keys: SOILS.map((s) => s.id), value: { kind: 'number', min: 0, max: 1 }, optional: true },
  },
  check: (e) => {
    const woody = e.form !== 'herb';
    const needed = woody ? ['halfBiomass', 'maxHeight', 'maxCrownRadius', 'leafFraction', 'maturityYears', 'lifespanYears', 'fecundity', 'dispersal'] : ['spreadRate'];
    for (const key of needed) if (e[key] === undefined) return `для формы «${String(e.form)}» обязательно поле ${key}`;
    if (woody && e.leafHabit === 'annualDieback') return 'древесные не отмирают до корня на зиму: leafHabit должен быть deciduous или evergreen';
    if (woody && (e.maturityYears as number) >= (e.lifespanYears as number)) return 'зрелость должна наступать раньше конца жизни';
    return null;
  },
};

export function loadPlants(raw: unknown): PlantSpecies[] {
  const plants = validateCatalog<PlantSpecies>(PLANTS_SCHEMA, raw);
  if (plants.length > 254) throw new CatalogError('Слишком много видов: индекс 255 зарезервирован под «пусто»');
  return plants;
}

export const PLANTS: readonly PlantSpecies[] = loadPlants(catalog);
/** Слот травяного яруса без вида. */
export const NO_SPECIES = 255;

/** Плоские параметры видов для горячих циклов (индекс — номер вида). */
export interface SpeciesTable {
  count: number;
  woody: Uint8Array;
  tree: Uint8Array;
  evergreen: Uint8Array;
  dieback: Uint8Array;
  tMin: Float64Array;
  tOptMin: Float64Array;
  tOptMax: Float64Array;
  tMax: Float64Array;
  frostKill: Float64Array;
  wMin: Float64Array;
  wOptMin: Float64Array;
  wOptMax: Float64Array;
  wMax: Float64Array;
  lightNeed: Float64Array;
  nutrientHalf: Float64Array;
  growth: Float64Array;
  maxBiomass: Float64Array;
  halfBiomass: Float64Array;
  maxHeight: Float64Array;
  maxCrown: Float64Array;
  nutrient: Float64Array;
  leafFraction: Float64Array;
  maturityYears: Float64Array;
  lifespanYears: Float64Array;
  mortality: Float64Array;
  seedMass: Float64Array;
  fecundity: Float64Array;
  dispersalMean: Float64Array;
  dispersalMax: Float64Array;
  establishment: Float64Array;
  spread: Float64Array;
  fixes: Float64Array;
  litterQuality: Float64Array;
  colonist: Float64Array;
  conifer: Uint8Array;
  /** soil[species × soilCount + soil] — предпочтение почвы. */
  soil: Float64Array;
}

export function speciesTable(plants: readonly PlantSpecies[]): SpeciesTable {
  const n = plants.length;
  const f = () => new Float64Array(n);
  const t: SpeciesTable = {
    count: n,
    woody: new Uint8Array(n),
    tree: new Uint8Array(n),
    evergreen: new Uint8Array(n),
    dieback: new Uint8Array(n),
    tMin: f(),
    tOptMin: f(),
    tOptMax: f(),
    tMax: f(),
    frostKill: f(),
    wMin: f(),
    wOptMin: f(),
    wOptMax: f(),
    wMax: f(),
    lightNeed: f(),
    nutrientHalf: f(),
    growth: f(),
    maxBiomass: f(),
    halfBiomass: f(),
    maxHeight: f(),
    maxCrown: f(),
    nutrient: f(),
    leafFraction: f(),
    maturityYears: f(),
    lifespanYears: f(),
    mortality: f(),
    seedMass: f(),
    fecundity: f(),
    dispersalMean: f(),
    dispersalMax: f(),
    establishment: f(),
    spread: f(),
    fixes: f(),
    litterQuality: f(),
    colonist: f(),
    conifer: new Uint8Array(n),
    soil: new Float64Array(n * SOILS.length),
  };
  plants.forEach((p, i) => {
    t.woody[i] = p.form === 'herb' ? 0 : 1;
    t.tree[i] = p.form === 'tree' ? 1 : 0;
    t.evergreen[i] = p.leafHabit === 'evergreen' ? 1 : 0;
    t.dieback[i] = p.leafHabit === 'annualDieback' ? 1 : 0;
    t.tMin[i] = p.temperature.min;
    t.tOptMin[i] = p.temperature.optMin;
    t.tOptMax[i] = p.temperature.optMax;
    t.tMax[i] = p.temperature.max;
    t.frostKill[i] = p.frostKill;
    t.wMin[i] = p.moisture.min;
    t.wOptMin[i] = p.moisture.optMin;
    t.wOptMax[i] = p.moisture.optMax;
    t.wMax[i] = p.moisture.max;
    t.lightNeed[i] = 1 - 0.85 * p.shadeTolerance;
    t.nutrientHalf[i] = 0.2 + 1.2 * p.nutrientDemand;
    t.growth[i] = p.growthRate;
    t.maxBiomass[i] = p.maxBiomass;
    t.halfBiomass[i] = p.halfBiomass ?? 0;
    t.maxHeight[i] = p.maxHeight ?? 0.5;
    t.maxCrown[i] = p.maxCrownRadius ?? 0;
    t.nutrient[i] = p.nutrientContent;
    t.leafFraction[i] = p.leafFraction ?? 0;
    t.maturityYears[i] = p.maturityYears ?? 0;
    t.lifespanYears[i] = p.lifespanYears ?? 0;
    t.mortality[i] = p.baseMortality;
    t.seedMass[i] = p.seedMass;
    t.fecundity[i] = p.fecundity ?? 0;
    t.dispersalMean[i] = p.dispersal?.mean ?? 0;
    t.dispersalMax[i] = p.dispersal?.max ?? 0;
    t.establishment[i] = p.establishment;
    t.spread[i] = p.spreadRate ?? 0;
    t.fixes[i] = p.fixesNutrient ?? 0;
    t.litterQuality[i] = p.litterQuality;
    t.colonist[i] = p.colonistWeight;
    t.conifer[i] = p.form === 'tree' && p.leafHabit === 'evergreen' ? 1 : 0;
    SOILS.forEach((s, k) => (t.soil[i * SOILS.length + k] = p.soilPreference?.[s.id] ?? 0.6));
  });
  return t;
}

export const SPECIES = speciesTable(PLANTS);

export function speciesIndex(id: string): number {
  const i = PLANTS.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`Нет вида ${id}`);
  return i;
}
