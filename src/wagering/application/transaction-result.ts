import type { MoneyProps } from '../../shared-kernel/domain/money.ts';
import { retryableOf, type FailureCode } from '../domain/failure-code.ts';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction.ts';

/**
 * Corpo das respostas 201, 200, 202 e 422 da submissão (FR-054, I-45). `failureCode` e `retryable` só existem em
 * REJECTED. `balance` é o saldo observado quando a transação foi processada (I-26).
 */
export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  retryable?: boolean;
}

export function toTransactionResult(tx: WagerTransaction, options: { replay: boolean }): TransactionResult {
  if (!tx.observedBalance) throw new Error(`transaction ${tx.id} has no observed balance`);
  const result: TransactionResult = {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance.toJSON(),
    idempotentReplay: options.replay,
  };
  if (tx.status === WagerTransactionStatus.Rejected && tx.failureCode) {
    result.failureCode = tx.failureCode;
    result.retryable = retryableOf(tx.failureCode);
  }
  return result;
}

/**
 * Status HTTP do resultado (FR-055, I-39, I-45): PROCESSED → 201 (200 no replay); PENDING_REFERENCE → 202;
 * REJECTED → 422. Os demais status nunca são respondidos como resultado de submissão nesta feature.
 */
export function httpStatusFor(result: TransactionResult): 200 | 201 | 202 | 422 {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      throw new Error(`status ${result.status} has no submission response`);
  }
}
