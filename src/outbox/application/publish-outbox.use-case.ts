import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { SqsPort } from '../../messaging/application/sqs.port.ts';
import type { Failpoints } from '../../platform/failpoints/failpoints.ts';
import type { MetricsPort } from '../../platform/metrics/metrics.port.ts';
import type { UnitOfWork } from '../../platform/persistence/unit-of-work.ts';
import type { Clock } from '../../shared-kernel/domain/clock.port.ts';
import type { OutboxMessage, RetryBackoff } from '../domain/outbox-message.ts';
import type { MikroOrmOutboxRepository } from '../infrastructure/mikro-orm-outbox.repository.ts';

export interface PublisherLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, ...rest: unknown[]): void;
}

export interface PublishOutboxDeps {
  orm: Pick<MikroORM, 'em'>;
  unitOfWork: UnitOfWork<EntityManager>;
  outbox: MikroOrmOutboxRepository;
  sqs: SqsPort;
  eventsQueue: string;
  batchSize: number;
  leaseMs: number;
  backoff: RetryBackoff;
  failpoints: Failpoints;
  metrics: MetricsPort;
  clock: Clock;
  logger: PublisherLogger;
}

export interface PublishRound {
  claimed: number;
  published: number;
  /** Eventos cujo envio falhou nesta rodada (0 ou 1: o lote para na primeira falha de envio). */
  failed: number;
  /** Eventos reservados e não tentados, devolvidos com `next_attempt_at` = agora (N-22). */
  released: number;
}

/**
 * Publicação da outbox ao menos uma vez (plan, "Publicador"; FR-016 a FR-022; I-31, I-65; R-34):
 * 1. claim por lease numa transação curta (`FOR UPDATE SKIP LOCKED` + avanço de `next_attempt_at`), já confirmada;
 * 2. fora de transação, evento a evento: SendMessage em wager-events com o envelope gravado (`payload`, sem alteração),
 *    `MessageGroupId` = `aggregate_id` e `MessageDeduplicationId` = id do evento (FR-019, FR-022);
 * 3. failpoint `before_publish_mark` (R-29) e, **só depois do envio aceito**, a marca idempotente de publicado;
 * 4. falha de envio → `attempts + 1` e `next_attempt_at` com backoff (1 a 60 s) **só para o evento que falhou**; o lote
 *    para ali e os eventos reservados e ainda não tentados são devolvidos (`next_attempt_at` = agora, sem contar
 *    tentativa), em vez de esperarem o lease ou de baterem um a um numa fila fora (N-22). Falha de marca não para o lote
 *    (N-19);
 * 5. atraso da outbox (`now − occurred_at`) medido na marca (`outbox_lag_ms`, FR-036).
 * Só lê linhas confirmadas: nenhum evento sai antes do commit da transação que o registrou (FR-020).
 */
export class PublishOutboxUseCase {
  constructor(private readonly deps: PublishOutboxDeps) {}

  async publishOnce(): Promise<PublishRound> {
    const { outbox, batchSize, leaseMs, clock } = this.deps;
    const claimed = await this.deps.unitOfWork.run((em) => outbox.claim(em, clock.now(), batchSize, leaseMs));
    let published = 0;
    for (const [index, message] of claimed.entries()) {
      const outcome = await this.publish(message);
      if (outcome === 'published') published += 1;
      if (outcome === 'send_failed') {
        const untried = claimed.slice(index + 1).map((m) => m.id);
        await this.release(untried);
        return { claimed: claimed.length, published, failed: 1, released: untried.length };
      }
    }
    return { claimed: claimed.length, published, failed: 0, released: 0 };
  }

  /** Devolve os não tentados; banco fora também: o lease vence e eles voltam sozinhos (nada se perde). */
  private async release(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.deps.outbox.release(this.deps.orm.em.fork(), ids, this.deps.clock.now());
    } catch (error) {
      this.deps.logger.warn('publisher.release_failed', { count: ids.length, error: describe(error) });
    }
  }

  private async publish(message: OutboxMessage): Promise<'published' | 'send_failed' | 'mark_failed'> {
    const { sqs, eventsQueue, outbox, clock, logger } = this.deps;
    try {
      await sqs.send(eventsQueue, {
        body: JSON.stringify(message.payload),
        groupId: message.aggregateId,
        deduplicationId: message.id,
      });
    } catch (error) {
      message.scheduleRetry(clock.now(), this.deps.backoff);
      logger.warn('publisher.send_failed', {
        eventId: message.id,
        eventType: message.eventType,
        attempts: message.attempts,
        error: describe(error),
      });
      try {
        await outbox.scheduleRetry(this.deps.orm.em.fork(), message);
      } catch (scheduleError) {
        // Banco fora também: o lease vence e o evento volta sozinho; nada se perde.
        logger.warn('publisher.schedule_retry_failed', { eventId: message.id, error: describe(scheduleError) });
      }
      return 'send_failed';
    }

    // Entre o envio aceito e a marca (testes de queda, R-29): queda aqui → republicação com o mesmo eventId (FR-019).
    this.deps.failpoints.hit('before_publish_mark');
    const now = clock.now();
    try {
      await outbox.markPublished(this.deps.orm.em.fork(), message.id, now);
    } catch (error) {
      // Já enviado e não marcado: o lease vence e o evento é republicado com o mesmo eventId (seguro, FR-019).
      logger.warn('publisher.mark_failed', { eventId: message.id, error: describe(error) });
      return 'mark_failed';
    }
    this.deps.metrics.observe('outbox_lag_ms', Math.max(0, now.getTime() - message.occurredAt.getTime()));
    logger.info('publisher.published', { eventId: message.id, eventType: message.eventType, attempts: message.attempts });
    return 'published';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
