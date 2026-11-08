// T065 — WagerRulesService, parte da US2 (I-44 passos 5.1 e 5.5; FR-014 a FR-016, FR-027, FR-061, I-18, I-19, I-54).
import { describe, expect, test } from 'bun:test';
import { WagerRulesService } from '../../src/wagering/domain/wager-rules.service.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/wagering/domain/wager-transaction.ts';
import { LedgerDirection } from '../../src/wallets/domain/ledger-direction.ts';
import { Wallet } from '../../src/wallets/domain/wallet.ts';
import { Money } from '../../src/shared-kernel/domain/money.ts';
import { FixedClock, SequentialIdGenerator } from '../support/fakes.ts';

const ids = new SequentialIdGenerator();
const clock = new FixedClock();
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const rules = new WagerRulesService();

function wallet(balance: string, playerId = 'player-1', currency = 'BRL'): Wallet {
  return Wallet.open({ id: ids.next(), playerId, initialBalance: money(balance, currency), at: clock.now() });
}

interface TxOverrides {
  playerId?: string;
  currency?: string;
  walletId?: string;
  roundId?: string;
  referenceExternalTransactionId?: string;
}

function tx(kind: Kind, target: Wallet, amount: string, overrides: TxOverrides = {}): WagerTransaction {
  return WagerTransaction.create({
    id: ids.next(),
    providerId: 'provider-a',
    externalTransactionId: `ext-${ids.next()}`,
    idempotencyKey: `k-${ids.next()}`,
    payloadHash: 'a'.repeat(64),
    walletId: overrides.walletId ?? target.id,
    playerId: overrides.playerId ?? target.playerId,
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'game-1',
    kind,
    money: money(amount, overrides.currency ?? target.currency),
    ...(overrides.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: overrides.referenceExternalTransactionId }
      : {}),
    correlationId: 'corr',
    createdAt: clock.now(),
  });
}

/**
 * Uma referência já gravada, no status pedido. REFUND e ROLLBACK precisam de uma referência própria para nascer
 * (I-13); o id externo dela é irrelevante para as regras, que recebem a referência já carregada.
 */
function ref(
  kind: Kind,
  target: Wallet,
  amount: string,
  status: Status = Status.Processed,
  overrides: TxOverrides = {},
): WagerTransaction {
  const needsReference = kind === Kind.Refund || kind === Kind.Rollback;
  const t = tx(kind, target, amount, {
    ...overrides,
    ...(needsReference ? { referenceExternalTransactionId: `ext-${ids.next()}` } : {}),
  });
  const observed = target.balance;
  switch (status) {
    case Status.Pending:
      break;
    case Status.Processed:
      t.markProcessed(needsReference ? ids.next() : undefined, observed, clock.now());
      break;
    case Status.Rejected:
      t.reject(FailureCode.InsufficientFunds, observed, clock.now());
      break;
    case Status.Failed:
      t.fail(FailureCode.InternalError, clock.now());
      break;
    case Status.PendingReference:
      t.markPendingReference(observed, clock.now(), clock.now());
      break;
  }
  return t;
}

/** Uma transação nova referenciando `reference` pelo id externo dela. */
function referencing(kind: Kind, target: Wallet, amount: string, reference: WagerTransaction, overrides: TxOverrides = {}) {
  return tx(kind, target, amount, { referenceExternalTransactionId: reference.externalTransactionId, ...overrides });
}

const decide = (w: Wallet, t: WagerTransaction) =>
  rules.decide({ wallet: w, transaction: t, reference: undefined, referenceAlreadyReversed: false });

const decideWith = (w: Wallet, t: WagerTransaction, reference: WagerTransaction | undefined, referenceAlreadyReversed = false) =>
  rules.decide({ wallet: w, transaction: t, reference, referenceAlreadyReversed });

const rejected = (code: FailureCode) => ({ type: 'REJECT' as const, code });

