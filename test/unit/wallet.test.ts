// T048 — Wallet, aggregate root (FR-005, FR-009, FR-039, I-06, I-54; enunciado §6.2).
import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../src/wallets/domain/wallet.ts';
import { LedgerDirection } from '../../src/wallets/domain/ledger-direction.ts';
import { WalletLedgerEntry } from '../../src/wallets/domain/wallet-ledger-entry.ts';
import { Money } from '../../src/shared-kernel/domain/money.ts';
import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  DomainError,
  InsufficientBalanceError,
  InvalidLedgerEntryError,
} from '../../src/shared-kernel/domain/errors.ts';
import { FixedClock, SequentialIdGenerator } from '../support/fakes.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const ids = new SequentialIdGenerator();
const clock = new FixedClock();

function openWallet(balance = '100.00'): Wallet {
  return Wallet.open({ id: ids.next(), playerId: 'player-1', initialBalance: brl(balance), at: clock.now() });
}

describe('Wallet.open (I-06)', () => {
  test('nasce com version 1, o saldo inicial, a moeda do saldo e as datas do relógio', () => {
    const at = clock.now();
    const id = ids.next();
    const wallet = Wallet.open({ id, playerId: 'player-1', initialBalance: brl('1000.00'), at });
    expect(wallet.id).toBe(id);
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.getTime()).toBe(at.getTime());
    expect(wallet.updatedAt.getTime()).toBe(at.getTime());
  });

  test('saldo inicial 0.00 é aceito', () => {
    const wallet = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('playerId vazio ou com mais de 255 caracteres é recusado (I-50)', () => {
    for (const playerId of ['', 'x'.repeat(256)]) {
      expect(() => Wallet.open({ id: ids.next(), playerId, initialBalance: brl('1.00'), at: clock.now() })).toThrow(
        DomainError,
      );
    }
    expect(Wallet.open({ id: ids.next(), playerId: 'x'.repeat(255), initialBalance: brl('1.00'), at: clock.now() })).toBeDefined();
  });
});

describe('Wallet.debit e Wallet.credit (FR-009, FR-029)', () => {
  test('debit devolve o lançamento DEBIT coerente e incrementa version em 1', () => {
    const wallet = openWallet('100.00');
    const at = new Date('2026-11-07T13:00:00.000Z');
    const entryId = ids.next();
    const transactionId = ids.next();
    const entry = wallet.debit(brl('25.00'), entryId, transactionId, at);
    expect(entry).toBeInstanceOf(WalletLedgerEntry);
    expect(entry.id).toBe(entryId);
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe(transactionId);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.equals(brl('25.00'))).toBe(true);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('75.00'))).toBe(true);
    expect(entry.createdAt.getTime()).toBe(at.getTime());
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBe(at.getTime());
  });

  test('credit devolve o lançamento CREDIT coerente e incrementa version em 1', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(brl('50.50'), ids.next(), ids.next(), clock.now());
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('150.50'))).toBe(true);
    expect(wallet.balance.equals(brl('150.50'))).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('operações sucessivas incrementam version uma vez por movimento e encadeiam os lançamentos', () => {
    const wallet = openWallet('100.00');
    const first = wallet.debit(brl('10.00'), ids.next(), ids.next(), clock.now());
    const second = wallet.credit(brl('5.00'), ids.next(), ids.next(), clock.now());
    expect(second.balanceBefore.equals(first.balanceAfter)).toBe(true);
    expect(wallet.version).toBe(3);
    expect(wallet.balance.equals(brl('95.00'))).toBe(true);
  });

  test('débito do saldo inteiro deixa 0.00', () => {
    const wallet = openWallet('80.00');
    wallet.debit(brl('80.00'), ids.next(), ids.next(), clock.now());
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('débito que deixaria o saldo negativo lança InsufficientBalanceError e não altera nada (FR-039)', () => {
    const wallet = openWallet('10.00');
    expect(() => wallet.debit(brl('10.01'), ids.next(), ids.next(), clock.now())).toThrow(InsufficientBalanceError);
    expect(wallet.balance.equals(brl('10.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('crédito acima de 9999999999999999.99 lança BalanceLimitExceededError e não altera nada (I-54)', () => {
    const wallet = openWallet('9999999999999990.00');
    expect(() => wallet.credit(brl('10.00'), ids.next(), ids.next(), clock.now())).toThrow(BalanceLimitExceededError);
    expect(wallet.balance.equals(brl('9999999999999990.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    wallet.credit(brl('9.99'), ids.next(), ids.next(), clock.now());
    expect(wallet.balance.amount).toBe('9999999999999999.99');
  });

  test('moeda diferente da wallet lança CurrencyMismatchError em debit e credit, sem alterar nada', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(usd('1.00'), ids.next(), ids.next(), clock.now())).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd('1.00'), ids.next(), ids.next(), clock.now())).toThrow(CurrencyMismatchError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('valor zero não gera movimento (lançamento exige money > 0)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('0.00'), ids.next(), ids.next(), clock.now())).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.credit(brl('0.00'), ids.next(), ids.next(), clock.now())).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar regras', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-02-01T00:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt,
      updatedAt,
    });
    expect(wallet.id).toBe('w-1');
    expect(wallet.playerId).toBe('p-1');
    expect(wallet.balance.equals(brl('42.00'))).toBe(true);
    expect(wallet.version).toBe(17);
    expect(wallet.createdAt.getTime()).toBe(createdAt.getTime());
    expect(wallet.updatedAt.getTime()).toBe(updatedAt.getTime());
  });
});
