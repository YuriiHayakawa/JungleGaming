import type { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction.ts';
import { WagerTransactionMapper } from './wager-transaction.mapper.ts';
import { WagerTransactionRecord } from './wager-transaction.schema.ts';

/** Pendente reservada pelo claim do worker (data-model da 002, §3.3). */
export interface PendingClaim {
  id: string;
  walletId: string;
  providerId: string;
  referenceExternalTransactionId: string;
  createdAt: Date;
}

interface PendingClaimRow {
  id: string;
  wallet_id: string;
  provider_id: string;
  reference_external_transaction_id: string;
  created_at: Date;
}

const toClaim = (row: PendingClaimRow): PendingClaim => ({
  id: row.id,
  walletId: row.wallet_id,
  providerId: row.provider_id,
  referenceExternalTransactionId: row.reference_external_transaction_id,
  createdAt: new Date(row.created_at),
});

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

/**
 * A linha da pendente mudou de status sem passar pelo lock da wallet (0 linhas no UPDATE com
 * `WHERE status = 'PENDING_REFERENCE'`): quebra de invariante, nunca caminho de negócio (data-model §3.3).
 */
export class PendingTransactionChangedError extends Error {
  constructor(id: string) {
    super(`pending transaction ${id} is no longer PENDING_REFERENCE`);
    this.name = 'PendingTransactionChangedError';
  }
}

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

  // ---- worker de PENDING_REFERENCE (feature 002, data-model §3.3 e §3.4)

  /**
   * Claim por lease, numa transação curta e **sem** lock de wallet (R-26): reserva até `batch` pendentes vencidas com
   * `FOR UPDATE SKIP LOCKED` (nunca espera, então não entra em ciclo com o lock da wallet) e avança
   * `next_reference_attempt_at` para `now + leaseMs`. O `em` DEVE ser o de uma transação aberta. Usa
   * `wager_tx_pending_due_idx`. Desempate por `id` para ordem determinística.
   */
  async claimDuePending(em: EntityManager, now: Date, batch: number, leaseMs: number): Promise<PendingClaim[]> {
    const rows = await em.execute<PendingClaimRow[]>(
      `SELECT id, wallet_id, provider_id, reference_external_transaction_id, created_at
         FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
        ORDER BY next_reference_attempt_at, created_at, id
        LIMIT ?
          FOR UPDATE SKIP LOCKED`,
      [now, batch],
    );
    if (rows.length === 0) return [];
    await em.execute(
      `UPDATE wager_transactions SET next_reference_attempt_at = ?, updated_at = ?
        WHERE id IN (${placeholders(rows.length)}) AND status = 'PENDING_REFERENCE'`,
      [new Date(now.getTime() + leaseMs), now, ...rows.map((row) => row.id)],
    );
    return rows.map(toClaim);
  }

  /**
   * Irmãs mais antigas ainda pendentes (I-63, R-26): mesma wallet e mesma (provider, referência externa), criadas antes
   * (`created_at`, `id`), em ordem de criação. Usa `wager_tx_pending_by_reference_idx`.
   */
  async findOlderSiblings(em: EntityManager, pending: PendingClaim): Promise<PendingClaim[]> {
    const rows = await em.execute<PendingClaimRow[]>(
      `SELECT id, wallet_id, provider_id, reference_external_transaction_id, created_at
         FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ? AND wallet_id = ?
          AND (created_at, id) < (?, ?)
        ORDER BY created_at, id`,
      [pending.providerId, pending.referenceExternalTransactionId, pending.walletId, pending.createdAt, pending.id],
    );
    return rows.map(toClaim);
  }

  /** Grava a conclusão da pendente (PROCESSED ou REJECTED): exatamente 1 linha, senão quebra de invariante. */
  async updateResolution(em: EntityManager, tx: WagerTransaction): Promise<void> {
    const result = await em.execute<{ affectedRows?: number }>(
      `UPDATE wager_transactions
          SET status = ?, failure_code = ?, observed_balance = ?, observed_balance_currency = ?,
              reference_transaction_id = ?, processed_at = ?, next_reference_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'PENDING_REFERENCE'`,
      [
        tx.status,
        tx.failureCode ?? null,
        tx.observedBalance?.amount ?? null,
        tx.observedBalance?.currency ?? null,
        tx.referenceTransactionId ?? null,
        tx.processedAt ?? null,
        tx.updatedAt,
        tx.id,
      ],
      'run',
    );
    if ((result.affectedRows ?? 0) !== 1) throw new PendingTransactionChangedError(tx.id);
  }

  /** Nova tentativa agendada (I-11): só `reference_attempts`, `next_reference_attempt_at` e `updated_at` mudam. */
  async scheduleNextAttempt(em: EntityManager, tx: WagerTransaction): Promise<void> {
    if (tx.status !== WagerTransactionStatus.PendingReference || !tx.nextReferenceAttemptAt) {
      throw new PendingTransactionChangedError(tx.id);
    }
    const result = await em.execute<{ affectedRows?: number }>(
      `UPDATE wager_transactions SET reference_attempts = ?, next_reference_attempt_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING_REFERENCE'`,
      [tx.referenceAttempts, tx.nextReferenceAttemptAt, tx.updatedAt, tx.id],
      'run',
    );
    if ((result.affectedRows ?? 0) !== 1) throw new PendingTransactionChangedError(tx.id);
  }

  /** FAILED por erro permanente inesperado (I-22, I-61), numa transação separada: true se a linha ainda estava pendente. */
  async markFailed(em: EntityManager, tx: WagerTransaction): Promise<boolean> {
    const result = await em.execute<{ affectedRows?: number }>(
      `UPDATE wager_transactions SET status = ?, failure_code = ?, next_reference_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'PENDING_REFERENCE'`,
      [tx.status, tx.failureCode ?? null, tx.updatedAt, tx.id],
      'run',
    );
    return (result.affectedRows ?? 0) === 1;
  }

  /**
   * Antecipação (FR-026, I-21, I-63, I-73; data-model §3.4): na transação que concluiu (provider, id externo), puxa para
   * agora a próxima tentativa das pendentes que a referenciam e ainda não venceram. Não muda status nem tentativas.
   */
  async anticipateDependents(em: EntityManager, providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    const result = await em.execute<{ affectedRows?: number }>(
      `UPDATE wager_transactions SET next_reference_attempt_at = ?, updated_at = ?
        WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
          AND next_reference_attempt_at > ?`,
      [now, now, providerId, externalTransactionId, now],
      'run',
    );
    return result.affectedRows ?? 0;
  }
}
