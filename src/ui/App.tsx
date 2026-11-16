import { calendarFromTick, SEASON_NAMES, SPEEDS, type Speed } from '../shared/time';
import { useUi } from './store';
import './ui.css';

const pad = (n: number) => String(n).padStart(2, '0');

function TimePanel() {
  const tick = useUi((s) => s.tick);
  const speed = useUi((s) => s.speed);
  const dispatch = useUi((s) => s.dispatch);
  const cal = calendarFromTick(tick);
  const setSpeed = (value: Speed) => dispatch({ type: 'setSpeed', speed: value });
  return (
    <div className="wb-panel wb-time" data-testid="time-panel">
      <span className="wb-date" data-testid="date">
        Год {cal.year} · {SEASON_NAMES[cal.season]} · День {cal.dayOfSeason} · {pad(cal.hour)}:{pad(cal.minute)}
      </span>
      <span className="wb-speeds">
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            className={value === speed ? 'wb-btn wb-btn-active' : 'wb-btn'}
            aria-pressed={value === speed}
            data-testid={`speed-${value}`}
            title={value === 0 ? 'Пауза' : `Скорость ×${value}`}
            onClick={() => setSpeed(value)}
          >
            {value === 0 ? '❚❚' : `×${value}`}
          </button>
        ))}
      </span>
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="wb-row">
      <span>{label}</span>
      <span data-testid={testId}>{value}</span>
    </div>
  );
}

function DebugPanel() {
  const sim = useUi((s) => s.sim);
  const render = useUi((s) => s.render);
  const seed = useUi((s) => s.seed);
  const gpuAdapter = useUi((s) => s.gpuAdapter);
  const gpuSoftware = useUi((s) => s.gpuSoftware);
  const storage = useUi((s) => s.storage);
  const dispatch = useUi((s) => s.dispatch);
  const runStorageCheck = useUi((s) => s.runStorageCheck);
  return (
    <div className="wb-panel wb-debug" data-testid="debug-panel">
      <div className="wb-title">Отладка · фаза 0</div>
      <Row label="Графика" value={render ? (render.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2') : '—'} testId="backend" />
      <div className={gpuSoftware ? 'wb-note wb-fail' : 'wb-note wb-adapter'} data-testid="gpu" title={gpuAdapter}>
        {gpuSoftware ? 'Программная отрисовка: ' : ''}
        {gpuAdapter || '—'}
      </div>
      <Row label="Кадров/с" value={render ? render.fps.toFixed(0) : '—'} testId="fps" />
      <Row label="Кадр, мс (ср. / макс.)" value={render ? `${render.frameMsAvg.toFixed(1)} / ${render.frameMsMax.toFixed(1)}` : '—'} />
      <Row label="Вызовы отрисовки" value={render ? String(render.drawCalls) : '—'} />
      <Row label="Треугольники" value={render ? render.triangles.toLocaleString('ru-RU') : '—'} />
      <div className="wb-sep" />
      <Row label="Такт" value={sim ? String(sim.tick) : '—'} testId="tick" />
      <Row label="Тактов/с" value={sim ? sim.ticksPerSecond.toFixed(1) : '—'} testId="tps" />
      <Row label="Такт, мс (ср. / макс.)" value={sim ? `${sim.tickMsAvg.toFixed(3)} / ${sim.tickMsMax.toFixed(2)}` : '—'} />
      <Row label="Пропущено тактов" value={sim ? String(sim.droppedTicks) : '—'} />
      <Row label="Тестовых агентов" value={sim ? String(sim.agents) : '—'} testId="agents" />
      <Row label="Seed" value={String(seed)} />
      <div className="wb-actions">
        <button type="button" className="wb-btn" data-testid="spawn" onClick={() => dispatch({ type: 'spawnTestAgents', count: 1000 })}>
          +1000 агентов
        </button>
        <button type="button" className="wb-btn" data-testid="clear" onClick={() => dispatch({ type: 'clearTestAgents' })}>
          Очистить
        </button>
      </div>
      <div className="wb-sep" />
      <div className="wb-actions">
        <button type="button" className="wb-btn" data-testid="storage-check" disabled={storage.state === 'running'} onClick={runStorageCheck}>
          Проверить хранилище
        </button>
      </div>
      {storage.state === 'done' && (
        <div className={storage.ok ? 'wb-note wb-ok' : 'wb-note wb-fail'} data-testid="storage-result">
          {storage.backend}: {storage.ok ? 'исправно' : 'ошибка'} — {storage.detail}
        </div>
      )}
    </div>
  );
}

export function App() {
  const status = useUi((s) => s.status);
  const error = useUi((s) => s.error);
  if (status === 'error') {
    return (
      <div className="wb-panel wb-center" data-testid="fatal">
        <div className="wb-title">Не удалось запустить WORLDBOUND</div>
        <div>{error}</div>
      </div>
    );
  }
  if (status === 'loading') {
    return (
      <div className="wb-panel wb-center" data-testid="loading">
        Создание мира…
      </div>
    );
  }
  return (
    <>
      <TimePanel />
      <DebugPanel />
    </>
  );
}
