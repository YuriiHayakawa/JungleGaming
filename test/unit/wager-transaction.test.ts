// T050 — WagerTransaction (FR-028, I-07, I-11, I-12, I-13; enunciado §6.3).
import { describe, expect, test } from 'bun:test';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../src/wagering/domain/wager-transaction.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import { LedgerDirection } from '../../src/wallets/domain/ledger-direction.ts';
import { Money } from '../../src/shared-kernel/domain/money.ts';
import { InvalidTransactionStateError } from '../../src/shared-kernel/domain/errors.ts';
import { FixedClock, SequentialIdGenerator } from '../support/fakes.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const ids = new SequentialIdGenerator();
const clock = new FixedClock();
const HASH = 'a'.repeat(64);

function props(kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const needsReference = kind === Kind.Refund || kind === Kind.Rollback;
  return {
    id: ids.next(),
    providerId: 'provider-a',
    externalTransactionId: `ext-${ids.next()}`,
    idempotencyKey: 'provider-a:ext',
    payloadHash: HASH,
    walletId: ids.next(),
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    ...(needsReference ? { referenceExternalTransactionId: 'ref-1' } : {}),
    correlationId: 'corr-1',
    createdAt: clock.now(),
    ...overrides,
  };
}

const pending = (kind: Kind = Kind.Bet) => WagerTransaction.create(props(kind));
const at = () => clock.now();

