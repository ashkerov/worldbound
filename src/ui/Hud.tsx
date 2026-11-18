// Интерфейс в мире: время, мини-карта, слои, карточка ячейки, сохранение, камера, отладка.
// Все значения — из данных симуляции; элементы без работающей функции не показываются.

import { useEffect, useRef } from 'react';
import { LAYERS, LAYER_LABELS } from '../shared/protocol';
import { calendarFromTick, SEASON_NAMES, SPEEDS, type Speed } from '../shared/time';
import { useUi } from './store';

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (v: number, digits = 1) => v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function TimePanel() {
  const tick = useUi((s) => s.tick);
  const speed = useUi((s) => s.speed);
  const world = useUi((s) => s.world);
  const weather = useUi((s) => s.localWeather);
  const dispatch = useUi((s) => s.dispatch);
  const cal = calendarFromTick(tick, world?.config.daysPerSeason);
  const setSpeed = (value: Speed) => dispatch({ type: 'setSpeed', speed: value });
  return (
    <div className="wb-panel wb-time" data-testid="time-panel">
      <span className="wb-date" data-testid="date">
        Год {cal.year} · {SEASON_NAMES[cal.season]} · День {cal.dayOfSeason} · {pad(cal.hour)}:{pad(cal.minute)}
      </span>
      {weather && (
        <span className="wb-weather" data-testid="local-weather" title="Погода в точке обзора">
          {fmt(weather.temperature, 0)} °C · {weather.rate > 0.05 ? (weather.temperature < 0.5 ? 'снег' : 'дождь') : weather.cloud > 0.55 ? 'пасмурно' : weather.cloud > 0.3 ? 'облачно' : 'ясно'}
        </span>
      )}
      <span className="wb-speeds">
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            className={value === speed ? 'wb-btn wb-btn-active' : 'wb-btn'}
            aria-pressed={value === speed}
            data-testid={`speed-${value}`}
            title={value === 0 ? 'Пауза (пробел)' : `Скорость ×${value}`}
            onClick={() => setSpeed(value)}
          >
            {value === 0 ? '❚❚' : `×${value}`}
          </button>
        ))}
      </span>
    </div>
  );
}

function Minimap() {
  const minimap = useUi((s) => s.minimap);
  const footprint = useUi((s) => s.footprint);
  const world = useUi((s) => s.world);
  const goTo = useUi((s) => s.goTo);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const SIZE = 200;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !minimap) return;
    const ctx = canvas.getContext('2d')!;
    const image = new ImageData(new Uint8ClampedArray(minimap.image), minimap.n, minimap.n);
    const off = new OffscreenCanvas(minimap.n, minimap.n);
    off.getContext('2d')!.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(off, 0, 0, SIZE, SIZE);
    if (world && footprint.length === 4) {
      const k = SIZE / world.worldSize;
      ctx.strokeStyle = 'rgba(255, 244, 210, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      footprint.forEach(([x, z], i) => (i === 0 ? ctx.moveTo(x * k, z * k) : ctx.lineTo(x * k, z * k)));
      ctx.closePath();
      ctx.stroke();
    }
  }, [minimap, footprint, world]);
  if (!world) return null;
  return (
    <div className="wb-panel wb-minimap" data-testid="minimap">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        title="Щелчок — перелёт камеры. Север сверху."
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          goTo(((e.clientX - rect.left) / rect.width) * world.worldSize, ((e.clientY - rect.top) / rect.height) * world.worldSize);
        }}
      />
      <div className="wb-minimap-caption">{world.config.name}</div>
    </div>
  );
}

