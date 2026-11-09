import type { MikroORM } from '@mikro-orm/postgresql';
import { TransactionNotFoundError } from '../../shared-kernel/application/errors.ts';
import type { MoneyProps } from '../../shared-kernel/domain/money.ts';
import { retryableOf, type FailureCode } from '../domain/failure-code.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import type { MikroOrmWagerTransactionRepository } from '../infrastructure/mikro-orm-wager-transaction.repository.ts';

/** Representação de consulta `Transaction` do contrato (FR-052). Campos opcionais são omitidos quando ausentes. */
export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: FailureCode;
  retryable?: boolean;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  observedBalance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode, retryable: retryableOf(tx.failureCode) } : {}),
    ...(tx.referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
    ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.observedBalance !== undefined ? { observedBalance: tx.observedBalance.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt !== undefined ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

/**
 * GET /wagering/transactions/:transactionId e GET /providers/:providerId/wagering/transactions/:externalTransactionId
 * (FR-052, FR-053, I-55). Em qualquer status; inexistente → TRANSACTION_NOT_FOUND (404). Leitura num fork próprio.
 */
export class GetTransactionUseCase {
  constructor(private readonly deps: { orm: Pick<MikroORM, 'em'>; transactions: MikroOrmWagerTransactionRepository }) {}

  async byId(transactionId: string): Promise<TransactionView> {
    return this.found(await this.deps.transactions.findById(this.deps.orm.em.fork(), transactionId));
  }

  async byProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.found(
      await this.deps.transactions.findByProviderAndExternalId(this.deps.orm.em.fork(), providerId, externalTransactionId),
    );
  }

  private found(tx: WagerTransaction | null): TransactionView {
    if (!tx) throw new TransactionNotFoundError();
    return toTransactionView(tx);
  }
}
