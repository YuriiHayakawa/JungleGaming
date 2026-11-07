// T051 — taxonomia de failureCode (docs/interpretacoes.md §7, data-model §1, I-54, I-55, I-59).
import { describe, expect, test } from 'bun:test';
import {
  FAILURE_TAXONOMY,
  FailureCode,
  PERSISTABLE_FAILURE_CODES,
  REJECTION_FAILURE_CODES,
  RESPONSE_ONLY_CODES,
  actionOf,
  isRejectionCode,
  retryableOf,
} from '../../src/wagering/domain/failure-code.ts';

/** Tabela §7 copiada do docs/interpretacoes.md: código → [retryable, ação]. */
const EXPECTED: Record<string, [boolean, 'GIVE_UP' | 'FIX_PAYLOAD' | 'RESEND']> = {
  INSUFFICIENT_FUNDS: [false, 'GIVE_UP'],
  REVERSAL_WOULD_OVERDRAW: [false, 'GIVE_UP'],
  BALANCE_LIMIT_EXCEEDED: [false, 'GIVE_UP'],
  REFERENCE_NOT_FOUND: [false, 'FIX_PAYLOAD'],
  REFERENCE_REJECTED: [false, 'GIVE_UP'],
  REFERENCE_MISMATCH: [false, 'FIX_PAYLOAD'],
  INVALID_REFERENCE_KIND: [false, 'FIX_PAYLOAD'],
  ALREADY_REVERSED: [false, 'GIVE_UP'],
  AMOUNT_MISMATCH: [false, 'FIX_PAYLOAD'],
  CURRENCY_MISMATCH: [false, 'FIX_PAYLOAD'],
  WALLET_PLAYER_MISMATCH: [false, 'FIX_PAYLOAD'],
  VALIDATION_ERROR: [false, 'FIX_PAYLOAD'],
  OPENING_NOT_ALLOWED: [false, 'FIX_PAYLOAD'],
  IDEMPOTENCY_KEY_REQUIRED: [false, 'FIX_PAYLOAD'],
  IDEMPOTENCY_CONFLICT: [false, 'FIX_PAYLOAD'],
  WALLET_NOT_FOUND: [false, 'FIX_PAYLOAD'],
  WALLET_ALREADY_EXISTS: [false, 'FIX_PAYLOAD'],
  TRANSACTION_NOT_FOUND: [false, 'FIX_PAYLOAD'],
  ROUTE_NOT_FOUND: [false, 'FIX_PAYLOAD'],
  SERVICE_UNAVAILABLE: [true, 'RESEND'],
  INTERNAL_ERROR: [true, 'RESEND'],
};

describe('taxonomia §7', () => {
  test.each(Object.entries(EXPECTED))('%s → retryable e ação da tabela', (code, [retryable, action]) => {
    expect(retryableOf(code as keyof typeof FAILURE_TAXONOMY)).toBe(retryable);
    expect(actionOf(code as keyof typeof FAILURE_TAXONOMY)).toBe(action);
  });

  test('a taxonomia tem exatamente os códigos da tabela §7', () => {
    expect(Object.keys(FAILURE_TAXONOMY).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test('BALANCE_LIMIT_EXCEEDED: false, GIVE_UP (I-54); TRANSACTION_NOT_FOUND: false (I-55)', () => {
    expect(FAILURE_TAXONOMY.BALANCE_LIMIT_EXCEEDED).toEqual({ retryable: false, action: 'GIVE_UP' });
    expect(FAILURE_TAXONOMY.TRANSACTION_NOT_FOUND.retryable).toBe(false);
  });
});

describe('persistíveis × só de resposta HTTP (data-model §1)', () => {
  test('códigos de rejeição persistíveis são os 11 do CHECK wager_tx_failure_code_value_ck, sem INTERNAL_ERROR', () => {
    expect([...REJECTION_FAILURE_CODES].map(String).sort()).toEqual(
      [
        'INSUFFICIENT_FUNDS',
        'REVERSAL_WOULD_OVERDRAW',
        'BALANCE_LIMIT_EXCEEDED',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_REJECTED',
        'REFERENCE_MISMATCH',
        'INVALID_REFERENCE_KIND',
        'ALREADY_REVERSED',
        'AMOUNT_MISMATCH',
        'CURRENCY_MISMATCH',
        'WALLET_PLAYER_MISMATCH',
      ].sort(),
    );
  });

  test('persistíveis = rejeições + INTERNAL_ERROR (FAILED, feature de mensageria)', () => {
    expect([...PERSISTABLE_FAILURE_CODES].sort()).toEqual([...REJECTION_FAILURE_CODES, FailureCode.InternalError].sort());
  });

  test('só de resposta: os códigos de erro HTTP, inclusive TRANSACTION_NOT_FOUND e ROUTE_NOT_FOUND', () => {
    expect([...RESPONSE_ONLY_CODES].map(String).sort()).toEqual(
      [
        'VALIDATION_ERROR',
        'OPENING_NOT_ALLOWED',
        'IDEMPOTENCY_KEY_REQUIRED',
        'IDEMPOTENCY_CONFLICT',
        'WALLET_NOT_FOUND',
        'WALLET_ALREADY_EXISTS',
        'TRANSACTION_NOT_FOUND',
        'ROUTE_NOT_FOUND',
        'SERVICE_UNAVAILABLE',
        'INTERNAL_ERROR',
      ].sort(),
    );
    for (const code of ['TRANSACTION_NOT_FOUND', 'ROUTE_NOT_FOUND', 'VALIDATION_ERROR']) {
      expect(PERSISTABLE_FAILURE_CODES.has(code as FailureCode)).toBe(false);
    }
  });

  test('isRejectionCode distingue códigos de REJECTED', () => {
    expect(isRejectionCode('INSUFFICIENT_FUNDS')).toBe(true);
    expect(isRejectionCode('INTERNAL_ERROR')).toBe(false);
    expect(isRejectionCode('ROUTE_NOT_FOUND')).toBe(false);
  });
});
