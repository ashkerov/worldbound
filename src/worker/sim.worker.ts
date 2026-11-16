/// <reference lib="webworker" />
// Точка входа воркера симуляции: реальное время → такты, снимки кадра,
// команды и запросы. Сама симуляция — в src/sim и о воркере не знает.

import type { FromWorker, SimRequest, SimResponse, ToWorker } from '../shared/protocol';
import { TICK_MS } from '../shared/time';
import { Simulation } from '../sim/core/simulation';
import { MemoryStorage } from '../platform/storage/memory';
import { OpfsStorage, isOpfsAvailable } from '../platform/storage/opfs';
import { storageSelfTest } from '../platform/storage/selfTest';
import type { StoragePort } from '../platform/storage/StoragePort';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

/** Интервал опроса цикла; такты выполняются по накопленному времени. */
const LOOP_INTERVAL_MS = 10;
/** Не больше стольких тактов за один проход цикла: если воркер отстал, время не «догоняется» рывком. */
const MAX_TICKS_PER_PASS = 16;
const STATS_INTERVAL_MS = 500;

let sim: Simulation | null = null;
let storage: StoragePort | null = null;
const bufferPool: ArrayBuffer[] = [];

let lastTime = 0;
let accumulator = 0;
let statsStart = 0;
let statsTicks = 0;
let statsTickMs = 0;
let statsTickMax = 0;
let statsDropped = 0;

function takeBuffer(byteLength: number): ArrayBuffer {
  for (let i = bufferPool.length - 1; i >= 0; i--) {
    const buffer = bufferPool[i]!;
    if (buffer.byteLength >= byteLength) {
      bufferPool.splice(i, 1);
      return buffer;
    }
  }
  // Запас, чтобы рост числа сущностей не вызывал выделение на каждом такте.
  return new ArrayBuffer(Math.max(4096, Math.ceil(byteLength * 1.5)));
}

function sendSnapshot(): void {
  if (!sim) return;
  const length = sim.snapshotLength();
  const buffer = takeBuffer(length * 4);
  const count = sim.writeSnapshot(new Float32Array(buffer));
  post({ type: 'snapshot', tick: sim.world.tick, count, buffer }, [buffer]);
}

function loop(): void {
  if (!sim) return;
  const now = performance.now();
  const elapsed = now - lastTime;
  lastTime = now;

  const speed = sim.world.speed;
  if (speed === 0) {
    // На паузе такты не идут, но команды (в том числе «снять паузу») применяются.
    accumulator = 0;
    sim.applyCommands();
  } else {
    accumulator += elapsed * speed;
    let ticks = 0;
    while (accumulator >= TICK_MS && ticks < MAX_TICKS_PER_PASS) {
      const start = performance.now();
      sim.step();
      const took = performance.now() - start;
      statsTickMs += took;
      if (took > statsTickMax) statsTickMax = took;
      statsTicks++;
      ticks++;
      accumulator -= TICK_MS;
      if (sim.world.speed !== speed) break;
    }
    if (accumulator >= TICK_MS) {
      const dropped = Math.floor(accumulator / TICK_MS);
      statsDropped += dropped;
      accumulator -= dropped * TICK_MS;
    }
    if (ticks > 0) sendSnapshot();
  }

  if (now - statsStart >= STATS_INTERVAL_MS) {
    const seconds = (now - statsStart) / 1000;
    post({
      type: 'stats',
      tick: sim.world.tick,
      speed: sim.world.speed,
      agents: sim.world.agents.count,
      tickMsAvg: statsTicks > 0 ? statsTickMs / statsTicks : 0,
      tickMsMax: statsTickMax,
      ticksPerSecond: statsTicks / seconds,
      droppedTicks: statsDropped,
    });
    // На паузе такты не идут, но состав сущностей мог измениться командой.
    if (speed === 0) sendSnapshot();
    statsStart = now;
    statsTicks = 0;
    statsTickMs = 0;
    statsTickMax = 0;
    statsDropped = 0;
  }
}

async function handleRequest(request: SimRequest): Promise<SimResponse> {
  switch (request.kind) {
    case 'stateHash':
      return { kind: 'stateHash', tick: sim?.world.tick ?? -1, hash: sim?.stateHash() ?? '' };
    case 'storageSelfTest': {
      storage ??= isOpfsAvailable() ? new OpfsStorage() : new MemoryStorage();
      return { kind: 'storageSelfTest', ...(await storageSelfTest(storage)) };
    }
  }
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init': {
        sim = new Simulation(message.init, () => performance.now());
        const terrain = sim.world.terrain;
        // Копия высот: оригинал остаётся авторитетным состоянием в воркере.
        const heights = terrain.heights.slice().buffer;
        post({ type: 'ready', seed: sim.world.seed, worldSize: sim.world.worldSize });
        post({ type: 'terrain', samples: terrain.samples, spacing: terrain.spacing, heights }, [heights]);
        sendSnapshot();
        lastTime = performance.now();
        statsStart = lastTime;
        setInterval(loop, LOOP_INTERVAL_MS);
        break;
      }
      case 'command':
        sim?.enqueue(message.command);
        break;
      case 'recycle':
        if (bufferPool.length < 8) bufferPool.push(message.buffer);
        break;
      case 'request': {
        const { requestId, request } = message;
        handleRequest(request).then(
          (response) => post({ type: 'response', requestId, response }),
          (error: unknown) => post({ type: 'error', message: String(error) }),
        );
        break;
      }
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
