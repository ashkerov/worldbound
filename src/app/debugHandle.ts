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
}

declare global {
  interface Window {
    __wb?: DebugHandle;
  }
}
