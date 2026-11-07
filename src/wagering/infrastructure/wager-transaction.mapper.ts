import { Money } from '../../shared-kernel/domain/money.ts';
import { isPersistableFailureCode } from '../domain/failure-code.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.ts';
import { WagerTransactionRecord } from './wager-transaction.schema.ts';

const KINDS = new Set<string>(Object.values(WagerTransactionKind));
const STATUSES = new Set<string>(Object.values(WagerTransactionStatus));

/** Mapper explícito domínio ↔ persistência; valores reidratados com Money.from, sem number (I-04). */
export const WagerTransactionMapper = {
  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    return Object.assign(new WagerTransactionRecord(), {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      observedBalance: tx.observedBalance?.amount ?? null,
      observedBalanceCurrency: tx.observedBalance?.currency ?? null,
      correlationId: tx.correlationId,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
      updatedAt: tx.updatedAt,
    });
  },

  toDomain(record: WagerTransactionRecord): WagerTransaction {
    if (!KINDS.has(record.kind)) throw new Error(`invalid kind in row ${record.id}`);
    if (!STATUSES.has(record.status)) throw new Error(`invalid status in row ${record.id}`);
    if (record.failureCode !== null && !isPersistableFailureCode(record.failureCode)) {
      throw new Error(`invalid failure code in row ${record.id}`);
    }
    const observedBalance =
      record.observedBalance !== null && record.observedBalanceCurrency !== null
        ? Money.from({ amount: record.observedBalance, currency: record.observedBalanceCurrency })
        : undefined;
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: Money.from({ amount: record.amount, currency: record.currency }),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      status: record.status as WagerTransactionStatus,
      failureCode: record.failureCode ?? undefined,
      observedBalance,
      correlationId: record.correlationId,
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
      createdAt: record.createdAt,
      processedAt: record.processedAt ?? undefined,
      updatedAt: record.updatedAt,
    });
  },
};
