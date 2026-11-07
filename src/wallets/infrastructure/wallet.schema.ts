import { DecimalType, EntitySchema } from '@mikro-orm/postgresql';

/** Record de persistência de `wallets` (data-model §2.1). Dinheiro como string decimal, nunca number (I-04). */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id', length: 255 },
    currency: { type: 'string', fieldName: 'currency', length: 3 },
    // DecimalType('string') explícito: o modo padrão segue o runtimeType e poderia virar number (spike S-05).
    balance: { type: new DecimalType('string'), fieldName: 'balance', precision: 18, scale: 2 },
    version: { type: 'integer', fieldName: 'version' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
});
