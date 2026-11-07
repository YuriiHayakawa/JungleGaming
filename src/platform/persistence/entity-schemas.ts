import type { EntitySchema } from '@mikro-orm/postgresql';
import { OutboxMessageSchema } from '../../outbox/infrastructure/outbox-message.schema.ts';
import { WagerTransactionSchema } from '../../wagering/infrastructure/wager-transaction.schema.ts';
import { LedgerEntrySchema } from '../../wallets/infrastructure/ledger-entry.schema.ts';
import { WalletSchema } from '../../wallets/infrastructure/wallet.schema.ts';

/** EntitySchemas de todas as tabelas (research R-04). Sem decorators; o schema do banco vem só das migrations. */
export const ENTITY_SCHEMAS: EntitySchema[] = [
  WalletSchema,
  LedgerEntrySchema,
  WagerTransactionSchema,
  OutboxMessageSchema,
] as unknown as EntitySchema[];
