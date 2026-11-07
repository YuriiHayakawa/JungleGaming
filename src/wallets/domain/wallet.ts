import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  DomainError,
  InsufficientBalanceError,
} from '../../shared-kernel/domain/errors.ts';
import type { Money } from '../../shared-kernel/domain/money.ts';
import { LedgerDirection } from './ledger-direction.ts';
import { WalletLedgerEntry } from './wallet-ledger-entry.ts';

/** Dados de abertura inválidos (ex.: playerId fora de 1 a 255 caracteres, I-50). */
export class InvalidWalletError extends DomainError {}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root (enunciado §6.2). Saldo nunca negativo nem acima de 9999999999999999.99 (I-54); `version` nasce
 * em 1 e incrementa exatamente uma vez por alteração de saldo (FR-009). `debit`/`credit` aplicam o movimento e
 * devolvem o lançamento correspondente: saldo e ledger nascem juntos.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com version 1. O saldo inicial já é o saldo da wallet; o lançamento de abertura (balanceBefore
   * 0.00) é criado pelo use case e não incrementa a version (I-06).
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.playerId.length < 1 || props.playerId.length > 255) {
      throw new InvalidWalletError('playerId must have 1 to 255 characters');
    }
    if (props.initialBalance.isNegative() || props.initialBalance.exceedsMaximum()) {
      throw new InvalidWalletError('initial balance out of range');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      structuredClone(props.at),
      structuredClone(props.at),
    );
  }

  /** Reconstrução a partir da persistência; não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      structuredClone(state.createdAt),
      structuredClone(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, entryId: string, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    const after = this._balance.subtract(money);
    if (after.isNegative()) throw new InsufficientBalanceError('debit would make the balance negative');
    return this.apply(LedgerDirection.Debit, money, after, entryId, transactionId, at);
  }

  credit(money: Money, entryId: string, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    const after = this._balance.add(money);
    if (after.exceedsMaximum()) throw new BalanceLimitExceededError('credit would exceed the maximum balance');
    return this.apply(LedgerDirection.Credit, money, after, entryId, transactionId, at);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    after: Money,
    entryId: string,
    transactionId: string,
    at: Date,
  ): WalletLedgerEntry {
    // O lançamento valida a aritmética e money > 0 antes de qualquer mudança de estado.
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = structuredClone(at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`currency mismatch: wallet ${this.currency} vs operation ${money.currency}`);
    }
  }
}
