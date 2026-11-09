// Ajuste N-13 (implementation-notes): `TransactionResult.balance` ficou opcional só para a FAILED (que nunca é corpo de
// resposta, I-62). Este teste falha se um resultado de qualquer outro status sair sem `balance`, ou se o guarda de
// `toTransactionResult` deixar de recusar uma transação não FAILED sem saldo observado.
import { describe, expect, test } from 'bun:test';
import { toTransactionResult } from '../../src/wagering/application/transaction-result.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransactionState,
} from '../../src/wagering/domain/wager-transaction.ts';
import { Money } from '../../src/shared-kernel/domain/money.ts';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function state(overrides: Partial<WagerTransactionState>): WagerTransactionState {
  return {
    id: '0196f000-0000-7000-8000-000000000001',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'a'.repeat(64),
    walletId: '0196f000-0000-7000-8000-0000000000aa',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('10.00'),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr-1',
    createdAt: NOW,
    referenceTransactionId: undefined,
    status: Status.Processed,
    failureCode: undefined,
    observedBalance: brl('90.00'),
    referenceAttempts: 0,
    nextReferenceAttemptAt: undefined,
    processedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const NON_FAILED: Array<Partial<WagerTransactionState>> = [
  { status: Status.Processed },
  { status: Status.Rejected, failureCode: FailureCode.InsufficientFunds, processedAt: undefined },
  {
    status: Status.PendingReference,
    kind: Kind.Refund,
    referenceExternalTransactionId: 'bet-1',
    processedAt: undefined,
    nextReferenceAttemptAt: NOW,
  },
];

describe('balance obrigatório fora de FAILED (N-13)', () => {
  for (const overrides of NON_FAILED) {
    test(`${overrides.status}: o resultado traz o saldo observado, como string decimal`, () => {
      for (const replay of [false, true]) {
        const result = toTransactionResult(WagerTransaction.rehydrate(state(overrides)), { replay });
        expect(result.balance).toEqual({ amount: '90.00', currency: 'BRL' });
      }
    });

    test(`${overrides.status} sem saldo observado: recusado, nunca vira resultado sem balance`, () => {
      const tx = WagerTransaction.rehydrate(state({ ...overrides, observedBalance: undefined }));
      expect(() => toTransactionResult(tx, { replay: true })).toThrow(/no observed balance/);
    });
  }

  test('PENDING (nunca é resultado de submissão) sem saldo: recusado', () => {
    const tx = WagerTransaction.rehydrate(state({ status: Status.Pending, observedBalance: undefined, processedAt: undefined }));
    expect(() => toTransactionResult(tx, { replay: false })).toThrow(/no observed balance/);
  });

  test('FAILED é o único status que pode sair sem balance (sem saldo observado gravado)', () => {
    const tx = WagerTransaction.rehydrate(
      state({ status: Status.Failed, failureCode: FailureCode.InternalError, observedBalance: undefined, processedAt: undefined }),
    );
    const result = toTransactionResult(tx, { replay: true });
    expect(result.balance).toBeUndefined();
    expect(result).toMatchObject({ status: 'FAILED', failureCode: 'INTERNAL_ERROR', retryable: false });
  });
});
