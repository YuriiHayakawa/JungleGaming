import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config.ts';
import { LOGGER, type JsonLogger } from '../../../platform/logging/json-logger.ts';
import { PollingLoop } from '../../../platform/workers/polling-loop.ts';
import { WORKER_REGISTRY, type WorkerRegistry } from '../../../platform/workers/worker-registry.ts';
import type { ResolvePendingReferenceUseCase } from '../../application/resolve-pending-reference.use-case.ts';

export const RESOLVE_PENDING_REFERENCE_USE_CASE = Symbol('RESOLVE_PENDING_REFERENCE_USE_CASE');

/**
 * Worker de PENDING_REFERENCE (plan, "Worker"), ligado por PENDING_WORKER_ENABLED (R-27): PollingLoop com
 * PENDING_WORKER_POLL_MS e claim por lease. Enquanto o lote vem cheio, reserva o próximo sem esperar. Falha da rodada
 * (PostgreSQL fora) → backoff do laço de 1 a 30 s, sem gravar nada (FR-034); para de reservar no shutdown pelo
 * WorkerRegistry (R-28, FR-015) e o que ficou reservado volta quando o lease vence.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private loop: PollingLoop | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RESOLVE_PENDING_REFERENCE_USE_CASE) private readonly useCase: ResolvePendingReferenceUseCase,
    @Inject(WORKER_REGISTRY) private readonly registry: WorkerRegistry,
    @Inject(LOGGER) private readonly logger: JsonLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.pendingWorker) return;
    const { pendingWorker } = this.config;
    this.loop = new PollingLoop({
      name: 'pending-worker',
      intervalMs: pendingWorker.pollMs,
      iteration: async (signal) => {
        for (;;) {
          const round = await this.useCase.resolveOnce();
          if (round.claimed < pendingWorker.batchSize || signal.aborted) return;
        }
      },
      onError: (error, nextDelayMs) =>
        this.logger.warn('pending_worker.poll_failed', {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          nextDelayMs,
        }),
    });
    this.registry.register(this.loop);
    this.loop.start();
    this.logger.info('pending_worker.started', { event: 'pending_worker.started', pollMs: pendingWorker.pollMs });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    await this.registry.drainAll(this.config.consumer.shutdownTimeoutMs);
  }
}
