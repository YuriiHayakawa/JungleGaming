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

function tx(
  kind: Kind,
  target: Wallet,
  amount: string,
  overrides: { playerId?: string; currency?: string } = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: ids.next(),
    providerId: 'provider-a',
    externalTransactionId: `ext-${ids.next()}`,
    idempotencyKey: `k-${ids.next()}`,
    payloadHash: 'a'.repeat(64),
    walletId: target.id,
    playerId: overrides.playerId ?? target.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: money(amount, overrides.currency ?? target.currency),
    correlationId: 'corr',
    createdAt: clock.now(),
  });
}

const decide = (w: Wallet, t: WagerTransaction) =>
  rules.decide({ wallet: w, transaction: t, reference: undefined, referenceAlreadyReversed: false });

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