describe('create (I-13, I-07, I-08, I-02)', () => {
  test('nasce PENDING com os campos informados', () => {
    const p = props(Kind.Bet);
    const tx = WagerTransaction.create(p);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.id).toBe(p.id);
    expect(tx.kind).toBe(Kind.Bet);
    expect(tx.money.equals(brl('25.00'))).toBe(true);
    expect(tx.correlationId).toBe('corr-1');
    expect(tx.observedBalance).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  test('BET com referência é recusada', () => {
    expect(() => WagerTransaction.create(props(Kind.Bet, { referenceExternalTransactionId: 'x' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('REFUND e ROLLBACK sem referência são recusados', () => {
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      expect(() => WagerTransaction.create(props(kind, { referenceExternalTransactionId: undefined }))).toThrow(
        InvalidWagerTransactionError,
      );
    }
  });

  test('WIN e LOSS aceitam referência opcional', () => {
    for (const kind of [Kind.Win, Kind.Loss]) {
      expect(WagerTransaction.create(props(kind)).referenceExternalTransactionId).toBeUndefined();
      expect(WagerTransaction.create(props(kind, { referenceExternalTransactionId: 'b-1' })).referenceExternalTransactionId).toBe('b-1');
    }
  });

  test('kind OPENING vindo de provedor e providerId "system" são recusados (I-07, I-08)', () => {
    expect(() => WagerTransaction.create(props(Kind.Opening))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props(Kind.Bet, { providerId: 'system' }))).toThrow(InvalidWagerTransactionError);
  });

  test('valor zero só em LOSS (I-02)', () => {
    expect(WagerTransaction.create(props(Kind.Loss, { money: brl('0') })).money.amount).toBe('0.00');
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
      expect(() => WagerTransaction.create(props(kind, { money: brl('0.00') }))).toThrow(InvalidWagerTransactionError);
    }
  });
});

describe('createOpening (I-07)', () => {
  test('usa a identidade reservada da abertura e nasce PENDING', () => {
    const walletId = ids.next();
    const opening = WagerTransaction.createOpening({
      id: ids.next(),
      walletId,
      playerId: 'player-1',
      money: brl('1000.00'),
      payloadHash: HASH,
      correlationId: 'corr-open',
      createdAt: clock.now(),
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.providerId).toBe('system');
    expect(opening.externalTransactionId).toBe(`opening:${walletId}`);
    expect(opening.idempotencyKey).toBe(`system:opening:${walletId}`);
    expect(opening.roundId).toBe('opening');
    expect(opening.gameId).toBe('system');
    expect(opening.status).toBe(Status.Pending);
    expect(opening.referenceExternalTransactionId).toBeUndefined();
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('abertura com valor zero é recusada (saldo 0.00 não gera OPENING, I-06)', () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: ids.next(),
        walletId: ids.next(),
        playerId: 'p',
        money: brl('0.00'),
        payloadHash: HASH,
        correlationId: 'c',
        createdAt: clock.now(),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('transições válidas do I-11', () => {
  test('PENDING → PROCESSED grava referência resolvida, saldo observado e processedAt', () => {
    const tx = pending(Kind.Win);
    const when = at();
    tx.markProcessed('ref-internal', brl('975.00'), when);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref-internal');
    expect(tx.observedBalance?.amount).toBe('975.00');
    expect(tx.processedAt?.getTime()).toBe(when.getTime());
    expect(tx.updatedAt.getTime()).toBe(when.getTime());
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED grava failureCode e saldo observado, sem processedAt', () => {
    const tx = pending();
    tx.reject(FailureCode.InsufficientFunds, brl('10.00'), at());
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance?.amount).toBe('10.00');
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  test('reject só aceita códigos de rejeição de negócio', () => {
    expect(() => pending().reject(FailureCode.InternalError, brl('1.00'), at())).toThrow(InvalidTransactionStateError);
  });

  test('PENDING → PENDING_REFERENCE inicia attempts em 0 e agenda a próxima tentativa', () => {
    const tx = pending(Kind.Rollback);
    const next = new Date(at().getTime() + 5000);
    tx.markPendingReference(brl('100.00'), next, at());
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(next.getTime());
    expect(tx.observedBalance?.amount).toBe('100.00');
    expect(tx.failureCode).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  test('markPendingReference (T097): sem referência resolvida, sem processedAt, updatedAt = at e nextAttemptAt copiado', () => {
    const tx = pending(Kind.Refund);
    const now = at();
    const next = new Date(now.getTime() + 5000);
    tx.markPendingReference(brl('42.00'), next, now);
    next.setTime(0); // mutar a data de entrada não altera a transação
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(now.getTime() + 5000);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.updatedAt.getTime()).toBe(now.getTime());
  });

  test('PENDING → FAILED com código; fail() a partir de PENDING funciona', () => {
    const tx = pending();
    tx.fail(FailureCode.InternalError, at());
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalError);
    expect(tx.isTerminal()).toBe(true);
  });

  test.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed('r', brl('1.00'), at()), Status.Processed],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.ReferenceRejected, brl('1.00'), at()), Status.Rejected],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.InternalError, at()), Status.Failed],
  ])('PENDING_REFERENCE → %s', (_label, transition, expected) => {
    const tx = pending(Kind.Refund);
    tx.markPendingReference(brl('1.00'), at(), at());
    transition(tx);
    expect(tx.status).toBe(expected);
  });

  test('PENDING_REFERENCE não volta a PENDING_REFERENCE pela transição de entrada (novas tentativas são do worker)', () => {
    const tx = pending(Kind.Refund);
    tx.markPendingReference(brl('1.00'), at(), at());
    expect(() => tx.markPendingReference(brl('1.00'), at(), at())).toThrow(InvalidTransactionStateError);
  });
});

describe('estados terminais nunca mudam (FR-028)', () => {
  const terminals: [string, (tx: WagerTransaction) => void][] = [
    ['PROCESSED', (tx) => tx.markProcessed(undefined, brl('1.00'), at())],
    ['REJECTED', (tx) => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), at())],
    ['FAILED', (tx) => tx.fail(FailureCode.InternalError, at())],
  ];
  const attempts: [string, (tx: WagerTransaction) => void][] = [
    ['markProcessed', (tx) => tx.markProcessed(undefined, brl('1.00'), at())],
    ['reject', (tx) => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), at())],
    ['markPendingReference', (tx) => tx.markPendingReference(brl('1.00'), at(), at())],
    ['fail', (tx) => tx.fail(FailureCode.InternalError, at())],
  ];
  for (const [state, reach] of terminals) {
    for (const [name, attempt] of attempts) {
      test(`${state} → ${name} lança InvalidTransactionStateError`, () => {
        const tx = pending();
        reach(tx);
        expect(() => attempt(tx)).toThrow(InvalidTransactionStateError);
      });
    }
  }
});