function LayersPanel() {
  const layer = useUi((s) => s.layer);
  const setLayer = useUi((s) => s.setLayer);
  return (
    <div className="wb-panel wb-layers" data-testid="layers">
      <div className="wb-title">Слои</div>
      <button type="button" className={layer === null ? 'wb-btn wb-btn-active' : 'wb-btn'} data-testid="layer-none" onClick={() => setLayer(null)}>
        Мир
      </button>
      {LAYERS.map((id) => (
        <button key={id} type="button" className={layer?.id === id ? 'wb-btn wb-btn-active' : 'wb-btn'} data-testid={`layer-${id}`} onClick={() => setLayer(id)}>
          {LAYER_LABELS[id]}
        </button>
      ))}
      {layer && layer.id !== 'provinces' && (
        <div className="wb-legend" data-testid="legend">
          {layer.legend.map((e) => (
            <div key={e.label} className="wb-legend-row">
              <span className="wb-swatch" style={{ background: e.color }} />
              {e.label}
            </div>
          ))}
        </div>
      )}
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

function CellCard() {
  const cell = useUi((s) => s.cell);
  const closeCard = useUi((s) => s.closeCard);
  if (!cell) return null;
  const water = cell.water !== 'Суша';
  return (
    <div className="wb-panel wb-card" data-testid="cell-card">
      <div className="wb-card-head">
        <div>
          <div className="wb-title">{cell.province}</div>
          <div className="wb-muted">
            {Math.round(cell.x)} × {Math.round(cell.z)} м · {cell.water}
          </div>
        </div>
        <button type="button" className="wb-btn" onClick={closeCard} title="Закрыть">
          ✕
        </button>
      </div>
      <Row label="Высота" value={`${fmt(cell.height)} м`} testId="cell-height" />
      <Row label="Уклон" value={`${fmt(cell.slopeDeg, 0)}°`} />
      {water && <Row label="Глубина" value={`${fmt(cell.waterDepth)} м`} />}
      {(cell.water === 'Река' || cell.water === 'Озеро' || cell.dischargeNow > 0.05) && <Row label="Расход сейчас / норма" value={`${fmt(cell.dischargeNow, 2)} / ${fmt(cell.dischargeMean, 2)} м³/с`} testId="cell-discharge" />}
      <div className="wb-sep" />
      <Row label="Температура" value={`${fmt(cell.temperature)} °C`} testId="cell-temperature" />
      <Row label="Норма: год / лето / зима" value={`${fmt(cell.tMean, 0)} / ${fmt(cell.tSummer, 0)} / ${fmt(cell.tWinter, 0)} °C`} />
      <Row label="Осадки сейчас" value={cell.precipType === 'нет' ? 'нет' : `${cell.precipType}, ${fmt(cell.precipNow)} мм/ч`} testId="cell-precip" />
      <Row label="Осадки за год (норма)" value={`${Math.round(cell.precipYear)} мм`} />
      <Row label="Облачность / свет" value={`${Math.round(cell.cloud * 100)} % / ${Math.round(cell.light * 100)} %`} />
      <Row label="Ветер" value={`${cell.windFrom}, ${fmt(cell.windSpeed)} м/с`} />
      {!water && (
        <>
          <div className="wb-sep" />
          <Row label="Почва" value={cell.soil} testId="cell-soil" />
          <Row label="Плодородие" value={`${Math.round(cell.fertility * 100)} %`} />
          <Row label="Влага почвы" value={`${Math.round(cell.moistureMm)} мм (${Math.round(cell.moistureRel * 100)} %)`} testId="cell-moisture" />
          <Row label="Снег" value={cell.snowMm > 0.5 ? `${Math.round(cell.snowMm * 0.3)} см (${Math.round(cell.snowMm)} мм воды)` : 'нет'} testId="cell-snow" />
          <Row label="Биом" value={cell.biome} testId="cell-biome" />
          <Row label="Травы" value={cell.herbBiomass > 0.5 ? `${Math.round(cell.herbBiomass)} г/м² · ${cell.herbMain}` : 'нет'} testId="cell-herbs" />
          <Row label="Деревья и кустарники" value={cell.woodyPlants > 0 ? `${cell.woodyPlants} шт. · кроны ${Math.round(cell.treeCover * 100)} % / ${Math.round(cell.shrubCover * 100)} %` : 'нет'} testId="cell-woody" />
          <Row label="Индекс зелени" value={`${Math.round(cell.greenness * 100)} %`} />
          {cell.deposit !== '—' && <Row label="Залежь" value={`${cell.deposit}, ${Math.round(cell.depositRichness * 100)} %`} />}
        </>
      )}
    </div>
  );
}

function TopBar() {
  const save = useUi((s) => s.save);
  const saveNow = useUi((s) => s.saveNow);
  const exitToMenu = useUi((s) => s.exitToMenu);
  const cameraMode = useUi((s) => s.cameraMode);
  const setCameraMode = useUi((s) => s.setCameraMode);
  const quality = useUi((s) => s.quality);
  const setQuality = useUi((s) => s.setQuality);
  const status =
    save.state === 'saving'
      ? 'Сохранение…'
      : save.state === 'error'
        ? 'Ошибка сохранения'
        : save.savedAt
          ? `${save.auto ? 'Автосохранение' : 'Сохранено'} ${new Date(save.savedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
          : '';
  return (
    <div className="wb-panel wb-topbar" data-testid="top-bar">
      <button type="button" className="wb-btn" data-testid="exit-menu" onClick={exitToMenu} title="Сохранить и выйти в главное меню">
        ☰ Меню
      </button>
      <button type="button" className="wb-btn" data-testid="save-now" disabled={save.state === 'saving'} onClick={saveNow} title="Сохранить мир">
        Сохранить
      </button>
      <span className={save.state === 'error' ? 'wb-fail' : 'wb-muted'} data-testid="save-status">
        {status}
      </span>
      <span className="wb-spacer" />
      <button type="button" className="wb-btn" data-testid="camera-mode" onClick={() => setCameraMode(cameraMode === 'strategic' ? 'free' : 'strategic')} title="Смена камеры (Tab)">
        {cameraMode === 'strategic' ? 'Камера: обзор' : 'Камера: свободная'}
      </button>
      <select className="wb-select" data-testid="quality" value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)} title="Качество графики">
        <option value="low">Графика: низкая</option>
        <option value="medium">Графика: средняя</option>
        <option value="high">Графика: высокая</option>
      </select>
      <button type="button" className="wb-btn" title="Скрыть интерфейс (H)" onClick={() => useUi.setState({ hudHidden: true })}>
        Скрыть
      </button>
    </div>
  );
}

function DebugPanel() {
  const sim = useUi((s) => s.sim);
  const render = useUi((s) => s.render);
  const world = useUi((s) => s.world);
  const gpuAdapter = useUi((s) => s.gpuAdapter);
  const gpuSoftware = useUi((s) => s.gpuSoftware);
  const storage = useUi((s) => s.storage);
  const dispatch = useUi((s) => s.dispatch);
  const runStorageCheck = useUi((s) => s.runStorageCheck);
  return (
    <div className="wb-panel wb-debug" data-testid="debug-panel">
      <div className="wb-title">Отладка (F3)</div>
      <Row label="Графика" value={render ? (render.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2') : '—'} testId="backend" />
      <div className={gpuSoftware ? 'wb-note wb-fail' : 'wb-note wb-adapter'} data-testid="gpu" title={gpuAdapter}>
        {gpuSoftware ? 'Программная отрисовка: ' : ''}
        {gpuAdapter || '—'}
      </div>
      <Row label="Кадров/с" value={render ? render.fps.toFixed(0) : '—'} testId="fps" />
      <Row label="Кадр, мс (ср. / макс.)" value={render ? `${render.frameMsAvg.toFixed(1)} / ${render.frameMsMax.toFixed(1)}` : '—'} />
      <Row label="Разрешение" value={render?.resolution ?? '—'} />
      <Row label="Вызовы / треугольники" value={render ? `${render.drawCalls} / ${render.triangles.toLocaleString('ru-RU')}` : '—'} />
      <Row label="Узлов рельефа" value={render ? String(render.terrainNodes) : '—'} />
      <div className="wb-sep" />
      <Row label="Такт" value={sim ? String(sim.tick) : '—'} testId="tick" />
      <Row label="Тактов/с" value={sim ? sim.ticksPerSecond.toFixed(1) : '—'} testId="tps" />
      <Row label="Такт, мс (ср. / макс.)" value={sim ? `${sim.tickMsAvg.toFixed(3)} / ${sim.tickMsMax.toFixed(2)}` : '—'} />
      <Row label="Пропущено тактов" value={sim ? String(sim.droppedTicks) : '—'} />
      <Row label="Тестовых агентов" value={sim ? String(sim.agents) : '—'} testId="agents" />
      <Row label="Seed" value={world ? String(world.config.seed) : '—'} />
      <div className="wb-actions">
        <button type="button" className="wb-btn" data-testid="spawn" onClick={() => dispatch({ type: 'spawnTestAgents', count: 1000 })}>
          +1000 агентов
        </button>
        <button type="button" className="wb-btn" data-testid="clear" onClick={() => dispatch({ type: 'clearTestAgents' })}>
          Очистить
        </button>
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

export function Hud() {
  const hidden = useUi((s) => s.hudHidden);
  const debugOpen = useUi((s) => s.debugOpen);
  if (hidden) {
    return (
      <div className="wb-hint" data-testid="hud-hidden">
        H — показать интерфейс
      </div>
    );
  }
  return (
    <>
      <TopBar />
      <TimePanel />
      <Minimap />
      <LayersPanel />
      <CellCard />
      {debugOpen && <DebugPanel />}
    </>
  );
}
