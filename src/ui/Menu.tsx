// Главное меню, создание мира, экран генерации. Каждый элемент вызывает реальную операцию воркера.

import { useEffect, useState } from 'react';
import { calendarFromTick, SEASON_LENGTHS, SEASON_NAMES } from '../shared/time';
import { CLIMATES, CLIMATE_LABELS, DEFAULT_CONFIG, SCENARIOS, SCENARIO_LABELS, WILDLANDS_YEARS, type ClimateName, type ScenarioName, type WorldConfig, type WorldSizeName } from '../shared/worldConfig';
import { seedFromString } from '../shared/rng';
import { useUi } from './store';

const SIZE_LABELS: Record<WorldSizeName, string> = { S: 'Малый · 2 × 2 км', M: 'Средний · 4 × 4 км' };

function formatBytes(bytes: number): string {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} МБ` : `${Math.round(bytes / 1e3)} КБ`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function MainMenu() {
  const worlds = useUi((s) => s.worlds);
  const notice = useUi((s) => s.notice);
  const refreshWorlds = useUi((s) => s.refreshWorlds);
  const openWorld = useUi((s) => s.openWorld);
  const deleteWorld = useUi((s) => s.deleteWorld);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => refreshWorlds(), [refreshWorlds]);
  return (
    <div className="wb-panel wb-menu" data-testid="main-menu">
      <div className="wb-logo">WORLDBOUND</div>
      <div className="wb-subtitle">Живой мир, созданный тобой</div>
      {notice && (
        <div className="wb-note wb-fail" data-testid="notice">
          {notice}
        </div>
      )}
      <button type="button" className="wb-btn wb-btn-primary" data-testid="new-world" onClick={() => useUi.setState({ screen: 'create', notice: null })}>
        Новый мир
      </button>
      <div className="wb-title wb-list-title">Сохранённые миры</div>
      {worlds === null && <div className="wb-muted">Загрузка списка…</div>}
      {worlds?.length === 0 && <div className="wb-muted">Пока нет ни одного мира.</div>}
      <div className="wb-worlds" data-testid="world-list">
        {worlds?.map((w) => {
          const cal = calendarFromTick(w.tick, w.config.daysPerSeason);
          return (
            <div className="wb-world" key={w.id} data-testid="world-item">
              <div className="wb-world-info">
                <div className="wb-world-name">{w.name}</div>
                <div className="wb-muted">
                  Год {cal.year}, {SEASON_NAMES[cal.season]?.toLowerCase()} · {SIZE_LABELS[w.config.size]} · seed {w.config.seed}
                </div>
                <div className="wb-muted">
                  Сохранён {formatDate(w.savedAt)} · {formatBytes(w.bytes)}
                </div>
              </div>
              <div className="wb-actions">
                <button type="button" className="wb-btn" data-testid="open-world" onClick={() => openWorld(w.id)}>
                  Открыть
                </button>
                {confirm === w.id ? (
                  <>
                    <button type="button" className="wb-btn wb-btn-danger" data-testid="confirm-delete" onClick={() => deleteWorld(w.id)}>
                      Удалить навсегда
                    </button>
                    <button type="button" className="wb-btn" onClick={() => setConfirm(null)}>
                      Отмена
                    </button>
                  </>
                ) : (
                  <button type="button" className="wb-btn" data-testid="delete-world" onClick={() => setConfirm(w.id)}>
                    Удалить
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="wb-note wb-muted">Миры хранятся в памяти браузера на этом компьютере. Очистка данных сайта удалит их.</div>
    </div>
  );
}

function randomSeedText(): string {
  const words = ['долина', 'исток', 'берег', 'кряж', 'ольха', 'туман', 'полынь', 'омут', 'утёс', 'ветер'];
  const a = words[Math.floor(Math.random() * words.length)]!;
  return `${a}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

