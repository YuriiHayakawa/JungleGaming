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
