/// <reference lib="webworker" />
// Точка входа воркера симуляции: жизненный цикл мира (создание, загрузка, сохранение),
// реальное время → такты, снимки кадра и представления для рендера и UI, команды и запросы.
// Сама симуляция — в src/sim и о воркере не знает.

import type { FromWorker, LayerId, SimRequest, SimResponse, ToWorker } from '../shared/protocol';
import { SEASONS_PER_YEAR, TICK_MS, TICKS_PER_DAY, TICKS_PER_HOUR } from '../shared/time';
import { normalizeConfig } from '../shared/worldConfig';
import { Simulation } from '../sim/core/simulation';
import { WEATHER_PERIOD, windAt } from '../sim/env/weather';
import { DYNAMIC_LAYERS, buildStatic, buildSurface, cellInfo, chunkTemperatures, hillshade, layerImage, minimapImage } from '../sim/view/views';
import { MemoryStorage } from '../platform/storage/memory';
import { OpfsStorage, isOpfsAvailable } from '../platform/storage/opfs';
import { storageSelfTest } from '../platform/storage/selfTest';
import type { StoragePort } from '../platform/storage/StoragePort';
import { WorldStore, newWorldId } from './worldStore';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

/** Интервал опроса цикла; такты выполняются по накопленному времени. */
const LOOP_INTERVAL_MS = 10;
/** Не больше стольких тактов за один проход цикла: если воркер отстал, время не «догоняется» рывком. */
const MAX_TICKS_PER_PASS = 16;
const STATS_INTERVAL_MS = 500;
/** Автосохранение по реальному времени. */
const AUTOSAVE_MS = 120_000;

let sim: Simulation | null = null;
let meta: { id: string; createdAt: string } | null = null;
let shade: Float32Array | null = null;
let layer: LayerId | null = null;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let storage: StoragePort | null = null;
let store: WorldStore | null = null;
let saving: Promise<unknown> = Promise.resolve();
let lastSaveAt = 0;
let dirty = false;
const bufferPool: ArrayBuffer[] = [];

let lastTime = 0;
let accumulator = 0;
let statsStart = 0;
let statsTicks = 0;
let statsTickMs = 0;
let statsTickMax = 0;
let statsDropped = 0;

function getStore(): WorldStore {
  storage ??= isOpfsAvailable() ? new OpfsStorage() : new MemoryStorage();
  store ??= new WorldStore(storage);
  return store;
}

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

function sendSurface(): void {
  if (!sim) return;
  const data = buildSurface(sim.world).buffer as ArrayBuffer;
  post({ type: 'surface', tick: sim.world.tick, n: sim.world.geo.n, data }, [data]);
  shade ??= hillshade(sim.world);
  const image = minimapImage(sim.world, shade).buffer as ArrayBuffer;
  post({ type: 'minimap', tick: sim.world.tick, n: sim.world.geo.n, image }, [image]);
}

function sendWeather(): void {
  if (!sim) return;
  const w = sim.world.env.weather;
  const wind = windAt(sim.world, sim.world.tick);
  const rate = w.chunkRate.slice().buffer as ArrayBuffer;
  const cloud = w.chunkCloud.slice().buffer as ArrayBuffer;
  const temperature = chunkTemperatures(sim.world).buffer as ArrayBuffer;
  post({ type: 'weather', tick: sim.world.tick, chunks: w.chunks, rate, cloud, temperature, windX: wind.x, windZ: wind.z, windSpeed: wind.speed }, [rate, cloud, temperature]);
}

function sendLayer(): void {
  if (!sim || !layer) return;
  const { image, legend } = layerImage(sim.world, layer);
  const buffer = image.buffer as ArrayBuffer;
  post({ type: 'layer', layer, tick: sim.world.tick, n: sim.world.geo.n, image: buffer, legend }, [buffer]);
}

async function save(auto: boolean): Promise<{ savedAt: string; bytes: number; ms: number }> {
  if (!sim || !meta) throw new Error('Мир не открыт');
  const current = sim;
  const m = meta;
  const run = async () => {
    const start = performance.now();
    const result = await getStore().save(current, m, new Date());
    lastSaveAt = performance.now();
    dirty = false;
    post({ type: 'saved', worldId: m.id, savedAt: result.savedAt, auto, bytes: result.bytes });
    return { savedAt: result.savedAt, bytes: result.bytes, ms: performance.now() - start };
  };
  // Сохранения выполняются по очереди: два одновременных не пишут одно поколение.
  const next = saving.then(run, run);
  saving = next.catch(() => undefined);
  return next;
}

