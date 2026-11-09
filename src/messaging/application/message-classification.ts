import { InboxPayloadMismatchError } from '../../inbox/domain/inbox-message.ts';
import { classifyDbError } from '../../platform/persistence/pg-errors.ts';
import {
  IdempotencyConflictError,
  OpeningNotAllowedError,
  ServiceUnavailableError,
  ValidationError,
  WalletNotFoundError,
} from '../../shared-kernel/application/errors.ts';
import { WagerTransactionStatus } from '../../wagering/domain/wager-transaction.ts';
import type { DlqErrorClass } from './message-batch.ts';
import { InvalidWagerMessageError } from './wager-message.envelope.ts';

/** O redrive leva a mensagem à DLQ ao passar de 5 recebimentos (I-30); o erro inesperado vai antes, no 5º (I-71). */
export const UNEXPECTED_DLQ_RECEIVE_COUNT = 5;

export interface RetryPolicy {
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

export type FailureClassification =
  | { type: 'retry'; visibilitySeconds: number; errorClass: 'transient' | 'unexpected' }
  | { type: 'dlq'; errorCode: string; errorClass: DlqErrorClass };

/** Espera antes da próxima entrega: min(base × 2^(n−1), teto), com n = ApproximateReceiveCount (FR-009, I-30). */
export function retryDelaySeconds(receiveCount: number, policy: RetryPolicy): number {
  const n = Math.max(receiveCount, 1);
  return Math.min(policy.retryBaseSeconds * 2 ** (n - 1), policy.retryMaxSeconds);
}

/**
 * Resultado gravado (ou replay) é negócio: a mensagem é confirmada (FR-008). Vale para PROCESSED, REJECTED,
 * PENDING_REFERENCE e para o replay de FAILED (I-62, FR-012). PENDING nunca sai de uma submissão.
 */
export function submissionAction(status: WagerTransactionStatus): 'ack' {
  if (status === WagerTransactionStatus.Pending) throw new Error('PENDING is never a submission result');
  return 'ack';
}

/** Código de DLQ dos erros permanentes (I-30, I-66, I-68, I-70), ou undefined se o erro não é permanente. */
function permanentCode(error: unknown): string | undefined {
  if (error instanceof InvalidWagerMessageError) return error.errorCode;
  if (error instanceof InboxPayloadMismatchError) return 'INBOX_PAYLOAD_MISMATCH';
  if (error instanceof WalletNotFoundError) return error.code;
  if (error instanceof IdempotencyConflictError) return error.code;
  if (error instanceof ValidationError || error instanceof OpeningNotAllowedError) return error.code;
  return undefined;
}

function isTransient(error: unknown): boolean {
  if (error instanceof ServiceUnavailableError) return true;
  const kind = classifyDbError(error);
  return kind === 'transient' || kind === 'retry';
}

/**
 * Classificação de uma falha no processamento de uma mensagem (research R-23):
 * - permanente (envelope, wallet inexistente, inbox venenosa, conflito de idempotência) → DLQ já no 1º recebimento,
 *   `errorClass` permanent;
 * - transitório (PostgreSQL fora, lock esgotado, deadlock esgotado, timeout, pool) → retry com backoff; quem leva à
 *   DLQ é o redrive, depois de 5 recebimentos (sem atributos);
 * - inesperado (quebra de invariante, erro não classificado) → como o transitório até o 4º recebimento; no 5º, DLQ
 *   pela aplicação com INTERNAL_ERROR e `errorClass` unexpected (I-71). O consumidor nunca grava FAILED (I-61).
 */
export function classifyMessageFailure(error: unknown, receiveCount: number, policy: RetryPolicy): FailureClassification {
  const code = permanentCode(error);
  if (code !== undefined) return { type: 'dlq', errorCode: code, errorClass: 'permanent' };
  if (isTransient(error)) {
    return { type: 'retry', visibilitySeconds: retryDelaySeconds(receiveCount, policy), errorClass: 'transient' };
  }
  if (receiveCount >= UNEXPECTED_DLQ_RECEIVE_COUNT) return { type: 'dlq', errorCode: 'INTERNAL_ERROR', errorClass: 'unexpected' };
  return { type: 'retry', visibilitySeconds: retryDelaySeconds(receiveCount, policy), errorClass: 'unexpected' };
}
