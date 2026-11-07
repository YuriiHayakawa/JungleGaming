// T008 — Money (FR-001 a FR-004, I-01, I-03, I-05, research R-03).
import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared-kernel/domain/money.ts';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared-kernel/domain/errors.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from: entradas válidas e normalização (I-01)', () => {
  test.each([
    ['0', '0.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.50', '25.50'],
    ['0.10', '0.10'],
    ['9999999999999999.99', '9999999999999999.99'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });
});

describe('Money.from: entradas inválidas (I-01, I-03)', () => {
  test.each(['25.001', '-1', ' 1', '1 ', '1e3', 'NaN', 'Infinity', '', '01', '1.', '.5', '+1', '10000000000000000.00'])(
    '"%s" → InvalidMoneyError',
    (input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    },
  );

  test('acima de 9999999999999999.99 é recusado (I-03)', () => {
    expect(() => brl('10000000000000000')).toThrow(InvalidMoneyError);
  });

  test('amount não-string (número JSON) é recusado', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', 'B1L'])('moeda "%s" fora de ^[A-Z]{3}$ é recusada (I-05)', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money: aritmética exata, sem arredondamento implícito', () => {
  test('0.10 + 0.20 = 0.30 exato', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('soma e subtração no limite de NUMERIC(18,2) sem perda', () => {
    expect(brl('9999999999999999.98').add(brl('0.01')).amount).toBe('9999999999999999.99');
    expect(brl('9999999999999999.99').subtract(brl('0.01')).amount).toBe('9999999999999999.98');
  });

  test('subtract pode produzir negativo interno, sem persistir', () => {
    const r = brl('10.00').subtract(brl('25.00'));
    expect(r.isNegative()).toBe(true);
    expect(r.amount).toBe('-15.00');
  });

  test('negate, isZero, isPositive, isNegative, isLessThan, equals', () => {
    expect(brl('5.00').negate().amount).toBe('-5.00');
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0').isPositive()).toBe(false);
    expect(brl('0').isNegative()).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('zero(currency)', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });

  test('isGreaterThan e o limite máximo exposto', () => {
    expect(brl('2.00').isGreaterThan(brl('1.00'))).toBe(true);
    expect(brl('9999999999999999.99').add(brl('0.01')).exceedsMaximum()).toBe(true);
    expect(brl('9999999999999999.99').exceedsMaximum()).toBe(false);
  });
});

describe('Money: conflito de moeda (FR-004)', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });
  test('add e subtract entre BRL e USD lançam CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money: imutabilidade', () => {
  test('operações devolvem nova instância e não alteram a original', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(b).not.toBe(a);
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('11.00');
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('toString inclui valor e moeda', () => {
    expect(brl('3').toString()).toBe('3.00 BRL');
  });
});
