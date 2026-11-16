// Точка доступа для автоматических проверок (Playwright): window.__wb.

export interface DebugHandle {
  ready: boolean;
  backend: string;
  gpu: { adapter: string; software: boolean };
  getTick(): number;
  getStats(): unknown;
  sampleAgents(limit: number): number[];
  stateHash(): Promise<{ tick: number; hash: string }>;
}

declare global {
  interface Window {
    __wb?: DebugHandle;
  }
}
