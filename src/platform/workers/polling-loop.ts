/** Espera cancelável: resolve depois de `ms` ou logo que o sinal é abortado. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface PollingLoopOptions {
  name: string;
  /** Espera entre iterações bem-sucedidas. */
  intervalMs: number;
  /** Uma unidade de trabalho; recebe o sinal que é abortado no `stop()` (cancela o long polling). */
  iteration: (signal: AbortSignal) => Promise<void>;
  /** Backoff depois de uma iteração que falhou: dobra de `minMs` até `maxMs` (padrão 1 a 30 s, FR-033). */
  backoff?: { minMs: number; maxMs: number };
  /** Registro da falha (log); nunca deixa a exceção escapar do laço. */
  onError?: (error: unknown, nextDelayMs: number) => void;
  /** Injetável nos testes unitários. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_BACKOFF = { minMs: 1_000, maxMs: 30_000 };

/**
 * Laço de fundo genérico (research R-28): executa a iteração, dorme o intervalo (ou o backoff, se a iteração falhou,
 * por exemplo PostgreSQL ou SQS indisponível) e repete até `stop()`. A parada é cooperativa: o sinal repassado à
 * iteração é abortado e a espera é interrompida; o que está em andamento termina por conta própria e `drain(prazo)`
 * espera por ele. Nenhuma exceção da iteração escapa do laço (sem rejeição não tratada; FR-033 a FR-035).
 */
export class PollingLoop {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;
  private failures = 0;

  constructor(private readonly options: PollingLoopOptions) {}

  get name(): string {
    return this.options.name;
  }

  start(): void {
    if (this.running) throw new Error(`polling loop ${this.options.name} already started`);
    this.running = this.run();
  }

  /** Para de iniciar iterações novas e aborta o sinal da iteração em andamento. Idempotente. */
  stop(): void {
    this.controller.abort();
  }

  isRunning(): boolean {
    return this.running !== undefined && !this.finished;
  }

  /** Espera a iteração em andamento terminar, até `timeoutMs`. true se terminou no prazo. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (!this.running) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.running.then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private finished = false;

  private async run(): Promise<void> {
    const { signal } = this.controller;
    const sleep = this.options.sleep ?? abortableSleep;
    const backoff = this.options.backoff ?? DEFAULT_BACKOFF;
    try {
      while (!signal.aborted) {
        let delay = this.options.intervalMs;
        try {
          await this.options.iteration(signal);
          this.failures = 0;
        } catch (error) {
          delay = Math.min(backoff.minMs * 2 ** this.failures, backoff.maxMs);
          this.failures += 1;
          try {
            this.options.onError?.(error, delay);
          } catch {
            // o registro da falha nunca derruba o laço
          }
        }
        if (signal.aborted) break;
        await sleep(delay, signal);
      }
    } finally {
      this.finished = true;
    }
  }
}