describe('passo 5.1: WALLET_PLAYER_MISMATCH e CURRENCY_MISMATCH (I-19)', () => {
  test('WALLET_PLAYER_MISMATCH prevalece sobre CURRENCY_MISMATCH e sobre o saldo', () => {
    const w = wallet('10.00');
    expect(decide(w, tx(Kind.Bet, w, '999.00', { playerId: 'intruder', currency: 'USD' }))).toEqual({
      type: 'REJECT',
      code: FailureCode.WalletPlayerMismatch,
    });
  });

  test('CURRENCY_MISMATCH prevalece sobre o saldo', () => {
    const w = wallet('10.00');
    expect(decide(w, tx(Kind.Bet, w, '999.00', { currency: 'USD' }))).toEqual({
      type: 'REJECT',
      code: FailureCode.CurrencyMismatch,
    });
  });

  test('playerId é comparado com caixa (I-58): "Player-1" não é dono da wallet de "player-1"', () => {
    const w = wallet('10.00', 'player-1');
    expect(decide(w, tx(Kind.Bet, w, '1.00', { playerId: 'Player-1' }))).toEqual({
      type: 'REJECT',
      code: FailureCode.WalletPlayerMismatch,
    });
  });
});

describe('passo 5.5: saldo (I-18, I-54)', () => {
  test('BET dentro do saldo → Apply(DEBIT), inclusive o saldo inteiro', () => {
    const w = wallet('100.00');
    expect(decide(w, tx(Kind.Bet, w, '25.00'))).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
    expect(decide(w, tx(Kind.Bet, w, '100.00'))).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  test('BET acima do saldo → Reject(INSUFFICIENT_FUNDS)', () => {
    const w = wallet('10.00');
    expect(decide(w, tx(Kind.Bet, w, '10.01'))).toEqual({ type: 'REJECT', code: FailureCode.InsufficientFunds });
  });

  test('crédito sem referência a partir de 9999999999999990.00: +10.00 → BALANCE_LIMIT_EXCEEDED; +9.99 → Apply(CREDIT)', () => {
    const w = wallet('9999999999999990.00');
    expect(decide(w, tx(Kind.Win, w, '10.00'))).toEqual({ type: 'REJECT', code: FailureCode.BalanceLimitExceeded });
    expect(decide(w, tx(Kind.Win, w, '9.99'))).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  test('WIN sem referência → Apply(CREDIT)', () => {
    const w = wallet('0.00');
    expect(decide(w, tx(Kind.Win, w, '50.00'))).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });
});

describe('a decisão é pura', () => {
  test('não altera a wallet nem a transação e é determinística', () => {
    const w = wallet('10.00');
    const bet = tx(Kind.Bet, w, '5.00');
    const first = decide(w, bet);
    const second = decide(w, bet);
    expect(second).toEqual(first);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
    expect(bet.status).toBe(Status.Pending);
  });
});

// T087 — WIN e LOSS (US4; I-12, I-13, I-14, I-46; FR-017, FR-018, FR-021, FR-022).
describe('US4: WIN e LOSS', () => {
  test('LOSS → Apply sem direção (sem lançamento), com e sem referência, inclusive "0.00"', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00');
    expect(decide(w, tx(Kind.Loss, w, '25.00'))).toEqual({ type: 'APPLY' });
    expect(decide(w, tx(Kind.Loss, w, '0.00'))).toEqual({ type: 'APPLY' });
    expect(decideWith(w, referencing(Kind.Loss, w, '25.00', bet), bet)).toEqual({ type: 'APPLY' });
  });

  test('LOSS não depende do saldo: wallet zerada ainda aplica', () => {
    const w = wallet('0.00');
    expect(decide(w, tx(Kind.Loss, w, '999.00'))).toEqual({ type: 'APPLY' });
  });

  test('WIN → Apply(CREDIT), com e sem referência a uma BET PROCESSED', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00');
    expect(decide(w, tx(Kind.Win, w, '50.00'))).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
    expect(decideWith(w, referencing(Kind.Win, w, '50.00', bet), bet)).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Credit,
    });
  });

  test('WIN e LOSS não exigem o mesmo valor da BET (AMOUNT_MISMATCH é só de reversão)', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00');
    expect(decideWith(w, referencing(Kind.Win, w, '80.00', bet), bet)).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
    expect(decideWith(w, referencing(Kind.Loss, w, '1.00', bet), bet)).toEqual({ type: 'APPLY' });
  });

  describe('REFERENCE_MISMATCH: rodada, jogador, wallet ou moeda diferente (I-14, I-46)', () => {
    for (const kind of [Kind.Win, Kind.Loss]) {
      test(`${kind} referenciando BET de outra rodada`, () => {
        const w = wallet('100.00');
        const bet = ref(Kind.Bet, w, '25.00', Status.Processed, { roundId: 'round-1' });
        expect(decideWith(w, referencing(kind, w, '25.00', bet, { roundId: 'round-2' }), bet)).toEqual(
          rejected(FailureCode.ReferenceMismatch),
        );
      });

      test(`${kind} referenciando BET de outro jogador`, () => {
        const w = wallet('100.00');
        const bet = ref(Kind.Bet, w, '25.00', Status.Processed, { playerId: 'someone-else' });
        expect(decideWith(w, referencing(kind, w, '25.00', bet), bet)).toEqual(rejected(FailureCode.ReferenceMismatch));
      });

      test(`${kind} referenciando BET de outra wallet do mesmo jogador e moeda`, () => {
        const w = wallet('100.00');
        const bet = ref(Kind.Bet, w, '25.00', Status.Processed, { walletId: ids.next() });
        expect(decideWith(w, referencing(kind, w, '25.00', bet), bet)).toEqual(rejected(FailureCode.ReferenceMismatch));
      });

      test(`${kind} referenciando BET em outra moeda`, () => {
        const w = wallet('100.00');
        const bet = ref(Kind.Bet, w, '25.00', Status.Processed, { currency: 'USD' });
        expect(decideWith(w, referencing(kind, w, '25.00', bet), bet)).toEqual(rejected(FailureCode.ReferenceMismatch));
      });
    }
  });

  describe('INVALID_REFERENCE_KIND: WIN e LOSS só referenciam BET (I-13, I-46)', () => {
    for (const kind of [Kind.Win, Kind.Loss]) {
      for (const referenceKind of [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]) {
        test(`${kind} referenciando ${referenceKind}`, () => {
          const w = wallet('100.00');
          const reference = ref(referenceKind, w, '25.00');
          expect(decideWith(w, referencing(kind, w, '25.00', reference), reference)).toEqual(
            rejected(FailureCode.InvalidReferenceKind),
          );
        });
      }
    }
  });

  test('REFERENCE_MISMATCH prevalece sobre INVALID_REFERENCE_KIND', () => {
    const w = wallet('100.00');
    const win = ref(Kind.Win, w, '25.00', Status.Processed, { roundId: 'round-1' });
    expect(decideWith(w, referencing(Kind.Loss, w, '25.00', win, { roundId: 'round-2' }), win)).toEqual(
      rejected(FailureCode.ReferenceMismatch),
    );
  });

  test('WALLET_PLAYER_MISMATCH e CURRENCY_MISMATCH prevalecem sobre a referência', () => {
    const w = wallet('100.00');
    const win = ref(Kind.Win, w, '25.00', Status.Processed, { roundId: 'round-1' });
    expect(decideWith(w, referencing(Kind.Loss, w, '25.00', win, { playerId: 'intruder', roundId: 'round-2' }), win)).toEqual(
      rejected(FailureCode.WalletPlayerMismatch),
    );
    expect(decideWith(w, referencing(Kind.Loss, w, '25.00', win, { currency: 'USD', roundId: 'round-2' }), win)).toEqual(
      rejected(FailureCode.CurrencyMismatch),
    );
  });

  test('WIN com referência válida ainda respeita o teto de saldo (BALANCE_LIMIT_EXCEEDED)', () => {
    const w = wallet('9999999999999990.00');
    const bet = ref(Kind.Bet, w, '1.00');
    expect(decideWith(w, referencing(Kind.Win, w, '10.00', bet), bet)).toEqual(rejected(FailureCode.BalanceLimitExceeded));
  });
});

