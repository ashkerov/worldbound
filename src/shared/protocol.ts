// Протокол «главный поток ↔ воркер симуляции» (ARCHITECTURE.md, раздел 4.2).
// Единственный контракт между симуляцией, рендером и UI.

import type { Speed } from './time';
import type { WorldConfig } from './worldConfig';

// ───────── Команды: главный поток → симуляция ─────────

export type Command =
  | { type: 'setSpeed'; speed: Speed }
  | { type: 'spawnTestAgents'; count: number }
  | { type: 'clearTestAgents' };

export interface WorldInit {
  config: Partial<WorldConfig> & { seed: number };
  /** Число тестовых агентов на старте (отладка, фаза 0). */
  testAgents: number;
  /** false — не заселять растениями (состояние придёт из сохранения). */
  populate?: boolean;
  /** Wildlands: сколько игровых лет готовить мир (по умолчанию WILDLANDS_YEARS); для замеров и тестов. */
  prepareYears?: number | undefined;
}

export type ToWorker =
  | { type: 'command'; command: Command }
  | { type: 'recycle'; buffer: ArrayBuffer }
  | { type: 'request'; requestId: number; request: SimRequest };

/** Слои-карты (DEVELOPMENT_PLAN.md, фаза 2). Каждый — раскраска реальных данных симуляции. */
export const LAYERS = ['height', 'moisture', 'temperature', 'precipitation', 'snow', 'soil', 'provinces', 'biomes'] as const;
export type LayerId = (typeof LAYERS)[number];

export const LAYER_LABELS: Record<LayerId, string> = {
  height: 'Высота',
  moisture: 'Влага почвы',
  temperature: 'Температура',
  precipitation: 'Осадки',
  snow: 'Снег',
  soil: 'Почвы',
  provinces: 'Провинции',
  biomes: 'Биомы',
};

export interface LegendEntry {
  label: string;
  /** Цвет в виде #rrggbb. */
  color: string;
}

export interface WorldSummary {
  id: string;
  name: string;
  config: WorldConfig;
  tick: number;
  /** Реальное время создания и последнего сохранения (ISO). */
  createdAt: string;
  savedAt: string;
  /** Занятое место на диске, байт. */
  bytes: number;
}

export type SimRequest =
  | { kind: 'listWorlds' }
  | {
      kind: 'createWorld';
      config: WorldConfig;
      testAgents: number;
      /** Wildlands: лет подготовки (по умолчанию WILDLANDS_YEARS; для проверок). */
      prepareYears?: number | undefined;
      /** Нагрузочный стенд: посадить столько древесных (flora/loadStand.ts); только для замеров. */
      loadTrees?: number | undefined;
    }
  | { kind: 'cancelCreate' }
  | { kind: 'loadWorld'; worldId: string; testAgents?: number }
  | { kind: 'saveWorld' }
  | { kind: 'closeWorld'; save: boolean }
  | { kind: 'deleteWorld'; worldId: string }
  | { kind: 'cellInfo'; x: number; z: number }
  | { kind: 'setLayer'; layer: LayerId | null }
  | { kind: 'stateHash' }
  | { kind: 'storageSelfTest' };

export interface CellInfo {
  x: number;
  z: number;
  province: string;
  height: number;
  slopeDeg: number;
  /** 'Суша' | 'Река' | 'Озеро' | 'Море'. */
  water: string;
  waterDepth: number;
  dischargeNow: number;
  dischargeMean: number;
  soil: string;
  fertility: number;
  moistureMm: number;
  /** Доля полевой влагоёмкости 0..1. */
  moistureRel: number;
  snowMm: number;
  temperature: number;
  tMean: number;
  /** Средняя температура самого тёплого и самого холодного времени года. */
  tSummer: number;
  tWinter: number;
  precipYear: number;
  /** Текущая интенсивность осадков, мм/ч. */
  precipNow: number;
  precipType: 'нет' | 'дождь' | 'снег';
  cloud: number;
  light: number;
  greenness: number;
  windSpeed: number;
  /** Откуда дует ветер: «С», «СВ», … */
  windFrom: string;
  deposit: string;
  depositRichness: number;
  /** Биом ячейки (устойчивая классификация по растительности). */
  biome: string;
  /** Биомасса трав, г/м², и главный вид травяного яруса. */
  herbBiomass: number;
  herbMain: string;
  /** Древесных растений в ячейке и покрытие кронами деревьев и кустарников 0..1. */
  woodyPlants: number;
  treeCover: number;
  shrubCover: number;
}

