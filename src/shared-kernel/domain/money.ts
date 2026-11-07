import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors.ts';

/** Instância isolada do decimal.js: precisão 40 cobre a soma de dois valores no limite de NUMERIC(18,2) (R-03). */
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
type Dec = InstanceType<typeof Dec>;

const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/; // I-01
const CURRENCY_PATTERN = /^[A-Z]{3}$/; // I-05
const MAXIMUM = new Dec('9999999999999999.99'); // I-03 (limite de NUMERIC(18,2))

/** Forma de transporte: string decimal com 2 casas e moeda ISO-4217. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Valor monetário imutável e exato. Nunca usa number. Toda operação devolve nova instância; operações entre
 * moedas diferentes lançam CurrencyMismatchError. Resultados internos podem ser negativos (ex.: subtract para
 * testar saldo), mas `from` só aceita o formato não negativo do I-01.
 */
export class Money {
  static readonly MAXIMUM_AMOUNT = '9999999999999999.99';

  private constructor(
    private readonly value: Dec,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    const currency: unknown = props?.currency;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError('amount must be a decimal string with up to 2 decimal places');
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must match ^[A-Z]{3}$');
    }
    const value = new Dec(amount);
    if (value.greaterThan(MAXIMUM)) {
      throw new InvalidMoneyError(`amount must not exceed ${Money.MAXIMUM_AMOUNT}`);
    }
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0', currency });
  }

  /** Valor com exatamente 2 casas decimais. */
  get amount(): string {
    return this.value.toFixed(2);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  /** true quando o valor passa do limite de NUMERIC(18,2) (I-03, I-54). */
  exceedsMaximum(): boolean {
    return this.value.greaterThan(MAXIMUM);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
