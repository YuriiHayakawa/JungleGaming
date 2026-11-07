import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import { WagerTransactionMapper } from './wager-transaction.mapper.ts';
import { WagerTransactionRecord } from './wager-transaction.schema.ts';

/** Repositório de transações. A transação é inserida já no status final (data-model §3). EM por chamada (R-19). */
export class MikroOrmWagerTransactionRepository {
  async insert(em: EntityManager, tx: WagerTransaction): Promise<void> {
    await em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx));
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