export function CreateWorld() {
  const createWorld = useUi((s) => s.createWorld);
  const [name, setName] = useState('Новый мир');
  const [seedText, setSeedText] = useState(randomSeedText);
  const [size, setSize] = useState<WorldSizeName>(DEFAULT_CONFIG.size);
  const [days, setDays] = useState<number>(DEFAULT_CONFIG.daysPerSeason);
  const [climate, setClimate] = useState<ClimateName>(DEFAULT_CONFIG.climate);
  const [scenario, setScenario] = useState<ScenarioName>(DEFAULT_CONFIG.scenario);
  const [isolated, setIsolated] = useState(DEFAULT_CONFIG.isolated);
  const seed = /^\d+$/.test(seedText.trim()) ? Number(seedText.trim()) >>> 0 : seedFromString(seedText.trim());
  const submit = () => {
    const config: WorldConfig = { name, seed, size, daysPerSeason: days, climate, scenario, isolated };
    createWorld(config);
  };
  return (
    <form
      className="wb-panel wb-menu"
      data-testid="create-world"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="wb-title">Новый мир</div>
      <label className="wb-field">
        <span>Название</span>
        <input data-testid="world-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="wb-field">
        <span>Seed</span>
        <span className="wb-inline">
          <input data-testid="world-seed" value={seedText} onChange={(e) => setSeedText(e.target.value)} />
          <button type="button" className="wb-btn" title="Случайный seed" onClick={() => setSeedText(randomSeedText())}>
            ⟳
          </button>
        </span>
        <small className="wb-muted">Один и тот же seed с теми же настройками всегда даёт тот же мир (число {seed}).</small>
      </label>
      <div className="wb-field">
        <span>Размер</span>
        <span className="wb-inline">
          {(['S', 'M'] as const).map((s) => (
            <button key={s} type="button" data-testid={`size-${s}`} className={s === size ? 'wb-btn wb-btn-active' : 'wb-btn'} onClick={() => setSize(s)}>
              {SIZE_LABELS[s]}
            </button>
          ))}
        </span>
      </div>
      <div className="wb-field">
        <span>Климат</span>
        <span className="wb-inline">
          {CLIMATES.map((c) => (
            <button key={c} type="button" data-testid={`climate-${c}`} className={c === climate ? 'wb-btn wb-btn-active' : 'wb-btn'} onClick={() => setClimate(c)}>
              {CLIMATE_LABELS[c]}
            </button>
          ))}
        </span>
      </div>
      <div className="wb-field">
        <span>Начало жизни</span>
        <span className="wb-inline">
          {SCENARIOS.map((sc) => (
            <button key={sc} type="button" data-testid={`scenario-${sc}`} className={sc === scenario ? 'wb-btn wb-btn-active' : 'wb-btn'} onClick={() => setScenario(sc)}>
              {SCENARIO_LABELS[sc]}
            </button>
          ))}
        </span>
        <small className="wb-muted" data-testid="scenario-note">
          {scenario === 'genesis'
            ? 'Пустая земля без растений и семян. Жизнь придёт семенами из-за края мира (если он не изолирован) или от создателя.'
            : `Природа уже сложилась: мир заранее проживает ${WILDLANDS_YEARS} лет той же симуляции — травы, кустарники и молодые деревья вырастают сами. Подготовка занимает от минуты до нескольких минут.`}
        </small>
      </div>
      <label className="wb-field wb-check">
        <span className="wb-inline">
          <input type="checkbox" data-testid="world-isolated" checked={isolated} onChange={(e) => setIsolated(e.target.checked)} />
          Изолированный мир
        </span>
        <small className="wb-muted">
          {isolated
            ? 'Семена извне не приходят: новые виды не появятся, вымерший вид сам не вернётся. Растения мира размножаются как обычно.'
            : 'Семена диких видов приходят через сухопутные края мира и расселяются дальше сами.'}
        </small>
      </label>
      <div className="wb-field">
        <span>Длина сезона</span>
        <span className="wb-inline">
          {SEASON_LENGTHS.map((d) => (
            <button key={d} type="button" data-testid={`season-${d}`} className={d === days ? 'wb-btn wb-btn-active' : 'wb-btn'} onClick={() => setDays(d)}>
              {d} сут.
            </button>
          ))}
        </span>
        <small className="wb-muted">
          Игровые сутки — 12 минут на ×1; год — {days * 4} суток ({Math.round((days * 4 * 12) / 60)} ч на ×1).
        </small>
      </div>
      <div className="wb-actions">
        <button type="submit" className="wb-btn wb-btn-primary" data-testid="create-submit">
          Создать мир
        </button>
        <button type="button" className="wb-btn" onClick={() => useUi.setState({ screen: 'menu' })}>
          Назад
        </button>
      </div>
    </form>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} с`;
  return `${Math.floor(seconds / 60)} мин ${Math.round(seconds % 60)} с`;
}

export function Progress() {
  const progress = useUi((s) => s.progress);
  const cancelCreate = useUi((s) => s.cancelCreate);
  const [cancelling, setCancelling] = useState(false);
  return (
    <div className="wb-panel wb-center" data-testid="progress">
      <div className="wb-title">Создание мира</div>
      <div data-testid="progress-stage">{progress.stage || 'Подготовка…'}</div>
      <div className="wb-bar">
        <div className="wb-bar-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
      </div>
      <div className="wb-muted" data-testid="progress-detail">
        {Math.round(progress.fraction * 100)} %{progress.detail ? ` · ${progress.detail}` : ''}
        {progress.etaSeconds !== undefined ? ` · осталось около ${formatEta(progress.etaSeconds)}` : ''}
      </div>
      {progress.cancellable && (
        <button
          type="button"
          className="wb-btn"
          data-testid="progress-cancel"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            cancelCreate();
          }}
        >
          {cancelling ? 'Отмена…' : 'Отменить создание'}
        </button>
      )}
    </div>
  );
}