function loop(): void {
  if (!sim) return;
  const now = performance.now();
  const elapsed = now - lastTime;
  lastTime = now;

  const world = sim.world;
  const speed = world.speed;
  if (speed === 0) {
    // На паузе такты не идут, но команды (в том числе «снять паузу») применяются.
    accumulator = 0;
    sim.applyCommands();
  } else {
    accumulator += elapsed * speed;
    let ticks = 0;
    let weatherStep = false;
    let hourStep = false;
    while (accumulator >= TICK_MS && ticks < MAX_TICKS_PER_PASS) {
      const tick = world.tick;
      if (tick % WEATHER_PERIOD === 0) weatherStep = true;
      if (tick % TICKS_PER_HOUR === 0) hourStep = true;
      const start = performance.now();
      sim.step();
      const took = performance.now() - start;
      statsTickMs += took;
      if (took > statsTickMax) statsTickMax = took;
      statsTicks++;
      ticks++;
      accumulator -= TICK_MS;
      if (world.speed !== speed) break;
    }
    if (accumulator >= TICK_MS) {
      const dropped = Math.floor(accumulator / TICK_MS);
      statsDropped += dropped;
      accumulator -= dropped * TICK_MS;
    }
    if (ticks > 0) {
      dirty = true;
      sendSnapshot();
      if (weatherStep) sendWeather();
      if (hourStep) {
        sendSurface();
        if (layer && DYNAMIC_LAYERS.includes(layer)) sendLayer();
      }
    }
  }

  if (now - statsStart >= STATS_INTERVAL_MS) {
    const seconds = (now - statsStart) / 1000;
    post({
      type: 'stats',
      tick: world.tick,
      speed: world.speed,
      agents: world.agents.count,
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

  if (dirty && now - lastSaveAt >= AUTOSAVE_MS) {
    lastSaveAt = now;
    save(true).catch((error: unknown) => post({ type: 'error', message: `Автосохранение не удалось: ${String(error)}` }));
  }
}

function open(next: Simulation, worldId: string, createdAt: string): void {
  sim = next;
  meta = { id: worldId, createdAt };
  shade = null;
  const { message, transfer } = buildStatic(next.world, worldId);
  post(message, transfer);
  sendWeather();
  sendSurface();
  sendLayer();
  sendSnapshot();
  lastTime = performance.now();
  statsStart = lastTime;
  lastSaveAt = lastTime;
  accumulator = 0;
  dirty = false;
  loopTimer ??= setInterval(loop, LOOP_INTERVAL_MS);
}

function close(): void {
  sim = null;
  meta = null;
  shade = null;
}

const progress = (stage: string, fraction: number) => post({ type: 'progress', stage, fraction });

/** Отмена создания мира (подготовки Wildlands) запросом cancelCreate. */
let cancelRequested = false;
let preparing = false;
/** Подготовка идёт порциями не дольше этого, мс: между порциями воркер принимает сообщения (отмена). */
const PREPARE_SLICE_MS = 60;

const yieldToMessages = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Подготовка Wildlands: обычные такты той же симуляции, порциями, с честным прогрессом
 * (доля выполненных тактов, текущий год, число растений, оценка оставшегося времени по фактической скорости).
 */
async function prepare(next: Simulation): Promise<void> {
  const p = next.preparation;
  if (!p) return;
  preparing = true;
  cancelRequested = false;
  try {
    const ticksPerYear = next.world.config.daysPerSeason * SEASONS_PER_YEAR * TICKS_PER_DAY;
    const started = performance.now();
    while (next.preparation) {
      if (cancelRequested) throw new Error('создание отменено');
      const sliceStart = performance.now();
      while (next.preparation && performance.now() - sliceStart < PREPARE_SLICE_MS) next.advancePreparation(TICKS_PER_HOUR / 6);
      const fraction = next.preparationFraction();
      const elapsed = (performance.now() - started) / 1000;
      const year = Math.min(p.years, Math.floor((next.world.tick - p.startTick) / ticksPerYear) + 1);
      post({
        type: 'progress',
        stage: `Природа развивается: год ${year} из ${p.years}`,
        fraction,
        detail: `Деревьев и кустарников: ${next.world.flora.woody.count.toLocaleString('ru-RU')}`,
        etaSeconds: fraction > 0.01 ? (elapsed * (1 - fraction)) / fraction : undefined,
        cancellable: true,
      });
      await yieldToMessages();
    }
  } finally {
    preparing = false;
  }
}

async function handleRequest(request: SimRequest): Promise<SimResponse> {
  switch (request.kind) {
    case 'listWorlds':
      return { kind: 'listWorlds', worlds: await getStore().list() };
    case 'createWorld': {
      if (sim && meta) await save(true).catch(() => undefined);
      close();
      const config = normalizeConfig(request.config);
      const next = new Simulation({ config, testAgents: request.testAgents, prepareYears: request.prepareYears }, () => performance.now(), undefined, progress);
      // Wildlands: мир готовится прогоном симуляции; сохраняется и открывается только готовый мир.
      await prepare(next);
      const nowDate = new Date();
      const worldId = newWorldId(config.seed, nowDate.getTime());
      sim = next;
      meta = { id: worldId, createdAt: nowDate.toISOString() };
      await save(false);
      open(next, worldId, meta.createdAt);
      return { kind: 'createWorld', worldId };
    }
    case 'loadWorld': {
      if (sim && meta) await save(true).catch(() => undefined);
      close();
      const { sim: next, manifest } = await getStore().load(request.worldId, request.testAgents ?? 0, () => performance.now(), progress);
      open(next, manifest.id, manifest.createdAt);
      return { kind: 'loadWorld', worldId: manifest.id };
    }
    case 'cancelCreate':
      cancelRequested = preparing;
      return { kind: 'cancelCreate', cancelled: preparing };
    case 'saveWorld':
      return { kind: 'saveWorld', ...(await save(false)) };
    case 'closeWorld':
      if (request.save && sim) await save(false);
      close();
      return { kind: 'closeWorld' };
    case 'deleteWorld':
      if (meta?.id === request.worldId) close();
      return { kind: 'deleteWorld', removed: await getStore().remove(request.worldId) };
    case 'cellInfo':
      return { kind: 'cellInfo', info: sim ? cellInfo(sim.world, request.x, request.z) : null };
    case 'setLayer':
      layer = request.layer;
      sendLayer();
      return { kind: 'setLayer' };
    case 'stateHash':
      return { kind: 'stateHash', tick: sim?.world.tick ?? -1, hash: sim?.stateHash() ?? '', geoHash: sim?.world.geoHash ?? '' };
    case 'storageSelfTest': {
      getStore();
      return { kind: 'storageSelfTest', ...(await storageSelfTest(storage!)) };
    }
  }
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
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
          (error: unknown) => post({ type: 'response', requestId, response: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } }),
        );
        break;
      }
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
