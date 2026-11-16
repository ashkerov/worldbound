// Протокол «главный поток ↔ воркер симуляции» (ARCHITECTURE.md, раздел 4.2).
// Единственный контракт между симуляцией, рендером и UI.

import type { Speed } from './time';

// ───────── Команды: главный поток → симуляция ─────────

export type Command =
  | { type: 'setSpeed'; speed: Speed }
  | { type: 'spawnTestAgents'; count: number }
  | { type: 'clearTestAgents' };

export interface WorldInit {
  seed: number;
  /** Сторона мира в метрах. */
  worldSize: number;
  /** Число тестовых агентов на старте (фаза 0). */
  testAgents: number;
}

export type ToWorker =
  | { type: 'init'; init: WorldInit }
  | { type: 'command'; command: Command }
  | { type: 'recycle'; buffer: ArrayBuffer }
  | { type: 'request'; requestId: number; request: SimRequest };

export type SimRequest = { kind: 'stateHash' } | { kind: 'storageSelfTest' };

export type SimResponse =
  | { kind: 'stateHash'; tick: number; hash: string }
  | { kind: 'storageSelfTest'; ok: boolean; backend: string; detail: string };

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

export interface TerrainMessage {
  type: 'terrain';
  /** Число отсчётов по стороне. */
  samples: number;
  /** Шаг между отсчётами, м. */
  spacing: number;
  heights: ArrayBuffer;
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
  | { type: 'ready'; seed: number; worldSize: number }
  | TerrainMessage
  | FrameSnapshot
  | SimStats
  | { type: 'response'; requestId: number; response: SimResponse }
  | { type: 'error'; message: string };
