import { OutboxMessage } from '../domain/outbox-message.ts';
import { OutboxMessageRecord } from './outbox-message.schema.ts';

/** Mapper explícito domínio ↔ persistência da outbox. */
export const OutboxMessageMapper = {
  toRecord(message: OutboxMessage): OutboxMessageRecord {
    return Object.assign(new OutboxMessageRecord(), {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      eventVersion: message.eventVersion,
      payload: { ...message.payload },
      correlationId: message.correlationId,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt ?? null,
    });
  },

  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      eventVersion: record.eventVersion,
      payload: record.payload,
      correlationId: record.correlationId,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    });
  },
};
