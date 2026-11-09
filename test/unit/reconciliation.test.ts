// T011 — comparação da reconciliação como função pura (R-37; FR-004 a FR-007; data-model §1).
import { describe, expect, test } from 'bun:test';
import { reconcile, type ReconciliationInput } from '../../src/reconciliation/domain/reconciliation.ts';
import { CurrencyMismatchError } from '../../src/shared-kernel/domain/errors.ts';
import { Money } from '../../src/shared-kernel/domain/money.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const negativeBrl = (amount: string) => brl(amount).negate();
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

function input(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    walletId: WALLET,
    storedBalance: brl('975.00'),
    calculatedBalance: brl('975.00'),
    checkedEntries: 42,
    lastSeq: 1900,
    lastBalanceAfter: brl('975.00'),
    ...overrides,
  };
}

const json = (result: ReturnType<typeof reconcile>) => ({
  storedBalance: result.storedBalance.toJSON(),
  calculatedBalance: result.calculatedBalance.toJSON(),
  difference: result.difference.toJSON(),
});

describe('reconcile', () => {
  test('wallet consistente: difference 0.00, cadeia íntegra, sem firstBrokenSeq', () => {
    const result = reconcile(input());
    expect(result.walletId).toBe(WALLET);
    expect(json(result)).toEqual({
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
    });
    expect(result.checkedEntries).toBe(42);
    expect(result.chainConsistent).toBe(true);
    expect(result.firstBrokenSeq).toBeUndefined();
    expect('firstBrokenSeq' in result).toBe(false);
    expect(result.consistent).toBe(true);
  });

  test('sem lançamentos e saldo 0.00: consistente, checkedEntries 0, cadeia íntegra por vacuidade', () => {
    const result = reconcile({ walletId: WALLET, storedBalance: brl('0.00'), calculatedBalance: brl('0'), checkedEntries: 0 });
    expect(json(result).calculatedBalance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.checkedEntries).toBe(0);
    expect(result.chainConsistent).toBe(true);
    expect(result.consistent).toBe(true);
  });

  test('sem lançamentos e saldo ≠ 0: inconsistente pela diferença, cadeia íntegra', () => {
    const result = reconcile({ walletId: WALLET, storedBalance: brl('10.00'), calculatedBalance: brl('0'), checkedEntries: 0 });
    expect(json(result).difference).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(result.chainConsistent).toBe(true);
    expect(result.firstBrokenSeq).toBeUndefined();
    expect(result.consistent).toBe(false);
  });

  test('diferença positiva: stored − calculated, com sinal', () => {
    const result = reconcile(input({ storedBalance: brl('990.00'), lastBalanceAfter: brl('975.00') }));
    expect(json(result).difference).toEqual({ amount: '15.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
  });

  test('diferença negativa: stored − calculated, com sinal', () => {
    const result = reconcile(input({ storedBalance: brl('960.00'), lastBalanceAfter: brl('975.00') }));
    expect(json(result).difference).toEqual({ amount: '-15.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
  });

  test('saldo recalculado negativo (ledger adulterado): diferença com sinal', () => {
    const result = reconcile(input({ storedBalance: brl('0.00'), calculatedBalance: negativeBrl('50.00'), lastBalanceAfter: brl('0.00') }));
    expect(json(result).calculatedBalance).toEqual({ amount: '-50.00', currency: 'BRL' });
    expect(json(result).difference).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
  });

  test('elo quebrado no primeiro lançamento (before ≠ 0): firstBrokenSeq desse lançamento', () => {
    const result = reconcile(input({ firstBrokenLinkSeq: 7 }));
    expect(result.chainConsistent).toBe(false);
    expect(result.firstBrokenSeq).toBe(7);
    expect(result.consistent).toBe(false);
  });

  test('elo quebrado no meio: firstBrokenSeq é o menor seq quebrado informado', () => {
    const result = reconcile(input({ firstBrokenLinkSeq: 1500 }));
    expect(result.firstBrokenSeq).toBe(1500);
    expect(result.chainConsistent).toBe(false);
  });

  test('cauda quebrada (after do último ≠ stored): firstBrokenSeq = último seq', () => {
    const result = reconcile(input({ lastBalanceAfter: brl('970.00') }));
    expect(result.chainConsistent).toBe(false);
    expect(result.firstBrokenSeq).toBe(1900);
    expect(result.consistent).toBe(false);
  });

  test('elo e cauda quebrados: vale o elo (o menor seq)', () => {
    const result = reconcile(input({ firstBrokenLinkSeq: 100, lastBalanceAfter: brl('970.00') }));
    expect(result.firstBrokenSeq).toBe(100);
  });

  test('soma certa com cadeia quebrada: difference 0.00 e consistent false', () => {
    const result = reconcile(input({ firstBrokenLinkSeq: 1201 }));
    expect(json(result).difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.chainConsistent).toBe(false);
    expect(result.consistent).toBe(false);
  });

  test('consistent só com as duas condições (difference zero E chainConsistent)', () => {
    const cases: Array<[Partial<ReconciliationInput>, boolean]> = [
      [{}, true],
      [{ storedBalance: brl('1.00'), lastBalanceAfter: brl('1.00') }, false], // só diferença
      [{ firstBrokenLinkSeq: 3 }, false], // só cadeia
      [{ storedBalance: brl('1.00'), firstBrokenLinkSeq: 3 }, false], // as duas
    ];
    for (const [overrides, consistent] of cases) expect(reconcile(input(overrides)).consistent).toBe(consistent);
  });

  test('moedas diferentes entre os campos são recusadas (erro de programação)', () => {
    const usd = Money.from({ amount: '975.00', currency: 'USD' });
    expect(() => reconcile(input({ calculatedBalance: usd }))).toThrow(CurrencyMismatchError);
    expect(() => reconcile(input({ lastBalanceAfter: usd }))).toThrow(CurrencyMismatchError);
  });

  test('entrada incoerente é recusada: lançamentos sem último seq, ou vazio com último seq', () => {
    expect(() => reconcile(input({ lastSeq: undefined }))).toThrow();
    expect(() => reconcile(input({ lastBalanceAfter: undefined }))).toThrow();
    expect(() => reconcile({ walletId: WALLET, storedBalance: brl('0'), calculatedBalance: brl('0'), checkedEntries: 0, lastSeq: 1 })).toThrow();
    expect(() => reconcile(input({ checkedEntries: -1 }))).toThrow();
    expect(() => reconcile(input({ checkedEntries: 1.5 }))).toThrow();
  });

  test('nenhum valor monetário vira number: Money no resultado e strings no JSON', () => {
    const result = reconcile(input({ storedBalance: brl('960.00'), lastBalanceAfter: brl('960.00') }));
    for (const value of [result.storedBalance, result.calculatedBalance, result.difference]) {
      expect(value).toBeInstanceOf(Money);
      expect(typeof value.toJSON().amount).toBe('string');
    }
  });
});
