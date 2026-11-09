import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config.ts';
import { LOGGER, type JsonLogger } from '../../platform/logging/json-logger.ts';
import { PollingLoop } from '../../platform/workers/polling-loop.ts';
import { WORKER_REGISTRY, type WorkerRegistry } from '../../platform/workers/worker-registry.ts';
import type { PublishOutboxUseCase } from '../application/publish-outbox.use-case.ts';

export const PUBLISH_OUTBOX_USE_CASE = Symbol('PUBLISH_OUTBOX_USE_CASE');

/**
 * Publicador da outbox (plan, "Publicador"), ligado por PUBLISHER_ENABLED (R-27): PollingLoop com PUBLISHER_POLL_MS.
 * Enquanto o lote vem cheio, reserva o próximo sem esperar. Falha no claim (PostgreSQL fora) → backoff do laço
 * (FR-033); para de reservar no shutdown pelo WorkerRegistry (R-28, FR-015).
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private loop: PollingLoop | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PUBLISH_OUTBOX_USE_CASE) private readonly useCase: PublishOutboxUseCase,
    @Inject(WORKER_REGISTRY) private readonly registry: WorkerRegistry,
    @Inject(LOGGER) private readonly logger: JsonLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.publisher) return;
    const { publisher, sqs } = this.config;
    this.loop = new PollingLoop({
      name: 'publisher',
      intervalMs: publisher.pollMs,
      iteration: async (signal) => {
        for (;;) {
          const round = await this.useCase.publishOnce();
          if (round.claimed < publisher.batchSize || signal.aborted) return;
        }
      },
      onError: (error, nextDelayMs) =>
        this.logger.warn('publisher.poll_failed', {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          nextDelayMs,
        }),
    });
    this.registry.register(this.loop);
    this.loop.start();
    this.logger.info('publisher.started', { event: 'publisher.started', queue: sqs.eventsQueue });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    await this.registry.drainAll(this.config.consumer.shutdownTimeoutMs);
  }
}