describe('consultas de domínio (I-12)', () => {
  test('requiresReference: só REFUND e ROLLBACK', () => {
    expect(pending(Kind.Refund).requiresReference()).toBe(true);
    expect(pending(Kind.Rollback).requiresReference()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) expect(pending(kind).requiresReference()).toBe(false);
  });

  test('affectsBalance: false só em LOSS', () => {
    expect(pending(Kind.Loss).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) expect(pending(kind).affectsBalance()).toBe(true);
  });

  test('ledgerDirectionFor: BET → DEBIT; WIN e REFUND → CREDIT; ROLLBACK → inverso da referência', () => {
    expect(pending(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(pending(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(pending(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rollback = pending(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(pending(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(pending(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(pending(Kind.Refund))).toBe(LedgerDirection.Debit);
  });

  test('ledgerDirectionFor recusa LOSS, ROLLBACK sem referência e ROLLBACK de LOSS/ROLLBACK', () => {
    expect(() => pending(Kind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => pending(Kind.Rollback).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => pending(Kind.Rollback).ledgerDirectionFor(pending(Kind.Loss))).toThrow(InvalidTransactionStateError);
    expect(() => pending(Kind.Rollback).ledgerDirectionFor(pending(Kind.Rollback))).toThrow(InvalidTransactionStateError);
  });

  test('matchesPayload compara o payloadHash', () => {
    const tx = pending();
    expect(tx.matchesPayload(HASH)).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('rehydrate', () => {
  test('reconstrói qualquer estado persistido sem revalidar transições', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const tx = WagerTransaction.rehydrate({
      id: 't-1',
      providerId: 'provider-a',
      externalTransactionId: 'x',
      idempotencyKey: 'k',
      payloadHash: HASH,
      walletId: 'w',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Refund,
      money: brl('5.00'),
      referenceExternalTransactionId: 'b-1',
      referenceTransactionId: 'b-internal',
      status: Status.Rejected,
      failureCode: FailureCode.AlreadyReversed,
      observedBalance: brl('7.00'),
      correlationId: 'c',
      referenceAttempts: 3,
      nextReferenceAttemptAt: createdAt,
      createdAt,
      processedAt: undefined,
      updatedAt: createdAt,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(tx.referenceTransactionId).toBe('b-internal');
    expect(tx.referenceAttempts).toBe(3);
    expect(tx.observedBalance?.amount).toBe('7.00');
    expect(() => tx.markProcessed(undefined, brl('1.00'), at())).toThrow(InvalidTransactionStateError);
  });
});

// ---- feature 002 (T008; I-11, I-67)

describe('scheduleNextReferenceAttempt e saída de PENDING_REFERENCE', () => {
  const pendingReference = (attemptsBefore = 0) => {
    const tx = pending(Kind.Refund);
    tx.markPendingReference(brl('100.00'), new Date(at().getTime() + 5000), at());
    for (let i = 0; i < attemptsBefore; i++) tx.scheduleNextReferenceAttempt(new Date(at().getTime() + 10_000), at());
    return tx;
  };

  test('a partir de PENDING_REFERENCE: incrementa attempts, define a próxima hora e mantém o status', () => {
    const tx = pendingReference();
    const next = new Date(at().getTime() + 10_000);
    const when = new Date(at().getTime() + 1);
    tx.scheduleNextReferenceAttempt(next, when);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(next.getTime());
    expect(tx.updatedAt.getTime()).toBe(when.getTime());
    tx.scheduleNextReferenceAttempt(new Date(next.getTime() + 20_000), when);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.observedBalance?.amount).toBe('100.00');
  });

  test('copia a data recebida', () => {
    const tx = pendingReference();
    const next = new Date(at().getTime() + 10_000);
    tx.scheduleNextReferenceAttempt(next, at());
    next.setTime(0);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(at().getTime() + 10_000);
  });

  test('em PENDING, PROCESSED, REJECTED ou FAILED lança InvalidTransactionStateError', () => {
    const next = new Date(at().getTime() + 10_000);
    expect(() => pending(Kind.Refund).scheduleNextReferenceAttempt(next, at())).toThrow(InvalidTransactionStateError);
    const processed = pending(Kind.Win);
    processed.markProcessed(undefined, brl('1.00'), at());
    expect(() => processed.scheduleNextReferenceAttempt(next, at())).toThrow(InvalidTransactionStateError);
    const rejected = pending();
    rejected.reject(FailureCode.InsufficientFunds, brl('1.00'), at());
    expect(() => rejected.scheduleNextReferenceAttempt(next, at())).toThrow(InvalidTransactionStateError);
    const failed = pendingReference();
    failed.fail(FailureCode.InternalError, at());
    expect(() => failed.scheduleNextReferenceAttempt(next, at())).toThrow(InvalidTransactionStateError);
  });

  test('markProcessed a partir de PENDING_REFERENCE: próxima tentativa nula, attempts preservado, saldo e referência reescritos (I-67)', () => {
    const tx = pendingReference(3);
    const correlationId = tx.correlationId;
    tx.markProcessed('bet-internal-id', brl('125.00'), at());
    expect(tx.status).toBe(Status.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.referenceAttempts).toBe(3);
    expect(tx.observedBalance?.amount).toBe('125.00');
    expect(tx.referenceTransactionId).toBe('bet-internal-id');
    expect(tx.correlationId).toBe(correlationId);
  });

  test('reject a partir de PENDING_REFERENCE: próxima tentativa nula, attempts preservado', () => {
    const tx = pendingReference(2);
    tx.reject(FailureCode.ReferenceNotFound, brl('100.00'), at());
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.correlationId).toBe('corr-1');
  });

  test('fail a partir de PENDING_REFERENCE: próxima tentativa nula, attempts preservado', () => {
    const tx = pendingReference(1);
    tx.fail(FailureCode.InternalError, at());
    expect(tx.status).toBe(Status.Failed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.correlationId).toBe('corr-1');
  });
});
