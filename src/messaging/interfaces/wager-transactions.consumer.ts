import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config.ts';
import { LOGGER, type JsonLogger } from '../../platform/logging/json-logger.ts';
import { PollingLoop } from '../../platform/workers/polling-loop.ts';
import { WORKER_REGISTRY, type WorkerRegistry } from '../../platform/workers/worker-registry.ts';
import type { ConsumeWagerMessageUseCase } from '../application/consume-wager-message.use-case.ts';
import { consumeBatch } from '../application/message-batch.ts';
import { SQS_PORT, type SqsPort } from '../application/sqs.port.ts';

export const CONSUME_WAGER_MESSAGE_USE_CASE = Symbol('CONSUME_WAGER_MESSAGE_USE_CASE');

/** Lote máximo do ReceiveMessage. */
const MAX_MESSAGES = 10;

/**
 * Consumidor da fila de transações (plan, "Consumidor"), ligado por CONSUMER_ENABLED (R-27): long polling cancelável,
 * lote de até 10, processamento sequencial por grupo (R-22). Para no shutdown pelo WorkerRegistry (R-28).
 */
@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private loop: PollingLoop | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQS_PORT) private readonly sqs: SqsPort,
    @Inject(CONSUME_WAGER_MESSAGE_USE_CASE) private readonly useCase: ConsumeWagerMessageUseCase,
    @Inject(WORKER_REGISTRY) private readonly registry: WorkerRegistry,
    @Inject(LOGGER) private readonly logger: JsonLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.consumer) return;
    const { consumer, sqs } = this.config;
    this.loop = new PollingLoop({
      name: 'consumer',
      intervalMs: 0,
      iteration: async (signal) => {
        try {
          await consumeBatch(
            this.sqs,
            sqs.transactionsQueue,
            {
              max: MAX_MESSAGES,
              waitSeconds: consumer.waitSeconds,
              visibilitySeconds: consumer.visibilityTimeoutSeconds,
              signal,
            },
            this.useCase,
            (error) => this.logger.warn('consumer.message_failed', { error: describe(error) }),
          );
        } catch (error) {
          if (signal.aborted) return; // long polling cancelado no término (R-28)
          throw error;
        }
      },
      onError: (error, nextDelayMs) => this.logger.warn('consumer.poll_failed', { error: describe(error), nextDelayMs }),
    });
    this.registry.register(this.loop);
    this.loop.start();
    this.logger.info('consumer.started', { event: 'consumer.started', queue: sqs.transactionsQueue });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    await this.registry.drainAll(this.config.consumer.shutdownTimeoutMs);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
