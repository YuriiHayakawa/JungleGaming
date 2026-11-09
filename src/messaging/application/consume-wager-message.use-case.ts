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
import type { MetricsPort } from '../../platform/metrics/metrics.port.ts';
import type { Clock } from '../../shared-kernel/domain/clock.port.ts';
import { computePayloadHash } from '../../wagering/application/payload-hash.ts';
import type { SubmitWagerTransactionUseCase } from '../../wagering/application/submit-wager-transaction.use-case.ts';
import type { MessageAction, MessageHandler } from './message-batch.ts';
import type { SqsMessage, SqsPort } from './sqs.port.ts';
import { classifyMessageFailure, submissionAction } from './message-classification.ts';
import { InvalidWagerMessageError, parseWagerMessage } from './wager-message.envelope.ts';

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
  /** FR-036: duplicatas pela inbox, retries, DLQ e latência de processamento por mensagem. */
  metrics: MetricsPort;
  clock: Clock;
}

/**
 * Processamento de uma mensagem `WagerTransactionRequested` (plan, "Consumidor"; FR-001 a FR-008; R-22):
 * 1. contexto próprio, com correlationId = causationId = messageId (I-69);
 * 2. envelope (FR-002);
 * 3. caminho rápido da inbox, fora de transação: mesma mensagem e mesmo hash → ack sem efeito (FR-004);
 * 4. o mesmo use case do HTTP, com origem fila e a inbox anexada: inbox, transação, saldo, ledger e outbox no mesmo
 *    commit (FR-003); REJECTED e PENDING_REFERENCE gravados são negócio → ack (FR-008);
 * 5. ack = DeleteMessage só depois do commit (FR-005), com o failpoint `after_commit_before_ack` entre os dois (R-29).
 * Erros (research R-23, `message-classification.ts`): transitório e inesperado até o 4º recebimento → a mensagem não
 * é apagada e volta com espera crescente (ChangeMessageVisibility); permanente, e inesperado no 5º recebimento →
 * SendMessage à DLQ com `errorCode`, `errorClass`, `receiveCount` e `consumer` e, **só depois do envio aceito**,
 * DeleteMessage (FR-040). O consumidor nunca grava FAILED (FR-011, I-61).
 */
export class ConsumeWagerMessageUseCase implements MessageHandler {
  /** Início do processamento de cada mensagem, para `processing_latency_ms{worker="consumer"}` no fim do `apply`. */
  private readonly startedAt = new WeakMap<SqsMessage, number>();

  constructor(private readonly deps: ConsumeWagerMessageDeps) {}

  async process(message: SqsMessage): Promise<MessageAction> {
    this.startedAt.set(message, this.deps.clock.now().getTime());
    let envelope;
    try {
      envelope = parseWagerMessage(message.body);
    } catch (error) {
      // Sem envelope válido não há messageId confiável: a correlação e a deduplicação da DLQ usam o id do SQS (N-08).
      const knownId = error instanceof InvalidWagerMessageError ? error.messageId : undefined;
      const context: RequestContext = knownId
        ? { correlationId: knownId, messageId: knownId, causationId: knownId }
        : { correlationId: message.sqsMessageId };
      return this.onError(message, error, context, knownId ?? message.sqsMessageId);
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
          this.deps.metrics.increment('duplicates_total', { source: 'inbox' });
          return { type: 'ack', outcome: 'duplicate', committed: false, context: store };
        }

        const outcome = await this.deps.submit.submit({
          idempotencyKey,
          input,
          origin: 'queue',
          inbox: { consumerName: this.deps.consumer.name, messageId },
          causationId: messageId,
        });
        submissionAction(outcome.result.status); // REJECTED, PENDING_REFERENCE e replay de FAILED também são ack
        return {
          type: 'ack',
          outcome: outcome.effect === 'new' ? 'processed' : outcome.effect,
          committed: outcome.effect !== 'duplicate',
          status: outcome.result.status,
          context: store,
        };
      } catch (error) {
        return this.onError(message, error, store ?? context, messageId);
      }
    });
  }

  async apply(message: SqsMessage, action: MessageAction): Promise<void> {
    try {
      await this.applyAction(message, action);
    } finally {
      const startedAt = this.startedAt.get(message);
      this.startedAt.delete(message);
      if (startedAt !== undefined) {
        this.deps.metrics.observe('processing_latency_ms', Math.max(0, this.deps.clock.now().getTime() - startedAt), {
          worker: 'consumer',
        });
      }
    }
  }

  private async applyAction(message: SqsMessage, action: MessageAction): Promise<void> {
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
          this.deps.metrics.increment('retries_total', { worker: 'consumer' });
          this.deps.logger.info('consumer.message', {
            outcome: 'error',
            errorClass: action.errorClass,
            error: errorName(action.error),
            receiveCount: message.receiveCount,
            retryInSeconds: action.visibilitySeconds,
          });
          return;
        }
        case 'dlq': {
          // FR-040: primeiro o envio à DLQ, aceito pelo SQS; só depois o delete. Se o envio falhar, a exceção sobe e a
          // mensagem continua na fila principal (volta, é reclassificada e reenviada; a deduplicação da DLQ absorve).
          await this.deps.sqs.send(this.deps.queues.dlq, {
            body: message.body,
            groupId: message.groupId ?? action.deduplicationId,
            deduplicationId: action.deduplicationId,
            attributes: {
              errorCode: action.errorCode,
              errorClass: action.errorClass,
              receiveCount: String(message.receiveCount),
              consumer: this.deps.consumer.name,
            },
          });
          await this.deps.sqs.delete(this.deps.queues.transactions, message.receiptHandle);
          this.deps.metrics.increment('dlq_total', { errorCode: action.errorCode, errorClass: action.errorClass });
          this.deps.logger.info('consumer.message', {
            outcome: 'dlq',
            errorCode: action.errorCode,
            errorClass: action.errorClass,
            error: errorName(action.error),
            receiveCount: message.receiveCount,
          });
          return;
        }
      }
    });
  }

  private onError(message: SqsMessage, error: unknown, context: RequestContext, deduplicationId: string): MessageAction {
    const classified = classifyMessageFailure(error, message.receiveCount, this.deps.consumer);
    if (classified.type === 'dlq') {
      return { type: 'dlq', errorCode: classified.errorCode, errorClass: classified.errorClass, deduplicationId, error, context };
    }
    return { type: 'retry', visibilitySeconds: classified.visibilitySeconds, errorClass: classified.errorClass, error, context };
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
