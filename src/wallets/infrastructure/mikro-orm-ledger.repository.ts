import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { LedgerEntryMapper } from './ledger-entry.mapper.ts';
import { LedgerEntryRecord } from './ledger-entry.schema.ts';

/** Repositório do ledger: só inserção (imutável, FR-041). EM recebido em cada chamada (R-19). */
export class MikroOrmLedgerRepository {
  async insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }
}
