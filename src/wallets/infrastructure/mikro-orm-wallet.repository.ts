import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type { Wallet } from '../domain/wallet.ts';
import { WalletMapper } from './wallet.mapper.ts';
import { WalletRecord } from './wallet.schema.ts';

/** O UPDATE com versão esperada não afetou 1 linha: quebra de invariante, nunca caminho de negócio (R-07 → 500). */
export class WalletVersionMismatchError extends Error {
  constructor(walletId: string, expectedVersion: number) {
    super(`wallet ${walletId} was not at version ${expectedVersion} under lock`);
    this.name = 'WalletVersionMismatchError';
  }
}

/**
 * Repositório de wallets. Não guarda EntityManager: recebe o da execução em cada chamada; dentro de uma transação,
 * é sempre o EM da transação (R-19).
 */
export class MikroOrmWalletRepository {
  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    await em.insert(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id });
    return record ? WalletMapper.toDomain(record) : null;
  }

  /** `SELECT ... FOR UPDATE` da linha da wallet; a espera é limitada pelo lock_timeout da transação (R-07, I-51). */
  async lockById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? WalletMapper.toDomain(record) : null;
  }

  /** `UPDATE ... WHERE id = ? AND version = ?`: asserção de versão sob o lock; 0 linhas é quebra de invariante. */
  async updateBalance(em: EntityManager, wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new WalletVersionMismatchError(wallet.id, expectedVersion);
  }

  async findIdByPlayerAndCurrency(em: EntityManager, playerId: string, currency: string): Promise<string | null> {
    const record = await em.findOne(WalletRecord, { playerId, currency }, { fields: ['id'] });
    return record?.id ?? null;
  }
}
