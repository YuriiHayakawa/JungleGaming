/** Trabalhador de fundo controlável: para de reservar trabalho e drena o que está em andamento (R-28). */
export interface DrainableWorker {
  readonly name: string;
  stop(): void;
  drain(timeoutMs: number): Promise<boolean>;
}

export const WORKER_REGISTRY = Symbol('WORKER_REGISTRY');

/**
 * Registro dos trabalhadores ativos (research R-28). O Nest não garante a ordem entre providers no mesmo hook de
 * shutdown; o `OrmLifecycle` chama `drainAll()` antes de fechar o pool, para que nenhuma transação de trabalhador fique
 * sem conexão. Cada trabalhador também chama `drainAll` (ou o próprio drain) no seu hook; a segunda chamada só espera a
 * primeira.
 *
 * Feature 003 (R-40, FR-016): `isDraining()` é o que o `GET /health/ready` consulta. Ele fica true no instante em que o
 * encerramento começa (`beginShutdown()`, chamado de forma síncrona pelo handler de sinal antes de qualquer drenagem) e
 * continua true até a saída; `drainAll` também o liga, para quem encerra sem passar pelo sinal.
 */
export class WorkerRegistry {
  private readonly workers: DrainableWorker[] = [];
  private draining: Promise<boolean> | undefined;
  private shuttingDown = false;

  register(worker: DrainableWorker): void {
    if (this.draining) throw new Error(`worker ${worker.name} registered after shutdown started`);
    this.workers.push(worker);
  }

  /** Marca a instância como encerrando (ready → 503), sem parar nem esperar ninguém. Idempotente. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** true desde `beginShutdown()` ou da primeira chamada de `drainAll`, até a saída. */
  isDraining(): boolean {
    return this.shuttingDown || this.draining !== undefined;
  }

  /** Para todos e espera todos drenarem, em paralelo, até `timeoutMs`. true se todos drenaram. */
  drainAll(timeoutMs: number): Promise<boolean> {
    if (!this.draining) {
      this.shuttingDown = true;
      for (const worker of this.workers) worker.stop();
      this.draining = Promise.all(this.workers.map((worker) => worker.drain(timeoutMs))).then((results) =>
        results.every(Boolean),
      );
    }
    return this.draining;
  }
}