export type SimResponse =
  | { kind: 'listWorlds'; worlds: WorldSummary[] }
  | { kind: 'createWorld'; worldId: string }
  | { kind: 'cancelCreate'; cancelled: boolean }
  | { kind: 'loadWorld'; worldId: string }
  | { kind: 'saveWorld'; savedAt: string; bytes: number; ms: number }
  | { kind: 'closeWorld' }
  | { kind: 'deleteWorld'; removed: boolean }
  | { kind: 'cellInfo'; info: CellInfo | null }
  | { kind: 'setLayer' }
  | { kind: 'stateHash'; tick: number; hash: string; geoHash: string }
  | { kind: 'storageSelfTest'; ok: boolean; backend: string; detail: string }
  | { kind: 'failed'; message: string };

// ───────── Снимки и события: симуляция → главный поток ─────────

/**
 * Снимок кадра. Строка сущности в `buffer` — SNAPSHOT_STRIDE чисел Float32:
 * [id, x, y, z, heading, kind]. id хранится как Float32 точно, пока < 2^24;
 * для тестовых агентов фазы 0 передаётся индекс слота.
 */
export const SNAPSHOT_STRIDE = 6;

export interface FrameSnapshot {
  type: 'snapshot';
  tick: number;
  count: number;
  buffer: ArrayBuffer;
}

export interface HeightGrid {
  /** Число отсчётов по стороне. */
  samples: number;
  /** Шаг между отсчётами, м. */
  spacing: number;
  /** Float32, samples². */
  heights: ArrayBuffer;
}

/** Статика мира: передаётся один раз после создания или загрузки. */
export interface WorldStaticMessage {
  type: 'worldStatic';
  worldId: string;
  config: WorldConfig;
  worldSize: number;
  /** Эко-ячеек по стороне и размер ячейки, м. */
  n: number;
  cellSize: number;
  terrain: HeightGrid;
  /** Окрестность за границей мира (только для показа горизонта). */
  horizon: HeightGrid & { originX: number; originZ: number };
  /** Float32 n²: высота дна/поверхности ячейки. */
  cellHeight: ArrayBuffer;
  /** Uint8 n²: 0 суша, 1 река, 2 озеро, 3 море. */
  waterKind: ArrayBuffer;
  /** Float32 n²: уровень воды. */
  waterLevel: ArrayBuffer;
  /** Int8 2·n²: направление стока к соседней ячейке (dx, dz). */
  flow: ArrayBuffer;
  /** Float32 n²: средний расход, м³/с. */
  meanDischarge: ArrayBuffer;
  /** Uint8 n²: тип почвы (индекс в soilIds). */
  soil: ArrayBuffer;
  soilIds: string[];
  /** Float32 n²: множитель осадков ячейки к сетке чанков. */
  precipFactor: ArrayBuffer;
  provinces: { id: number; name: string; x: number; z: number }[];
  /** Виды растений каталога в порядке номеров (для рендера растительности, этап 5 фазы 3). */
  plants: PlantVisualInfo[];
  /** Номера трав в порядке столбцов поля трав (FloraFieldMessage.herbs). */
  herbOrder: number[];
}

export interface PlantVisualInfo {
  id: string;
  form: 'herb' | 'shrub' | 'tree';
  /** Листопадный или вечнозелёный (из каталога). */
  leafHabit: string;
}

