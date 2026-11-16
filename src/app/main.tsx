// Запуск и связывание: воркер симуляции ↔ рендер ↔ UI.
// Это единственное место, где три слоя знают друг о друге.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { seedFromString } from '../shared/rng';
import { detectGpu } from '../render/gpuInfo';
import { WorldView } from '../render/WorldView';
import { App } from '../ui/App';
import { useUi } from '../ui/store';
import { SimClient } from '../worker/client';
import './debugHandle';

const MAX_AGENTS = 16384;
let lastSpeedCommandAt = -Infinity;

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[WORLDBOUND]', error);
  useUi.setState({ status: 'error', error: message });
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const seedParam = params.get('seed') ?? 'worldbound';
  const seed = /^\d+$/.test(seedParam) ? Number(seedParam) >>> 0 : seedFromString(seedParam);
  const testAgents = Math.min(MAX_AGENTS, Math.max(0, Number(params.get('agents') ?? 300) || 0));
  const forceWebGL = params.get('renderer') === 'webgl2';

  createRoot(document.getElementById('ui')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const view = await WorldView.create(canvas, { forceWebGL, maxAgents: MAX_AGENTS });

  if (params.get('renderer') === 'webgpu' && view.backend !== 'webgpu') {
    console.warn('[WORLDBOUND] Запрошен WebGPU, но он недоступен — работает WebGL 2.');
  }

  const gpu = await detectGpu(view.backend);
  useUi.setState({ gpuAdapter: gpu.adapter, gpuSoftware: gpu.software });

  const client = new SimClient({
    onReady: (readySeed, worldSize) => useUi.setState({ seed: readySeed, worldSize }),
    onTerrain: (terrain) => {
      view.setTerrain(terrain);
      useUi.setState({ status: 'ready' });
      if (window.__wb) window.__wb.ready = true;
    },
    onSnapshot: (snapshot) => {
      const released = view.pushSnapshot(snapshot);
      if (released) client.recycle(released);
    },
    onStats: (stats) => {
      // Пока команда смены скорости в пути, старая статистика не должна «откатить» кнопку.
      const settled = performance.now() - lastSpeedCommandAt > 700;
      useUi.setState(settled ? { sim: stats, tick: stats.tick, speed: stats.speed } : { sim: stats, tick: stats.tick });
    },
    onError: fail,
  });

  useUi.setState({
    dispatch: (command) => {
      // Скорость отражаем в UI сразу; подтверждение придёт со статистикой воркера.
      if (command.type === 'setSpeed') {
        lastSpeedCommandAt = performance.now();
        useUi.setState({ speed: command.speed });
      }
      client.send(command);
    },
    runStorageCheck: () => {
      useUi.setState({ storage: { state: 'running' } });
      client.request({ kind: 'storageSelfTest' }).then(
        (r) => useUi.setState({ storage: { state: 'done', ok: r.ok, backend: r.backend, detail: r.detail } }),
        fail,
      );
    },
  });

  window.__wb = {
    ready: false,
    backend: view.backend,
    gpu,
    getTick: () => useUi.getState().tick,
    getStats: () => ({ sim: useUi.getState().sim, render: view.getStats() }),
    sampleAgents: (limit) => view.sampleAgentPositions(limit),
    stateHash: async () => {
      const r = await client.request({ kind: 'stateHash' });
      return { tick: r.tick, hash: r.hash };
    },
  };

  setInterval(() => useUi.setState({ render: view.getStats() }), 500);

  client.init({ seed, worldSize: 512, testAgents });
}

start().catch(fail);
