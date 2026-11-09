import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import { WagerTransactionMapper } from './wager-transaction.mapper.ts';
import { WagerTransactionRecord } from './wager-transaction.schema.ts';

/** Repositório de transações. A transação é inserida já no status final (data-model §3). EM por chamada (R-19). */
export class MikroOrmWagerTransactionRepository {
  async insert(em: EntityManager, tx: WagerTransaction): Promise<void> {
    await em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx));
  }

  /** Busca pelo id interno (PK), em qualquer status (FR-052). */
  async findById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { id });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  /** Busca pela chave de idempotência escopada por provedor; usa `wager_tx_provider_idempotency_uq` (I-56). */
  async findByProviderAndIdempotencyKey(
    em: EntityManager,
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { providerId, idempotencyKey });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  /**
   * Uma única consulta (um único snapshot em READ COMMITTED) por (provider, chave) OU (provider, id externo); usa os
   * dois índices únicos (I-24, I-56). Devolve no máximo duas transações, uma por chave e outra por id externo. Duas
   * consultas separadas poderiam ver estados diferentes: a primeira antes do commit da concorrente e a segunda
   * depois, o que transformaria uma requisição idêntica em conflito.
   */
  async findByProviderAndKeyOrExternalId(
    em: EntityManager,
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const records = await em.find(WagerTransactionRecord, {
      providerId,
      $or: [{ idempotencyKey }, { externalTransactionId }],
    });
    return records.map((record) => WagerTransactionMapper.toDomain(record));
  }

  /**
   * Se a transação referenciada já tem uma reversão PROCESSED, REFUND ou ROLLBACK (I-16). O predicado é o mesmo do
   * índice parcial `wager_tx_single_reversal_uq`, que atende a consulta. Chamada sob o lock da wallet, com o EM da
   * transação (R-19); o índice continua sendo a garantia final sob concorrência.
   */
  async existsProcessedReversal(em: EntityManager, referenceTransactionId: string): Promise<boolean> {
    const rows = await em.execute<{ found: number }[]>(
      `SELECT 1 AS found FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  /** Busca por (provider, id externo); usa `wager_tx_provider_external_uq` (I-24). */
  async findByProviderAndExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }
}
