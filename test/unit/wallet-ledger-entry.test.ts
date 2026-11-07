// T049 — WalletLedgerEntry imutável (enunciado §6.4, FR-029).
import { describe, expect, test } from 'bun:test';
import { WalletLedgerEntry } from '../../src/wallets/domain/wallet-ledger-entry.ts';
import { LedgerDirection } from '../../src/wallets/domain/ledger-direction.ts';
import { Money } from '../../src/shared-kernel/domain/money.ts';
import { InvalidLedgerEntryError } from '../../src/shared-kernel/domain/errors.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-11-07T12:00:00.000Z');

function props(overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) {
  return {
    id: 'e-1',
    walletId: 'w-1',
    transactionId: 't-1',
    direction: LedgerDirection.Credit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('125.00'),
    createdAt: at,
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  test('aceita CREDIT com before + money = after', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.amount).toBe('125.00');
  });

  test('aceita DEBIT com before - money = after, inclusive chegando a 0.00', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Debit, money: brl('100.00'), balanceBefore: brl('100.00'), balanceAfter: brl('0.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test.each([
    ['aritmética de CREDIT errada', { balanceAfter: brl('124.99') }],
    ['aritmética de DEBIT errada', { direction: LedgerDirection.Debit, balanceAfter: brl('125.00') }],
    ['money zero', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    [
      'saldo depois negativo',
      { direction: LedgerDirection.Debit, money: brl('25.00'), balanceBefore: brl('10.00'), balanceAfter: brl('10.00').subtract(brl('25.00')) },
    ],
    ['saldo antes negativo', { balanceBefore: brl('0.00').subtract(brl('1.00')), money: brl('1.00'), balanceAfter: brl('0.00') }],
    ['moeda do valor diferente', { money: usd('25.00') }],
    ['moeda do saldo depois diferente', { balanceAfter: usd('125.00') }],
    ['direção inválida', { direction: 'SIDEWAYS' as LedgerDirection }],
  ])('recusa %s com InvalidLedgerEntryError', (_label, override) => {
    expect(() => WalletLedgerEntry.create(props(override))).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry é estruturalmente imutável', () => {
  test('todos os campos são readonly: a instância é congelada e atribuições lançam', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('1.00');
    }).toThrow(TypeError);
    expect(entry.balanceAfter.amount).toBe('125.00');
  });

  test('rehydrate reconstrói sem revalidar; isBalanced revela a inconsistência', () => {
    const entry = WalletLedgerEntry.rehydrate({ ...props(), balanceAfter: brl('999.00') });
    expect(entry.balanceAfter.amount).toBe('999.00');
    expect(entry.isBalanced()).toBe(false);
  });
});
