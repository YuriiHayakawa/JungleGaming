/** Prazo fixo de cada checagem do ready (I-75; FR-014). */
export const HEALTH_CHECK_TIMEOUT_MS = 2000;

export type DependencyState = 'up' | 'down';

export interface ReadinessChecks {
  postgres: DependencyState;
  sqs: DependencyState;
}

export interface ReadinessBody {
  status: 'ok' | 'unavailable';
  checks: ReadinessChecks;
}

/** Uma checagem de dependência: resolve se a dependência respondeu; qualquer rejeição é `down`. */
export type DependencyCheck = () => Promise<unknown>;

export interface HealthTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: HealthTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Agregação pura do ready (R-39; data-model §1): 200 `ok` só com todas as dependências `up` e a instância fora do
 * encerramento; senão 503 `unavailable`, sempre com o estado real de cada dependência (contracts/http.md).
 */
export function readinessOf(checks: ReadinessChecks, draining: boolean): { httpStatus: 200 | 503; body: ReadinessBody } {
  const ok = checks.postgres === 'up' && checks.sqs === 'up' && !draining;
  return {
    httpStatus: ok ? 200 : 503,
    body: { status: ok ? 'ok' : 'unavailable', checks: { postgres: checks.postgres, sqs: checks.sqs } },
  };
}

/**
 * Roda `check` com prazo (R-39): `up` se resolveu no prazo; `down` se rejeitou, lançou ou não terminou. Nunca rejeita
 * e nunca fica pendurado: o temporizador é cancelado ao fim, e uma checagem que termine depois do prazo é descartada
 * (com a rejeição tratada, para não virar `unhandledRejection`).
 */
export function withTimeout(check: DependencyCheck, timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS, timers: HealthTimers = realTimers): Promise<DependencyState> {
  return new Promise<DependencyState>((resolve) => {
    let settled = false;
    const finish = (state: DependencyState) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(handle);
      resolve(state);
    };
    const handle = timers.setTimeout(() => finish('down'), timeoutMs);
    let running: Promise<unknown>;
    try {
      running = check();
    } catch {
      finish('down');
      return;
    }
    running.then(
      () => finish('up'),
      () => finish('down'),
    );
  });
}
