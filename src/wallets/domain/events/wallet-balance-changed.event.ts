import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../../../shared-kernel/domain/integration-event.ts';
import type { MoneyProps } from '../../../shared-kernel/domain/money.ts';
import type { LedgerDirection } from '../ledger-direction.ts';
import type { Wallet } from '../wallet.ts';
import type { WalletLedgerEntry } from '../wallet-ledger-entry.ts';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Saldo mudou, inclusive na abertura (I-33, enunciado §11). `aggregateId` = walletId. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
