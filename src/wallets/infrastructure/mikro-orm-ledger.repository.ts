import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { LedgerEntryMapper } from './ledger-entry.mapper.ts';
import { LedgerEntryRecord } from './ledger-entry.schema.ts';

/** Lançamento com a posição atribuída pelo banco; o `seq` só existe no read model do ledger (I-36). */
export interface PositionedLedgerEntry {
  /** bigint identity, lido como string; nunca number. */
  seq: string;
  entry: WalletLedgerEntry;
}

/** Repositório do ledger: inserção e leitura paginada; nunca altera nem apaga (FR-041). EM em cada chamada (R-19). */
export class MikroOrmLedgerRepository {
  async insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  /**
   * Uma página em ordem crescente de `seq`: `WHERE wallet_id = ? AND seq > ? ORDER BY seq LIMIT ?`, pelo índice
   * `ledger_wallet_seq_idx` (I-36, FR-050). Quem chama pede `limit + 1` para saber se há próxima página. O `seq` é
   * alocado sob o lock da wallet, então a ordem de `seq` é a ordem de commit e o cursor nunca pula lançamentos
   * (data-model §3, SC-010).
   */
  async listPage(em: EntityManager, walletId: string, afterSeq: string, limit: number): Promise<PositionedLedgerEntry[]> {
    const records = await em.find(
      LedgerEntryRecord,
      { walletId, seq: { $gt: afterSeq } },
      { orderBy: { seq: 'asc' }, limit },
    );
    return records.map((record) => {
      if (record.seq === undefined) throw new Error(`ledger row ${record.id} has no seq`);
      return { seq: record.seq, entry: LedgerEntryMapper.toDomain(record) };
    });
  }
}
