import { Money } from '../../shared-kernel/domain/money.ts';
import { Wallet } from '../domain/wallet.ts';
import { WalletRecord } from './wallet.schema.ts';

/** Mapper explícito domínio ↔ persistência; reidrata o saldo com Money.from, sem passar por number (I-04). */
export const WalletMapper = {
  toRecord(wallet: Wallet): WalletRecord {
    return Object.assign(new WalletRecord(), {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  },

  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({ amount: record.balance, currency: record.currency }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },
};
