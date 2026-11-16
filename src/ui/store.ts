// Состояние интерфейса. UI не обращается к симуляции напрямую: данные приходят
// сюда из моста, команды уходят через `dispatch`, который подставляет app.

import { create } from 'zustand';
import type { Command, SimStats } from '../shared/protocol';
import type { Speed } from '../shared/time';

/** Показатели рендера в виде, нужном интерфейсу (без зависимости от модуля render). */
export interface RenderStatsView {
  backend: 'webgpu' | 'webgl2';
  fps: number;
  frameMsAvg: number;
  frameMsMax: number;
  drawCalls: number;
  triangles: number;
  agentsDrawn: number;
}

export interface StorageCheckView {
  state: 'idle' | 'running' | 'done';
  ok?: boolean;
  backend?: string;
  detail?: string;
}

export interface UiState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  seed: number;
  worldSize: number;
  tick: number;
  speed: Speed;
  sim: SimStats | null;
  render: RenderStatsView | null;
  gpuAdapter: string;
  gpuSoftware: boolean;
  storage: StorageCheckView;
  dispatch: (command: Command) => void;
  runStorageCheck: () => void;
}

export const useUi = create<UiState>(() => ({
  status: 'loading',
  error: null,
  seed: 0,
  worldSize: 0,
  tick: 0,
  speed: 1,
  sim: null,
  render: null,
  gpuAdapter: '',
  gpuSoftware: false,
  storage: { state: 'idle' },
  dispatch: () => {},
  runStorageCheck: () => {},
}));
