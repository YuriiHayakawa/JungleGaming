import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../../../shared-kernel/domain/integration-event.ts';
import type { MoneyProps } from '../../../shared-kernel/domain/money.ts';
import type { WagerTransaction } from '../wager-transaction.ts';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceTransactionId?: string;
  /** Saldo observado quando a transação foi aplicada. */
  balance: MoneyProps;
  walletVersion: number;
}

/** Qualquer transação aplicada, inclusive LOSS; não é emitido na abertura (I-09, I-33). `aggregateId` = walletId. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, walletVersion: number, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.observedBalance) throw new Error(`transaction ${tx.id} has no observed balance`);
    return new WagerTransactionProcessed({
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
        ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balance: tx.observedBalance.toJSON(),
        walletVersion,
      },
    });
  }
}
