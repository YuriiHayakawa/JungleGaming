import { BigIntType, DecimalType, EntitySchema } from '@mikro-orm/postgresql';

/**
 * Record de persistência de `wallet_ledger_entries` (data-model §2.3). Dinheiro como string decimal; `seq` é
 * atribuído pelo banco (identity) e lido como string, nunca number (I-36, spike S-05). O insert nunca o envia.
 */
export class LedgerEntryRecord {
  seq?: string;
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    seq: { type: new BigIntType('string'), fieldName: 'seq', nullable: true },
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', fieldName: 'direction', length: 6 },
    amount: { type: new DecimalType('string'), fieldName: 'amount', precision: 18, scale: 2 },
    currency: { type: 'string', fieldName: 'currency', length: 3 },
    balanceBefore: { type: new DecimalType('string'), fieldName: 'balance_before', precision: 18, scale: 2 },
    balanceAfter: { type: new DecimalType('string'), fieldName: 'balance_after', precision: 18, scale: 2 },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
  },
});
