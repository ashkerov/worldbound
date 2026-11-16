// Запуск и связывание: воркер симуляции ↔ рендер ↔ UI.
// Это единственное место, где три слоя знают друг о друге.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { FromWorker, LayerId } from '../shared/protocol';
import { seedFromString } from '../shared/rng';
import { normalizeConfig, type WorldSizeName } from '../shared/worldConfig';
import { detectGpu } from '../render/gpuInfo';
import { WorldView, type QualityName } from '../render/WorldView';
import { App } from '../ui/App';
import { useUi } from '../ui/store';
import { SimClient } from '../worker/client';
import './debugHandle';

const MAX_AGENTS = 16384;
const QUALITY_KEY = 'worldbound.quality';
let lastSpeedCommandAt = -Infinity;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fatal(error: unknown): void {
  console.error('[WORLDBOUND]', error);
  useUi.setState({ fatal: message(error) });
}

function readQuality(param: string | null): QualityName {
  const valid = (q: string | null): q is QualityName => q === 'low' || q === 'medium' || q === 'high';
  if (valid(param)) return param;
  try {
    const stored = localStorage.getItem(QUALITY_KEY);
    if (valid(stored)) return stored;
  } catch {
    // Хранилище браузера недоступно — используется значение по умолчанию.
  }
  return 'medium';
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const forceWebGL = params.get('renderer') === 'webgl2';
  const testAgents = Math.min(MAX_AGENTS, Math.max(0, Number(params.get('agents') ?? 0) || 0));
  const quality = readQuality(params.get('quality'));
  useUi.setState({ quality });

  createRoot(document.getElementById('ui')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const view = await WorldView.create(canvas, { forceWebGL, maxAgents: MAX_AGENTS, quality });
  if (params.get('renderer') === 'webgpu' && view.backend !== 'webgpu') console.warn('[WORLDBOUND] Запрошен WebGPU, но он недоступен — работает WebGL 2.');
  const gpu = await detectGpu(view.backend);
  useUi.setState({ gpuAdapter: gpu.adapter, gpuSoftware: gpu.software, debugOpen: params.get('debug') === '1' });

  let worldReady = false;
  let cellTimer: ReturnType<typeof setInterval> | null = null;
  let selected: { x: number; z: number } | null = null;

  const onMessage = (m: Exclude<FromWorker, { type: 'response' }>) => {
    switch (m.type) {
      case 'progress':
        useUi.setState({ progress: { stage: m.stage, fraction: m.fraction } });
        break;
      case 'worldStatic':
        view.setWorld(m);
        useUi.setState({ world: { id: m.worldId, config: m.config, worldSize: m.worldSize, provinces: m.provinces }, layer: null, cell: null });
        break;
      case 'surface':
        view.setSurface(m);
        break;
      case 'weather':
        view.setWeather(m);
        break;
      case 'layer': {
        const current = useUi.getState().layer;
        if (current?.id === m.layer) {
          view.setLayer(m);
          useUi.setState({ layer: { id: m.layer, legend: m.legend } });
        }
        break;
      }
      case 'minimap':
        useUi.setState({ minimap: { n: m.n, image: new Uint8ClampedArray(m.image), tick: m.tick } });
        break;
      case 'snapshot': {
        const released = view.pushSnapshot(m);
        if (released) client.recycle(released);
        break;
      }
      case 'stats': {
        // Пока команда смены скорости в пути, старая статистика не должна «откатить» кнопку.
        const settled = performance.now() - lastSpeedCommandAt > 700;
        useUi.setState(settled ? { sim: m, tick: m.tick, speed: m.speed } : { sim: m, tick: m.tick });
        break;
      }
      case 'saved':
        useUi.setState({ save: { state: 'saved', savedAt: m.savedAt, auto: m.auto, bytes: m.bytes } });
        break;
      case 'error':
        console.error('[WORLDBOUND] воркер:', m.message);
        useUi.setState({ notice: m.message });
        break;
    }
  };
  const client = new SimClient(onMessage);

  const refreshCell = () => {
    if (!selected) return;
    client.request({ kind: 'cellInfo', x: selected.x, z: selected.z }).then((r) => {
      if (selected) useUi.setState({ cell: r.info });
    }, fatal);
  };
  const closeCard = () => {
    selected = null;
    if (cellTimer) clearInterval(cellTimer);
    cellTimer = null;
    useUi.setState({ cell: null });
  };
  view.rig.onPick = (x, z) => {
    selected = { x, z };
    refreshCell();
    if (!cellTimer) cellTimer = setInterval(refreshCell, 250);
  };
  view.rig.onModeChange = (mode) => useUi.setState({ cameraMode: mode });
  view.onFrame = () => {
    if (!worldReady) return;
    const t = view.rig.target;
    const w = view.weatherAt(t.x, t.z);
    // Мини-карта и погода обновляются реже кадра: интерфейсу достаточно 5 раз в секунду.
    const now = performance.now();
    if (now - lastUiUpdate > 200) {
      lastUiUpdate = now;
      useUi.setState({ footprint: view.rig.footprint(), localWeather: w ? { temperature: w.temperature, rate: w.rate, cloud: w.cloud } : null });
    }
  };
  let lastUiUpdate = 0;

  const enterWorld = () => {
    worldReady = true;
    useUi.setState({ screen: 'world', notice: null, hudHidden: false, save: { state: 'saved', savedAt: new Date().toISOString(), auto: false, bytes: 0 } });
    if (window.__wb) window.__wb.ready = true;
  };

  const leaveWorld = () => {
    worldReady = false;
    closeCard();
    view.clearWorld();
    useUi.setState({ world: null, minimap: null, layer: null, screen: 'menu', tick: 0 });
    if (window.__wb) window.__wb.ready = false;
  };

  const actions = {
    dispatch: (command: Parameters<typeof client.send>[0]) => {
      if (command.type === 'setSpeed') {
        lastSpeedCommandAt = performance.now();
        useUi.setState({ speed: command.speed });
      }
      client.send(command);
    },
    refreshWorlds: () => {
      client.request({ kind: 'listWorlds' }).then(
        (r) => useUi.setState({ worlds: r.worlds }),
        (e: unknown) => useUi.setState({ worlds: [], notice: `Не удалось прочитать список миров: ${message(e)}` }),
      );
    },
    createWorld: (config: Parameters<typeof normalizeConfig>[0]) => {
      useUi.setState({ screen: 'progress', progress: { stage: 'Подготовка', fraction: 0 } });
      client.request({ kind: 'createWorld', config: normalizeConfig(config), testAgents }).then(enterWorld, (e: unknown) => {
        useUi.setState({ screen: 'menu', notice: `Не удалось создать мир: ${message(e)}` });
      });
    },
    openWorld: (id: string) => {
      useUi.setState({ screen: 'progress', progress: { stage: 'Загрузка мира', fraction: 0 } });
      client.request({ kind: 'loadWorld', worldId: id, testAgents }).then(enterWorld, (e: unknown) => {
        view.clearWorld();
        useUi.setState({ screen: 'menu', notice: `Не удалось открыть мир: ${message(e)}` });
      });
    },
    deleteWorld: (id: string) => {
      client.request({ kind: 'deleteWorld', worldId: id }).then(actions.refreshWorlds, (e: unknown) => useUi.setState({ notice: `Не удалось удалить мир: ${message(e)}` }));
    },
    saveNow: () => {
      useUi.setState((s) => ({ save: { ...s.save, state: 'saving' } }));
      client.request({ kind: 'saveWorld' }).catch((e: unknown) => useUi.setState((s) => ({ save: { ...s.save, state: 'error' }, notice: `Сохранение не удалось: ${message(e)}` })));
    },
    exitToMenu: () => {
      useUi.setState((s) => ({ save: { ...s.save, state: 'saving' } }));
      client.request({ kind: 'closeWorld', save: true }).then(
        () => {
          leaveWorld();
          actions.refreshWorlds();
        },
        (e: unknown) => useUi.setState((s) => ({ save: { ...s.save, state: 'error' }, notice: `Сохранение не удалось: ${message(e)}` })),
      );
    },
    setLayer: (layer: LayerId | null) => {
      useUi.setState({ layer: layer ? { id: layer, legend: useUi.getState().layer?.legend ?? [] } : null });
      if (!layer) view.setLayer(null);
      client.request({ kind: 'setLayer', layer }).catch(fatal);
    },
    setCameraMode: (mode: 'strategic' | 'free') => view.setCameraMode(mode),
    setQuality: (q: QualityName) => {
      view.setQuality(q);
      useUi.setState({ quality: q });
      try {
        localStorage.setItem(QUALITY_KEY, q);
      } catch {
        // Без сохранения настройки: применится только в этом сеансе.
      }
    },
    goTo: (x: number, z: number) => view.rig.goTo(x, z),
    closeCard,
    runStorageCheck: () => {
      useUi.setState({ storage: { state: 'running' } });
      client.request({ kind: 'storageSelfTest' }).then((r) => useUi.setState({ storage: { state: 'done', ok: r.ok, backend: r.backend, detail: r.detail } }), fatal);
    },
  };
  useUi.setState(actions);

  // Сворачивание вкладки: браузер может остановить её надолго — мир сохраняется заранее.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && worldReady) client.request({ kind: 'saveWorld' }).catch(() => undefined);
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
      return { tick: r.tick, hash: r.hash, geoHash: r.geoHash };
    },
    setView: (v) => view.setView(v),
    getView: () => view.rig.view(),
    worldSize: () => useUi.getState().world?.worldSize ?? 0,
    pick: (x, z) => view.rig.onPick?.(x, z),
  };

  setInterval(() => useUi.setState({ render: view.getStats() }), 500);

  // Быстрый старт для автоматических проверок и стендов: ?autostart=1&seed=…&size=S|M
  if (params.get('autostart') === '1') {
    const seedParam = params.get('seed') ?? 'worldbound';
    const seed = /^\d+$/.test(seedParam) ? Number(seedParam) >>> 0 : seedFromString(seedParam);
    const size = (params.get('size') === 'S' ? 'S' : 'M') as WorldSizeName;
    const days = Number(params.get('season') ?? 5);
    actions.createWorld({ name: `Проверка ${seedParam}`, seed, size, daysPerSeason: days, climate: (params.get('climate') as 'temperate') ?? 'temperate' });
  }
}

start().catch(fatal);
