import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config.ts';
import { LOGGER, type JsonLogger } from '../../platform/logging/json-logger.ts';
import { PollingLoop } from '../../platform/workers/polling-loop.ts';
import { WORKER_REGISTRY, type WorkerRegistry } from '../../platform/workers/worker-registry.ts';
import type { ConsumeWagerMessageUseCase } from '../application/consume-wager-message.use-case.ts';
import { consumeBatch } from '../application/message-batch.ts';
import { SQS_PORT, type SqsMessage, type SqsPort } from '../application/sqs.port.ts';

export const CONSUME_WAGER_MESSAGE_USE_CASE = Symbol('CONSUME_WAGER_MESSAGE_USE_CASE');

/** Lote máximo do ReceiveMessage. */
const MAX_MESSAGES = 10;

/**
 * Consumidor da fila de transações (plan, "Consumidor"), ligado por CONSUMER_ENABLED (R-27): long polling cancelável,
 * lote de até 10, processamento sequencial por grupo (R-22). Para no shutdown pelo WorkerRegistry (R-28).
 *
 * Término gracioso (FR-014, I-34; plan, "Encerramento gracioso"): o `stop` aborta o long polling e nenhuma mensagem
 * nova é iniciada; as recebidas e não iniciadas voltam visíveis na hora (`consumeBatch`); as em andamento terminam
 * (commit e ack) até `CONSUMER_SHUTDOWN_TIMEOUT_MS`. Se o prazo esgotar, o `drain` registrado devolve a visibilidade
 * (`ChangeMessageVisibility` 0) das que ainda estão em andamento **antes** de responder ao `drainAll`, ou seja, antes de
 * o `OrmLifecycle` fechar o pool. A transação delas sofre rollback ou termina; em qualquer caso a inbox garante um único
 * efeito quando outra instância as receber (FR-004).
 */
@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private loop: PollingLoop | undefined;
  /** Mensagens em andamento, por receipt handle (para a devolução no prazo esgotado). */
  private readonly inFlight = new Map<string, SqsMessage>();

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
            {
              started: (message) => this.inFlight.set(message.receiptHandle, message),
              finished: (message) => this.inFlight.delete(message.receiptHandle),
              returned: (message) => this.logReturned(message, 'not_started'),
            },
          );
        } catch (error) {
          if (signal.aborted) return; // long polling cancelado no término (R-28)
          throw error;
        }
      },
      onError: (error, nextDelayMs) => this.logger.warn('consumer.poll_failed', { error: describe(error), nextDelayMs }),
    });
    const loop = this.loop;
    this.registry.register({
      name: loop.name,
      stop: () => loop.stop(),
      drain: async (timeoutMs) => {
        const drained = await loop.drain(timeoutMs);
        if (!drained) await this.returnInFlight();
        return drained;
      },
    });
    loop.start();
    this.logger.info('consumer.started', { event: 'consumer.started', queue: sqs.transactionsQueue });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    await this.registry.drainAll(this.config.consumer.shutdownTimeoutMs);
  }

  /** Prazo esgotado: as mensagens ainda em andamento voltam visíveis para outra instância (FR-014). */
  private async returnInFlight(): Promise<void> {
    const pending = [...this.inFlight.values()];
    await Promise.all(
      pending.map(async (message) => {
        try {
          await this.sqs.changeVisibility(this.config.sqs.transactionsQueue, message.receiptHandle, 0);
          this.logReturned(message, 'shutdown_timeout');
        } catch (error) {
          // Sem a devolução, a visibilidade vence sozinha: a mensagem volta mais tarde, sem perda.
          this.logger.warn('consumer.return_failed', { sqsMessageId: message.sqsMessageId, error: describe(error) });
        }
      }),
    );
  }

  private logReturned(message: SqsMessage, reason: 'not_started' | 'shutdown_timeout'): void {
    this.logger.info('consumer.message_returned', {
      sqsMessageId: message.sqsMessageId,
      receiveCount: message.receiveCount,
      reason,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