/**
 * Растительность для рендера (этап 5 фазы 3). Древесные растения — строками по FLORA_WOODY_STRIDE чисел Float32:
 * [x, z, высота м, радиус кроны м, номер вида, облиственность 0..1, номер растения mod 2^24, здоровье 0..1].
 * Мир поделён на чанки FLORA_CHUNK_CELLS × FLORA_CHUNK_CELLS эко-ячеек; сообщение несёт только изменившиеся чанки
 * (full — все чанки мира, после открытия): chunkIds[k] — номер чанка, его строки — offsets[k]..offsets[k+1].
 */
export const FLORA_WOODY_STRIDE = 8;
export const FLORA_CHUNK_CELLS = 16;

export interface FloraWoodyMessage {
  type: 'floraWoody';
  tick: number;
  full: boolean;
  chunksPerSide: number;
  /** Int32: номера изменившихся чанков. */
  chunkIds: ArrayBuffer;
  /** Int32 chunkIds.length + 1: начала строк чанков в data. */
  offsets: ArrayBuffer;
  /** Float32: строки растений. */
  data: ArrayBuffer;
  /** Всего древесных в мире (для отладки и проверок). */
  total: number;
}

/**
 * Травяной ярус и полог по ячейкам (раз в игровые сутки). herbs — Uint8 n²·H: биомасса трав по видам
 * (H = herbOrder.length; значение v ⇒ (v/255)²·HERB_FIELD_MAX г/м²). canopy — RGBA8 n²: R — покрытие кронами
 * деревьев, G — доля хвойных в нём, B — покрытие кустарниками, A — средняя облиственность древесных ячейки.
 */
export const HERB_FIELD_MAX = 1020;

export interface FloraFieldMessage {
  type: 'floraField';
  tick: number;
  n: number;
  herbs: ArrayBuffer;
  canopy: ArrayBuffer;
}

/** Состояние поверхности: раз в игровой час. RGBA8 n²: R — снег, G — влага почвы, B — индекс зелени, A — недавние осадки. */
export interface SurfaceMessage {
  type: 'surface';
  tick: number;
  n: number;
  data: ArrayBuffer;
}

/** Погода по чанкам: раз в шаг погоды (10 игровых минут). */
export interface WeatherMessage {
  type: 'weather';
  tick: number;
  chunks: number;
  /** Float32 chunks²: осадки, мм/ч (до поправки ячейки). */
  rate: ArrayBuffer;
  /** Float32 chunks²: облачность 0..1. */
  cloud: ArrayBuffer;
  /** Float32 chunks²: температура воздуха в центре чанка, °C. */
  temperature: ArrayBuffer;
  windX: number;
  windZ: number;
  windSpeed: number;
}

export interface LayerMessage {
  type: 'layer';
  layer: LayerId;
  tick: number;
  n: number;
  /** RGBA8 n². */
  image: ArrayBuffer;
  legend: LegendEntry[];
}

export interface SimStats {
  type: 'stats';
  tick: number;
  speed: Speed;
  agents: number;
  /** Среднее время такта за окно, мс. */
  tickMsAvg: number;
  /** Худшее время такта за окно, мс. */
  tickMsMax: number;
  /** Фактическая частота тактов за окно, 1/с. */
  ticksPerSecond: number;
  /** Сколько тактов воркер не успел выполнить за окно. */
  droppedTicks: number;
}

export type FromWorker =
  | {
      type: 'progress';
      stage: string;
      fraction: number;
      /** Подробности этапа (год подготовки, число растений) и оценка оставшегося времени, с. */
      detail?: string;
      etaSeconds?: number | undefined;
      /** Этап можно отменить запросом cancelCreate. */
      cancellable?: boolean;
    }
  | WorldStaticMessage
  | SurfaceMessage
  | WeatherMessage
  | LayerMessage
  | FloraWoodyMessage
  | FloraFieldMessage
  | { type: 'minimap'; tick: number; n: number; image: ArrayBuffer }
  | FrameSnapshot
  | SimStats
  | { type: 'saved'; worldId: string; savedAt: string; auto: boolean; bytes: number }
  | { type: 'response'; requestId: number; response: SimResponse }
  | { type: 'error'; message: string };
