import { InboxMessage } from '../domain/inbox-message.ts';
import { InboxMessageRecord } from './inbox-message.schema.ts';

/** Mapper explícito domínio ↔ persistência da inbox. Só grava linha já processada (`processed_at NOT NULL`). */
export const InboxMessageMapper = {
  toRecord(message: InboxMessage): InboxMessageRecord {
    if (!message.processedAt) {
      throw new Error(`inbox message ${message.consumerName}/${message.messageId} must be processed before it is stored`);
    }
    return Object.assign(new InboxMessageRecord(), {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      transactionId: message.transactionId,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt,
    });
  },

  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      transactionId: record.transactionId,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt,
    });
  },
};
