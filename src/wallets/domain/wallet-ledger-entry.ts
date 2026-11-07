import { InvalidLedgerEntryError } from '../../shared-kernel/domain/errors.ts';
import type { Money } from '../../shared-kernel/domain/money.ts';
import { isLedgerDirection, LedgerDirection } from './ledger-direction.ts';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento imutável do ledger (enunciado §6.4). Sem campos mutáveis nem transições: a instância é congelada.
 * `create` valida a aritmética (FR-029); `rehydrate` reconstrói o estado persistido sem revalidar.
 * O `seq` não é do domínio: é atribuído pelo banco e só aparece no read model do ledger (I-36).
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { direction, money, balanceBefore, balanceAfter } = props;
    if (!isLedgerDirection(direction)) throw new InvalidLedgerEntryError(`invalid ledger direction: ${String(direction)}`);
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('ledger entry must use a single currency');
    }
    if (!money.isPositive()) throw new InvalidLedgerEntryError('ledger entry amount must be greater than zero');
    if (balanceBefore.isNegative()) throw new InvalidLedgerEntryError('balance before must not be negative');
    if (balanceAfter.isNegative()) throw new InvalidLedgerEntryError('balance after must not be negative');
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) throw new InvalidLedgerEntryError('balance before ± amount must equal balance after');
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      structuredClone(state.createdAt),
    );
  }

  /** balanceBefore ± money === balanceAfter, conforme a direção. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
