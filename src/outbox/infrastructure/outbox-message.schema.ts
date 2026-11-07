import { EntitySchema } from '@mikro-orm/postgresql';

/** Record de persistência de `outbox_messages` (data-model §2.4). `payload` é o envelope `toJSON()` em jsonb. */
export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  payload!: Record<string, unknown>;
  correlationId!: string;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type', length: 64 },
    eventVersion: { type: 'integer', fieldName: 'event_version' },
    payload: { type: 'json', fieldName: 'payload' },
    correlationId: { type: 'string', fieldName: 'correlation_id', length: 128 },
    occurredAt: { type: 'datetime', fieldName: 'occurred_at' },
    attempts: { type: 'integer', fieldName: 'attempts' },
    nextAttemptAt: { type: 'datetime', fieldName: 'next_attempt_at' },
    publishedAt: { type: 'datetime', fieldName: 'published_at', nullable: true },
  },
});
