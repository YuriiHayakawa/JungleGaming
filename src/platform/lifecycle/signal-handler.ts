/** Margem do temporizador de segurança além do prazo do término gracioso (R-35). */
export const SHUTDOWN_MARGIN_MS = 5_000;

export interface SignalTarget {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export interface SafetyTimer {
  unref(): void;
  clear(): void;
}

export interface ShutdownSignalsOptions {
  /** `process` em produção; injetável nos testes. */
  target: SignalTarget;
  /** `app.close()`: dispara os `onApplicationShutdown` (drain do WorkerRegistry, fechamento do ORM). */
  close: () => Promise<void>;
  exit: (code: number) => void;
  /** CONSUMER_SHUTDOWN_TIMEOUT_MS; o temporizador de segurança é esse prazo + SHUTDOWN_MARGIN_MS. */
  shutdownTimeoutMs: number;
  setTimer?: (fn: () => void, ms: number) => SafetyTimer;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const defaultTimer = (fn: () => void, ms: number): SafetyTimer => {
  const handle = setTimeout(fn, ms);
  return { unref: () => handle.unref(), clear: () => clearTimeout(handle) };
};

/**
 * Handler próprio de SIGTERM/SIGINT no lugar do `enableShutdownHooks()` do Nest (spike S-12.8, research R-35): o do
 * Nest reemite o sinal depois dos hooks, e como PID 1 do container o processo não sai (ou sai com 143 com init).
 *
 * - o primeiro sinal chama `close()` e, ao terminar, `exit(0)`; erro no `close()` → `exit(1)`;
 * - sinais repetidos durante o encerramento são ignorados;
 * - um temporizador de segurança (`unref`, não segura o processo) força `exit(1)` se o `close()` não terminar em
 *   `shutdownTimeoutMs` + 5 s.
 */
export function installShutdownSignals(options: ShutdownSignalsOptions): void {
  const setTimer = options.setTimer ?? defaultTimer;
  let shuttingDown = false;

  const onSignal = (signal: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) {
      options.log?.('shutdown.signal_ignored', { signal });
      return;
    }
    shuttingDown = true;
    options.log?.('shutdown.started', { signal });
    const timeoutMs = options.shutdownTimeoutMs + SHUTDOWN_MARGIN_MS;
    const timer = setTimer(() => {
      options.log?.('shutdown.timeout', { timeoutMs });
      options.exit(1);
    }, timeoutMs);
    timer.unref();
    options.close().then(
      () => {
        timer.clear();
        options.log?.('shutdown.completed', { signal });
        options.exit(0);
      },
      (error: unknown) => {
        timer.clear();
        options.log?.('shutdown.failed', { error: error instanceof Error ? error.message : String(error) });
        options.exit(1);
      },
    );
  };

  options.target.on('SIGTERM', () => onSignal('SIGTERM'));
  options.target.on('SIGINT', () => onSignal('SIGINT'));
}
