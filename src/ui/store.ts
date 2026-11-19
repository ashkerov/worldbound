// Состояние интерфейса. UI не обращается к симуляции и рендеру напрямую: данные приходят
// сюда из моста (app), действия уходят через функции, которые подставляет app.

import { create } from 'zustand';
import type { CellInfo, Command, LayerId, LegendEntry, SimStats, WorldSummary } from '../shared/protocol';
import type { Speed } from '../shared/time';
import type { WorldConfig } from '../shared/worldConfig';

/** Показатели рендера в виде, нужном интерфейсу (без зависимости от модуля render). */
export interface RenderStatsView {
  backend: 'webgpu' | 'webgl2';
  quality: string;
  fps: number;
  frameMsAvg: number;
  frameMsMax: number;
  longFrames: number;
  drawCalls: number;
  triangles: number;
  agentsDrawn: number;
  terrainNodes: number;
  resolution: string;
}

export interface StorageCheckView {
  state: 'idle' | 'running' | 'done';
  ok?: boolean;
  backend?: string;
  detail?: string;
}

export type Screen = 'menu' | 'create' | 'progress' | 'world';
export type QualityName = 'low' | 'medium' | 'high';
export type CameraModeView = 'strategic' | 'free';

export interface MinimapView {
  n: number;
  image: Uint8ClampedArray;
  tick: number;
}

export interface LayerView {
  id: LayerId;
  legend: LegendEntry[];
}

export interface WorldInfoView {
  id: string;
  config: WorldConfig;
  worldSize: number;
  provinces: { id: number; name: string; x: number; z: number }[];
}

export interface Actions {
  dispatch: (command: Command) => void;
  refreshWorlds: () => void;
  createWorld: (config: WorldConfig, prepareYears?: number, loadTrees?: number) => void;
  cancelCreate: () => void;
  openWorld: (id: string) => void;
  deleteWorld: (id: string) => void;
  saveNow: () => void;
  exitToMenu: () => void;
  setLayer: (layer: LayerId | null) => void;
  setCameraMode: (mode: CameraModeView) => void;
  setQuality: (quality: QualityName) => void;
  goTo: (x: number, z: number) => void;
  closeCard: () => void;
  runStorageCheck: () => void;
}

export interface UiState extends Actions {
  screen: Screen;
  /** Фатальная ошибка запуска (нет графики и т. п.). */
  fatal: string | null;
  /** Сообщение об ошибке операции (не удалось загрузить мир и т. п.). */
  notice: string | null;
  worlds: WorldSummary[] | null;
  progress: { stage: string; fraction: number; detail?: string | undefined; etaSeconds?: number | undefined; cancellable?: boolean | undefined };
  world: WorldInfoView | null;
  tick: number;
  speed: Speed;
  sim: SimStats | null;
  render: RenderStatsView | null;
  gpuAdapter: string;
  gpuSoftware: boolean;
  storage: StorageCheckView;
  layer: LayerView | null;
  minimap: MinimapView | null;
  /** Рамка обзора камеры на мини-карте, координаты мира. */
  footprint: [number, number][];
  cell: CellInfo | null;
  save: { state: 'idle' | 'saving' | 'saved' | 'error'; savedAt: string | null; auto: boolean; bytes: number };
  hudHidden: boolean;
  debugOpen: boolean;
  cameraMode: CameraModeView;
  quality: QualityName;
  /** Погода у точки обзора — из данных симуляции. */
  localWeather: { temperature: number; rate: number; cloud: number } | null;
}

const noop = () => {};

export const useUi = create<UiState>(() => ({
  screen: 'menu',
  fatal: null,
  notice: null,
  worlds: null,
  progress: { stage: '', fraction: 0 },
  world: null,
  tick: 0,
  speed: 1,
  sim: null,
  render: null,
  gpuAdapter: '',
  gpuSoftware: false,
  storage: { state: 'idle' },
  layer: null,
  minimap: null,
  footprint: [],
  cell: null,
  save: { state: 'idle', savedAt: null, auto: false, bytes: 0 },
  hudHidden: false,
  debugOpen: false,
  cameraMode: 'strategic',
  quality: 'medium',
  localWeather: null,
  dispatch: noop,
  refreshWorlds: noop,
  createWorld: noop,
  cancelCreate: noop,
  openWorld: noop,
  deleteWorld: noop,
  saveNow: noop,
  exitToMenu: noop,
  setLayer: noop,
  setCameraMode: noop,
  setQuality: noop,
  goTo: noop,
  closeCard: noop,
  runStorageCheck: noop,
}));
