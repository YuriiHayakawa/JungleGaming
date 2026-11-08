import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from '../../../shared-kernel/domain/integration-event.ts';
import type { MoneyProps } from '../../../shared-kernel/domain/money.ts';
import type { WagerTransaction } from '../wager-transaction.ts';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  /** id no provedor da referência que ainda não chegou ou não foi aplicada. */
  referenceExternalTransactionId: string;
  /** Primeira tentativa agendada do worker de PENDING_REFERENCE (I-21), em ISO-8601. */
  nextAttemptAt: string;
}

/** Transação que entrou em PENDING_REFERENCE (I-15, I-33, FR-045). `aggregateId` = walletId. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.referenceExternalTransactionId === undefined) {
      throw new Error(`transaction ${tx.id} has no reference to wait for`);
    }
    if (!tx.nextReferenceAttemptAt) throw new Error(`transaction ${tx.id} has no scheduled reference attempt`);
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}
