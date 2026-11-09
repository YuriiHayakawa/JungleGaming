// T048 — classificação dos erros do consumidor (R-23; FR-008 a FR-010, FR-009a, FR-040; I-30, I-61, I-68, I-70, I-71).
import { describe, expect, test } from 'bun:test';
import { DriverException } from '@mikro-orm/core';
import {
  classifyMessageFailure,
  submissionAction,
  retryDelaySeconds,
} from '../../src/messaging/application/message-classification.ts';
import { InvalidWagerMessageError } from '../../src/messaging/application/wager-message.envelope.ts';
import { InboxPayloadMismatchError } from '../../src/inbox/domain/inbox-message.ts';
import {
  IdempotencyConflictError,
  InternalError,
  ServiceUnavailableError,
  WalletNotFoundError,
} from '../../src/shared-kernel/application/errors.ts';
import { FailpointError, InvariantViolationFailpointError } from '../../src/platform/failpoints/failpoints.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction.ts';

const POLICY = { retryBaseSeconds: 5, retryMaxSeconds: 60 };
const pg = (code: string, message = 'db error') => new DriverException(Object.assign(new Error(message), { code }));

describe('negócio → ack (FR-008, I-62)', () => {
  test.each([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ])('resultado gravado %s → ack', (status) => {
    expect(submissionAction(status)).toBe('ack');
  });

  test('PENDING nunca é resultado de submissão: erro de programação', () => {
    expect(() => submissionAction(WagerTransactionStatus.Pending)).toThrow();
  });
});

describe('backoff da visibilidade: min(base × 2^(n−1), teto)', () => {
  test('n = 1 a 4 com base 5 e teto 60 → 5, 10, 20, 40 s; depois o teto', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => retryDelaySeconds(n, POLICY))).toEqual([5, 10, 20, 40, 60, 60]);
  });

  test('base 1 → 1, 2, 4, 8 s', () => {
    expect([1, 2, 3, 4].map((n) => retryDelaySeconds(n, { retryBaseSeconds: 1, retryMaxSeconds: 60 }))).toEqual([1, 2, 4, 8]);
  });
});

describe('transitório → retry com visibilidade (FR-009, I-30)', () => {
  test.each([
    ['ServiceUnavailableError (PG fora, lock esgotado, pool)', new ServiceUnavailableError()],
    ['55P03 lock_timeout', pg('55P03')],
    ['40P01 deadlock esgotado', pg('40P01')],
    ['57014 statement timeout', pg('57014')],
    ['conexão perdida', pg('08006')],
    ['ECONNREFUSED', Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })],
  ])('%s', (_, error) => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(classifyMessageFailure(error, n, POLICY)).toEqual({
        type: 'retry',
        visibilitySeconds: retryDelaySeconds(n, POLICY),
        errorClass: 'transient',
      });
    }
  });
});

describe('permanente → DLQ já no 1º recebimento, errorClass permanent (FR-010, I-30, I-68, I-70)', () => {
  test.each([
    ['MALFORMED_MESSAGE', new InvalidWagerMessageError('MALFORMED_MESSAGE', undefined)],
    ['UNSUPPORTED_MESSAGE_TYPE', new InvalidWagerMessageError('UNSUPPORTED_MESSAGE_TYPE', 'm')],
    ['VALIDATION_ERROR', new InvalidWagerMessageError('VALIDATION_ERROR', 'm')],
    ['OPENING_NOT_ALLOWED', new InvalidWagerMessageError('OPENING_NOT_ALLOWED', 'm')],
    ['WALLET_NOT_FOUND', new WalletNotFoundError()],
    ['INBOX_PAYLOAD_MISMATCH', new InboxPayloadMismatchError('m')],
    ['IDEMPOTENCY_CONFLICT', new IdempotencyConflictError()],
  ])('%s', (code, error) => {
    for (const n of [1, 3, 5]) {
      expect(classifyMessageFailure(error, n, POLICY)).toEqual({ type: 'dlq', errorCode: code, errorClass: 'permanent' });
    }
  });
});

describe('inesperado → transitório até o 4º recebimento; no 5º, DLQ INTERNAL_ERROR/unexpected (FR-009a, I-61, I-71)', () => {
  test.each([
    ['erro não classificado', new Error('boom')],
    ['FailpointError', new FailpointError('after_ledger_insert_before_commit')],
    ['quebra de invariante (P0001)', new InvariantViolationFailpointError('after_ledger_insert_before_commit')],
    ['InternalError', new InternalError()],
    ['valor que não é Error', 'string thrown'],
  ])('%s', (_, error) => {
    for (const n of [1, 2, 3, 4]) {
      expect(classifyMessageFailure(error, n, POLICY)).toEqual({
        type: 'retry',
        visibilitySeconds: retryDelaySeconds(n, POLICY),
        errorClass: 'unexpected',
      });
    }
    expect(classifyMessageFailure(error, 5, POLICY)).toEqual({ type: 'dlq', errorCode: 'INTERNAL_ERROR', errorClass: 'unexpected' });
    expect(classifyMessageFailure(error, 6, POLICY)).toEqual({ type: 'dlq', errorCode: 'INTERNAL_ERROR', errorClass: 'unexpected' });
  });
});
