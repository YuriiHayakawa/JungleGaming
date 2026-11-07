import { DecimalType, EntitySchema } from '@mikro-orm/postgresql';

/** Record de persistência de `wager_transactions` (data-model §2.2). Dinheiro como string decimal (I-04). */
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  observedBalanceCurrency!: string | null;
  correlationId!: string;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
  updatedAt!: Date;
}

const money = (fieldName: string, nullable = false) =>
  ({ type: new DecimalType('string'), fieldName, precision: 18, scale: 2, nullable }) as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id', length: 255 },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id', length: 255 },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', length: 255 },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id', length: 255 },
    roundId: { type: 'string', fieldName: 'round_id', length: 255 },
    gameId: { type: 'string', fieldName: 'game_id', length: 255 },
    kind: { type: 'string', fieldName: 'kind', length: 16 },
    amount: money('amount'),
    currency: { type: 'string', fieldName: 'currency', length: 3 },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      length: 255,
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string', fieldName: 'status', length: 24 },
    failureCode: { type: 'string', fieldName: 'failure_code', length: 48, nullable: true },
    observedBalance: money('observed_balance', true),
    observedBalanceCurrency: { type: 'string', fieldName: 'observed_balance_currency', length: 3, nullable: true },
    correlationId: { type: 'string', fieldName: 'correlation_id', length: 128 },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: { type: 'datetime', fieldName: 'next_reference_attempt_at', nullable: true },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    processedAt: { type: 'datetime', fieldName: 'processed_at', nullable: true },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
});
