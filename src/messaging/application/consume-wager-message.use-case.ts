import type { MikroORM } from '@mikro-orm/postgresql';
import { InboxPayloadMismatchError } from '../../inbox/domain/inbox-message.ts';
import type { MikroOrmInboxRepository } from '../../inbox/infrastructure/mikro-orm-inbox.repository.ts';
import type { ConsumerConfig } from '../../platform/config/app-config.ts';
import {
  currentRequestContext,
  runWithRequestContext,
  setRequestContextValues,
  type RequestContext,
} from '../../platform/correlation/request-context.ts';
import type { Failpoints } from '../../platform/failpoints/failpoints.ts';
import { computePayloadHash } from '../../wagering/application/payload-hash.ts';
import type { SubmitWagerTransactionUseCase } from '../../wagering/application/submit-wager-transaction.use-case.ts';
import type { MessageAction, MessageHandler } from './message-batch.ts';
import type { SqsMessage, SqsPort } from './sqs.port.ts';
import { parseWagerMessage } from './wager-message.envelope.ts';

export interface ConsumerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, ...rest: unknown[]): void;
}

export interface ConsumeWagerMessageDeps {
  orm: Pick<MikroORM, 'em'>;
  submit: SubmitWagerTransactionUseCase;
  inbox: MikroOrmInboxRepository;
  sqs: SqsPort;
  queues: { transactions: string; dlq: string };
  consumer: ConsumerConfig;
  failpoints: Failpoints;
  logger: ConsumerLogger;
}

/**
 * Processamento de uma mensagem `WagerTransactionRequested` (plan, "Consumidor"; FR-001 a FR-008; R-22):
 * 1. contexto próprio, com correlationId = causationId = messageId (I-69);
 * 2. envelope (FR-002);
 * 3. caminho rápido da inbox, fora de transação: mesma mensagem e mesmo hash → ack sem efeito (FR-004);
 * 4. o mesmo use case do HTTP, com origem fila e a inbox anexada: inbox, transação, saldo, ledger e outbox no mesmo
 *    commit (FR-003); REJECTED e PENDING_REFERENCE gravados são negócio → ack (FR-008);
 * 5. ack = DeleteMessage só depois do commit (FR-005), com o failpoint `after_commit_before_ack` entre os dois (R-29).
 * Qualquer erro: a mensagem não é apagada e volta depois de uma espera crescente (a classificação completa entre
 * transitório, permanente e inesperado é da US2).
 */
export class ConsumeWagerMessageUseCase implements MessageHandler {
  constructor(private readonly deps: ConsumeWagerMessageDeps) {}

  async process(message: SqsMessage): Promise<MessageAction> {
    let envelope;
    try {
      envelope = parseWagerMessage(message.body);
    } catch (error) {
      return this.onError(message, error, { correlationId: message.sqsMessageId });
    }
    const { messageId, input, idempotencyKey } = envelope;
    const context: RequestContext = { correlationId: messageId, messageId, causationId: messageId };

    return runWithRequestContext(context, async () => {
      setRequestContextValues({ walletId: input.walletId, providerId: input.providerId });
      const store = currentRequestContext();
      try {
        // Caminho rápido da inbox (plan, passo 2.2): num fork próprio, sem transação nem lock.
        const stored = await this.deps.inbox.findByConsumerAndMessageId(
          this.deps.orm.em.fork(),
          this.deps.consumer.name,
          messageId,
        );
        if (stored) {
          if (!stored.matchesPayload(computePayloadHash(input))) throw new InboxPayloadMismatchError(messageId);
          setRequestContextValues({ transactionId: stored.transactionId });
          return { type: 'ack', outcome: 'duplicate', committed: false, context: store };
        }

        const outcome = await this.deps.submit.submit({
          idempotencyKey,
          input,
          origin: 'queue',
          inbox: { consumerName: this.deps.consumer.name, messageId },
          causationId: messageId,
        });
        return {
          type: 'ack',
          outcome: outcome.effect === 'new' ? 'processed' : outcome.effect,
          committed: outcome.effect !== 'duplicate',
          status: outcome.result.status,
          context: store,
        };
      } catch (error) {
        return this.onError(message, error, store ?? context);
      }
    });
  }

  async apply(message: SqsMessage, action: MessageAction): Promise<void> {
    const context = action.context ?? { correlationId: message.sqsMessageId };
    await runWithRequestContext(context, async () => {
      switch (action.type) {
        case 'ack': {
          // Depois do commit e antes do ack (testes de queda, R-29); no-op em produção (I-40).
          if (action.committed) this.deps.failpoints.hit('after_commit_before_ack');
          await this.deps.sqs.delete(this.deps.queues.transactions, message.receiptHandle);
          this.deps.logger.info('consumer.message', {
            outcome: action.outcome,
            status: action.status,
            receiveCount: message.receiveCount,
          });
          return;
        }
        case 'retry': {
          await this.deps.sqs.changeVisibility(this.deps.queues.transactions, message.receiptHandle, action.visibilitySeconds);
          this.deps.logger.info('consumer.message', {
            outcome: 'error',
            errorClass: action.errorClass,
            error: errorName(action.error),
            receiveCount: message.receiveCount,
            retryInSeconds: action.visibilitySeconds,
          });
          return;
        }
        case 'dlq':
          throw new Error('DLQ handling is not available yet');
      }
    });
  }

  /** Espera antes da próxima entrega: min(base × 2^(n−1), teto), n = ApproximateReceiveCount (FR-009). */
  private retryDelaySeconds(receiveCount: number): number {
    const { retryBaseSeconds, retryMaxSeconds } = this.deps.consumer;
    return Math.min(retryBaseSeconds * 2 ** (Math.max(receiveCount, 1) - 1), retryMaxSeconds);
  }

  private onError(message: SqsMessage, error: unknown, context: RequestContext): MessageAction {
    return {
      type: 'retry',
      visibilitySeconds: this.retryDelaySeconds(message.receiveCount),
      error,
      errorClass: 'unexpected',
      context,
    };
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
