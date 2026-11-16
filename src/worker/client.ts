// Клиент воркера симуляции на главном потоке. Знает только протокол из shared.

import type {
  Command,
  FrameSnapshot,
  FromWorker,
  SimRequest,
  SimResponse,
  SimStats,
  TerrainMessage,
  ToWorker,
  WorldInit,
} from '../shared/protocol';

export interface SimClientHandlers {
  onReady?(seed: number, worldSize: number): void;
  onTerrain?(terrain: TerrainMessage): void;
  /** Получатель обязан вернуть отработавший буфер через `recycle`. */
  onSnapshot?(snapshot: FrameSnapshot): void;
  onStats?(stats: SimStats): void;
  onError?(message: string): void;
}

export class SimClient {
  private readonly worker: Worker;
  private nextRequestId = 1;
  private readonly pending = new Map<number, (response: SimResponse) => void>();

  constructor(private readonly handlers: SimClientHandlers) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module', name: 'worldbound-sim' });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => this.handlers.onError?.(event.message);
  }

  private post(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'ready':
        this.handlers.onReady?.(message.seed, message.worldSize);
        break;
      case 'terrain':
        this.handlers.onTerrain?.(message);
        break;
      case 'snapshot':
        if (this.handlers.onSnapshot) this.handlers.onSnapshot(message);
        else this.recycle(message.buffer);
        break;
      case 'stats':
        this.handlers.onStats?.(message);
        break;
      case 'response': {
        const resolve = this.pending.get(message.requestId);
        this.pending.delete(message.requestId);
        resolve?.(message.response);
        break;
      }
      case 'error':
        this.handlers.onError?.(message.message);
        break;
    }
  }

  init(init: WorldInit): void {
    this.post({ type: 'init', init });
  }

  send(command: Command): void {
    this.post({ type: 'command', command });
  }

  /** Возвращает буфер снимка воркеру для повторного использования. */
  recycle(buffer: ArrayBuffer): void {
    if (buffer.byteLength > 0) this.post({ type: 'recycle', buffer }, [buffer]);
  }

  request<K extends SimRequest['kind']>(request: Extract<SimRequest, { kind: K }>): Promise<Extract<SimResponse, { kind: K }>> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve as (response: SimResponse) => void);
      this.post({ type: 'request', requestId, request });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
