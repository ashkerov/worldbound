// Точка доступа для автоматических проверок (Playwright): window.__wb.

export interface DebugView {
  mode: 'strategic' | 'free';
  target: [number, number, number];
  yaw: number;
  pitch: number;
  distance: number;
}

export interface DebugHandle {
  /** Мир создан или загружен и показан. */
  ready: boolean;
  backend: string;
  gpu: { adapter: string; software: boolean };
  getTick(): number;
  getStats(): unknown;
  sampleAgents(limit: number): number[];
  stateHash(): Promise<{ tick: number; hash: string; geoHash: string }>;
  setView(view: Partial<DebugView>): void;
  getView(): DebugView;
  worldSize(): number;
  /** Имитация щелчка по точке мира — открывает карточку ячейки. */
  pick(x: number, z: number): void;
  /** Высота поверхности в рендере — для проверки, что рельеф совпадает с данными симуляции. */
  ground(x: number, z: number): number;
  /** Растительность в рендере (этап 5): статистика, показанные растения по видам, данные растений у точки, выключение. */
  flora: {
    stats(): unknown;
    shownBySpecies(): Record<string, number>;
    plantsNear(x: number, z: number, radius: number): { species: string; x: number; z: number; height: number; crown: number; leaf: number }[];
    setEnabled(on: boolean): void;
    findSpots(): Record<string, [number, number] | null>;
    /** Ветер растений и ветер последнего сообщения погоды. */
    wind(): { flora: { dirX: number; dirZ: number; strength: number } | null; weather: { x: number; z: number; speed: number } | null };
  };
  setQuality(name: 'low' | 'medium' | 'high'): void;
}

declare global {
  interface Window {
    __wb?: DebugHandle;
  }
}