/**
 * Uma abertura PROCESSED com o mesmo escopo da transação nova. Pela API ela nunca é alcançável (o provider "system"
 * é recusado na entrada, I-07), mas a regra de tipo existe no domínio e é testada aqui via rehydrate.
 */
function openingInScope(target: Wallet, amount: string): WagerTransaction {
  const base = tx(Kind.Win, target, amount);
  return WagerTransaction.rehydrate({
    id: base.id,
    providerId: base.providerId,
    externalTransactionId: base.externalTransactionId,
    idempotencyKey: base.idempotencyKey,
    payloadHash: base.payloadHash,
    walletId: base.walletId,
    playerId: base.playerId,
    roundId: base.roundId,
    gameId: base.gameId,
    kind: Kind.Opening,
    money: base.money,
    referenceExternalTransactionId: undefined,
    referenceTransactionId: undefined,
    correlationId: base.correlationId,
    createdAt: clock.now(),
    status: Status.Processed,
    failureCode: undefined,
    observedBalance: target.balance,
    referenceAttempts: 0,
    nextReferenceAttemptAt: undefined,
    processedAt: clock.now(),
    updatedAt: clock.now(),
  });
}

// T091 — REFUND e ROLLBACK (US5; I-12, I-14 a I-18, I-44; FR-019 a FR-026).
describe('US5: reversões', () => {
  test('REFUND de BET PROCESSED → Apply(CREDIT)', () => {
    const w = wallet('75.00');
    const bet = ref(Kind.Bet, w, '25.00');
    expect(decideWith(w, referencing(Kind.Refund, w, '25.00', bet), bet)).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  test('ROLLBACK de BET → CREDIT; de WIN → DEBIT; de REFUND → DEBIT', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00');
    const win = ref(Kind.Win, w, '50.00');
    const refund = ref(Kind.Refund, w, '25.00');
    expect(decideWith(w, referencing(Kind.Rollback, w, '25.00', bet), bet)).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
    expect(decideWith(w, referencing(Kind.Rollback, w, '50.00', win), win)).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
    expect(decideWith(w, referencing(Kind.Rollback, w, '25.00', refund), refund)).toEqual({
      type: 'APPLY',
      direction: LedgerDirection.Debit,
    });
  });

  describe('INVALID_REFERENCE_KIND (I-14)', () => {
    for (const referenceKind of [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]) {
      test(`REFUND de ${referenceKind}`, () => {
        const w = wallet('100.00');
        const reference = ref(referenceKind, w, '25.00');
        expect(decideWith(w, referencing(Kind.Refund, w, '25.00', reference), reference)).toEqual(
          rejected(FailureCode.InvalidReferenceKind),
        );
      });
    }
    for (const referenceKind of [Kind.Loss, Kind.Rollback]) {
      test(`ROLLBACK de ${referenceKind}`, () => {
        const w = wallet('100.00');
        const reference = ref(referenceKind, w, '25.00');
        expect(decideWith(w, referencing(Kind.Rollback, w, '25.00', reference), reference)).toEqual(
          rejected(FailureCode.InvalidReferenceKind),
        );
      });
    }
    test('ROLLBACK e REFUND de OPENING (regra de domínio)', () => {
      const w = wallet('100.00');
      const opening = openingInScope(w, '100.00');
      expect(decideWith(w, referencing(Kind.Rollback, w, '100.00', opening), opening)).toEqual(
        rejected(FailureCode.InvalidReferenceKind),
      );
      expect(decideWith(w, referencing(Kind.Refund, w, '100.00', opening), opening)).toEqual(
        rejected(FailureCode.InvalidReferenceKind),
      );
    });
  });

  test('REFERENCE_MISMATCH também vale para reversões (rodada diferente)', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00', Status.Processed, { roundId: 'round-1' });
    expect(decideWith(w, referencing(Kind.Refund, w, '25.00', bet, { roundId: 'round-9' }), bet)).toEqual(
      rejected(FailureCode.ReferenceMismatch),
    );
  });

  test('valor diferente do da referência → AMOUNT_MISMATCH (I-17), para REFUND e ROLLBACK', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00');
    expect(decideWith(w, referencing(Kind.Refund, w, '20.00', bet), bet)).toEqual(rejected(FailureCode.AmountMismatch));
    expect(decideWith(w, referencing(Kind.Rollback, w, '25.01', bet), bet)).toEqual(rejected(FailureCode.AmountMismatch));
  });

  test('referência REJECTED ou FAILED → REFERENCE_REJECTED (I-15), inclusive para WIN e LOSS (I-46)', () => {
    const w = wallet('100.00');
    for (const status of [Status.Rejected, Status.Failed]) {
      const bet = ref(Kind.Bet, w, '25.00', status);
      expect(decideWith(w, referencing(Kind.Refund, w, '25.00', bet), bet)).toEqual(rejected(FailureCode.ReferenceRejected));
      expect(decideWith(w, referencing(Kind.Rollback, w, '25.00', bet), bet)).toEqual(rejected(FailureCode.ReferenceRejected));
      expect(decideWith(w, referencing(Kind.Win, w, '25.00', bet), bet)).toEqual(rejected(FailureCode.ReferenceRejected));
      expect(decideWith(w, referencing(Kind.Loss, w, '25.00', bet), bet)).toEqual(rejected(FailureCode.ReferenceRejected));
    }
  });

  test('referenceAlreadyReversed → ALREADY_REVERSED (I-16), para REFUND e ROLLBACK', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00');
    expect(decideWith(w, referencing(Kind.Refund, w, '25.00', bet), bet, true)).toEqual(rejected(FailureCode.AlreadyReversed));
    expect(decideWith(w, referencing(Kind.Rollback, w, '25.00', bet), bet, true)).toEqual(rejected(FailureCode.AlreadyReversed));
  });

  test('referenceAlreadyReversed não afeta WIN nem LOSS (só reversões têm unicidade, I-46)', () => {
    const w = wallet('100.00');
    const bet = ref(Kind.Bet, w, '25.00');
    expect(decideWith(w, referencing(Kind.Win, w, '25.00', bet), bet, true)).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
    expect(decideWith(w, referencing(Kind.Loss, w, '25.00', bet), bet, true)).toEqual({ type: 'APPLY' });
  });

  test('ROLLBACK de WIN ou de REFUND acima do saldo → REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS (I-18)', () => {
    const w = wallet('30.00');
    const win = ref(Kind.Win, w, '50.00');
    const refund = ref(Kind.Refund, w, '50.00');
    expect(decideWith(w, referencing(Kind.Rollback, w, '50.00', win), win)).toEqual(rejected(FailureCode.ReversalWouldOverdraw));
    expect(decideWith(w, referencing(Kind.Rollback, w, '50.00', refund), refund)).toEqual(rejected(FailureCode.ReversalWouldOverdraw));
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
  });

  test('ROLLBACK de WIN igual ao saldo → aplica e zera', () => {
    const w = wallet('50.00');
    const win = ref(Kind.Win, w, '50.00');
    expect(decideWith(w, referencing(Kind.Rollback, w, '50.00', win), win)).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  test('REFUND e ROLLBACK de BET que passariam do teto → BALANCE_LIMIT_EXCEEDED (I-54)', () => {
    const w = wallet('9999999999999990.00');
    const bet = ref(Kind.Bet, w, '10.00');
    expect(decideWith(w, referencing(Kind.Refund, w, '10.00', bet), bet)).toEqual(rejected(FailureCode.BalanceLimitExceeded));
    expect(decideWith(w, referencing(Kind.Rollback, w, '10.00', bet), bet)).toEqual(rejected(FailureCode.BalanceLimitExceeded));
  });

  describe('precedência do I-44: MISMATCH > KIND > AMOUNT > REJECTED > ALREADY_REVERSED > saldo', () => {
    // Cada caso viola a regra testada e todas as seguintes; só a primeira define o resultado.
    test('REFERENCE_MISMATCH vence tipo, valor, estado, reversão e saldo', () => {
      const w = wallet('0.00');
      const win = ref(Kind.Win, w, '50.00', Status.Rejected, { roundId: 'round-1' });
      const t = referencing(Kind.Refund, w, '99.00', win, { roundId: 'round-2' });
      expect(decideWith(w, t, win, true)).toEqual(rejected(FailureCode.ReferenceMismatch));
    });

    test('INVALID_REFERENCE_KIND vence valor, estado, reversão e saldo', () => {
      const w = wallet('0.00');
      const win = ref(Kind.Win, w, '50.00', Status.Rejected);
      expect(decideWith(w, referencing(Kind.Refund, w, '99.00', win), win, true)).toEqual(rejected(FailureCode.InvalidReferenceKind));
    });

    test('AMOUNT_MISMATCH vence estado, reversão e saldo', () => {
      const w = wallet('0.00');
      const win = ref(Kind.Win, w, '50.00', Status.Rejected);
      expect(decideWith(w, referencing(Kind.Rollback, w, '99.00', win), win, true)).toEqual(rejected(FailureCode.AmountMismatch));
    });

    test('REFERENCE_REJECTED vence reversão e saldo', () => {
      const w = wallet('0.00');
      const win = ref(Kind.Win, w, '50.00', Status.Rejected);
      expect(decideWith(w, referencing(Kind.Rollback, w, '50.00', win), win, true)).toEqual(rejected(FailureCode.ReferenceRejected));
    });

    test('ALREADY_REVERSED vence o saldo', () => {
      const w = wallet('0.00');
      const win = ref(Kind.Win, w, '50.00');
      expect(decideWith(w, referencing(Kind.Rollback, w, '50.00', win), win, true)).toEqual(rejected(FailureCode.AlreadyReversed));
    });

    test('por último, o saldo', () => {
      const w = wallet('0.00');
      const win = ref(Kind.Win, w, '50.00');
      expect(decideWith(w, referencing(Kind.Rollback, w, '50.00', win), win)).toEqual(rejected(FailureCode.ReversalWouldOverdraw));
    });
  });
});
