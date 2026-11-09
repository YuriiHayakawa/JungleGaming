import { WORKER_REGISTRY, type WorkerRegistry } from '../workers/worker-registry.ts';

/** O mínimo da app Nest que o encerramento usa. */
export interface ShutdownTarget {
  get(token: typeof WORKER_REGISTRY): unknown;
  close(): Promise<void>;
}

const inFlight = new WeakMap<ShutdownTarget, Promise<void>>();

/**
 * Encerramento gracioso (research R-40; FR-016), usado pelo handler de sinal do `main.ts` e pelo `shutdown()` dos
 * testes em processo:
 *
 * 1. na hora, de forma síncrona: `WorkerRegistry.beginShutdown()` → o `GET /health/ready` passa a responder 503 antes de
 *    a drenagem começar (requisito do usuário, implementation-notes da 003);
 * 2. `drainAll(timeoutMs)` com o servidor HTTP ainda aberto: os trabalhadores param de reservar trabalho e concluem ou
 *    devolvem o que está em andamento (002, R-28 e N-36), e o ready continua respondendo 503;
 * 3. só então `app.close()`: fecha o HTTP e dispara os `onApplicationShutdown` (o `OrmLifecycle` chama `drainAll` de
 *    novo, que devolve a mesma promessa já resolvida, e fecha o pool).
 *
 * Chamadas repetidas devolvem a mesma promessa. Erro no `close()` propaga (o handler sai com 1).
 */
export function gracefulShutdown(app: ShutdownTarget, timeoutMs: number): Promise<void> {
  const existing = inFlight.get(app);
  if (existing) return existing;
  const registry = app.get(WORKER_REGISTRY) as WorkerRegistry;
  registry.beginShutdown();
  const done = (async () => {
    await registry.drainAll(timeoutMs);
    await app.close();
  })();
  inFlight.set(app, done);
  return done;
}
