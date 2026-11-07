import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../../../shared-kernel/domain/integration-event.ts';
import type { MoneyProps } from '../../../shared-kernel/domain/money.ts';
import { retryableOf, type FailureCode } from '../failure-code.ts';
import type { WagerTransaction } from '../wager-transaction.ts';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  failureCode: FailureCode;
  retryable: boolean;
  /** Saldo observado no momento da rejeição. */
  balance: MoneyProps;
}

/** Transação rejeitada por regra de negócio (I-19, I-33). `aggregateId` = walletId. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode || !tx.observedBalance) throw new Error(`transaction ${tx.id} is not a recorded rejection`);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
        retryable: retryableOf(tx.failureCode),
        balance: tx.observedBalance.toJSON(),
      },
    });
  }
}
