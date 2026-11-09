import { EntitySchema } from '@mikro-orm/postgresql';

/** Record de persistência de `inbox_messages` (data-model da 002, §2.1). PK composta (consumer_name, message_id). */
export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  transactionId!: string;
  receivedAt!: Date;
  processedAt!: Date;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', length: 64, primary: true },
    messageId: { type: 'string', fieldName: 'message_id', length: 128, primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    receivedAt: { type: 'datetime', fieldName: 'received_at' },
    processedAt: { type: 'datetime', fieldName: 'processed_at' },
  },
});
