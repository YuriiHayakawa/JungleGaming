import { Money } from '../../shared-kernel/domain/money.ts';
import { isLedgerDirection } from '../domain/ledger-direction.ts';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { LedgerEntryRecord } from './ledger-entry.schema.ts';

/** Mapper explícito domínio ↔ persistência do ledger; valores reidratados com Money.from (I-04). */
export const LedgerEntryMapper = {
  /** Sem `seq`: o banco o atribui no INSERT. */
  toRecord(entry: WalletLedgerEntry): Omit<LedgerEntryRecord, 'seq'> {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt,
    };
  },

  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    if (!isLedgerDirection(record.direction)) throw new Error(`invalid ledger direction in row ${record.id}`);
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction,
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      createdAt: record.createdAt,
    });
  },
};
