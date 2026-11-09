import type { EntityManager } from '@mikro-orm/postgresql';
import type { IdGenerator } from '../../shared-kernel/domain/id-generator.port.ts';
import type { EventContext, IntegrationEvent } from '../../shared-kernel/domain/integration-event.ts';
import { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed.event.ts';
import { LedgerDirection } from '../../wallets/domain/ledger-direction.ts';
import type { Wallet } from '../../wallets/domain/wallet.ts';
import type { MikroOrmLedgerRepository } from '../../wallets/infrastructure/mikro-orm-ledger.repository.ts';
import type { MikroOrmWalletRepository } from '../../wallets/infrastructure/mikro-orm-wallet.repository.ts';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference.event.ts';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event.ts';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event.ts';
import type { WagerDecision } from '../domain/wager-rules.service.ts';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction.ts';
import type { MikroOrmWagerTransactionRepository } from '../infrastructure/mikro-orm-wager-transaction.repository.ts';

/** Contexto dos eventos e instante da gravação. Na fila, `causationId` = messageId (I-69); no HTTP e no worker, ausente. */
export interface RecordContext {
  correlationId: string;
  causationId: string | undefined;
  now: Date;
}

/**
 * Como a transação chega ao banco:
 * - `insert`: transação nova (submit), inserida já no status final (data-model da 001, §3);
 * - `resolve`: pendente concluída pelo worker, atualizada com `WHERE status = 'PENDING_REFERENCE'` (data-model §3.3).
 */
export type RecordMode = 'insert' | 'resolve';

export interface RecordRequest {
  decision: WagerDecision;
  wallet: Wallet;
  transaction: WagerTransaction;
  reference: WagerTransaction | undefined;
  mode: RecordMode;
  at: RecordContext;
}

export interface TransactionRecorderDeps {
  wallets: MikroOrmWalletRepository;
  transactions: MikroOrmWagerTransactionRepository;
  ledger: MikroOrmLedgerRepository;
  ids: IdGenerator;
  /** Espera até a 1ª tentativa do worker, contada de `created_at` (I-21: a base do backoff, PENDING_BACKOFF_BASE_MS). */
  firstReferenceAttemptDelayMs: number;
}

/**
 * Gravação de uma decisão das regras (research R-24), compartilhada pelo submit (HTTP e fila) e pelo worker de
 * PENDING_REFERENCE: uma só implementação de saldo, ledger e eventos (FR-027, constitution II). Recebe o EM da
 * transação, com a wallet já travada (`FOR UPDATE`) por quem chama (constitution III, R-19).
 *
 * Ordem de gravação (triggers da 001): transação no status final → saldo com asserção de versão → lançamento. Os eventos
 * voltam na ordem de gravação (WalletBalanceChanged antes do evento de status); quem chama os grava na outbox, no mesmo
 * commit.
 *
 * Antecipação (FR-026, I-21, I-63, I-73; data-model §3.4): quando a transação termina PROCESSED ou REJECTED, na mesma
 * transação, as pendentes que a referenciam têm `next_reference_attempt_at` puxado para agora. Roda depois do lock da
 * wallet de origem; só faz `UPDATE` das dependentes, sem processá-las (quem processa é a próxima varredura do worker).
 */
export class TransactionRecorder {
  constructor(private readonly deps: TransactionRecorderDeps) {}

  async record(em: EntityManager, request: RecordRequest): Promise<IntegrationEvent<unknown>[]> {
    const { decision, wallet, transaction, reference, mode, at } = request;
    const { ids } = this.deps;
    const context = (): EventContext => ({
      eventId: ids.next(),
      correlationId: at.correlationId,
      ...(at.causationId !== undefined ? { causationId: at.causationId } : {}),
      occurredAt: at.now,
    });

    let events: IntegrationEvent<unknown>[];
    switch (decision.type) {
      case 'REJECT': {
        // REJECTED não altera saldo nem gera lançamento (FR-027); o saldo observado é o atual (FR-036, I-67).
        transaction.reject(decision.code, wallet.balance, at.now);
        await this.persist(em, transaction, mode);
        events = [WagerTransactionRejected.from(transaction, context())];
        break;
      }
      case 'APPLY': {
        events = [];
        if (decision.direction === undefined) {
          // Sem efeito no saldo: PROCESSED sem lançamento e sem tocar a wallet (FR-018).
          transaction.markProcessed(reference?.id, wallet.balance, at.now);
          await this.persist(em, transaction, mode);
        } else {
          const expectedVersion = wallet.version;
          const entryId = ids.next();
          const entry =
            decision.direction === LedgerDirection.Debit
              ? wallet.debit(transaction.money, entryId, transaction.id, at.now)
              : wallet.credit(transaction.money, entryId, transaction.id, at.now);
          transaction.markProcessed(reference?.id, wallet.balance, at.now);
          await this.persist(em, transaction, mode);
          await this.deps.wallets.updateBalance(em, wallet, expectedVersion);
          await this.deps.ledger.insert(em, entry);
          events.push(WalletBalanceChanged.from(wallet, entry, context()));
        }
        events.push(WagerTransactionProcessed.from(transaction, wallet.version, context()));
        break;
      }
      case 'PENDING_REFERENCE': {
        // Só para transação nova: o worker trata a pendente que continua pendente (reagendamento ou esgotamento).
        if (mode !== 'insert') throw new Error(`a PENDING_REFERENCE decision cannot resolve transaction ${transaction.id}`);
        // Referência ausente ou ainda não aplicada (I-15, FR-023): aceita sem tocar na wallet, sem lançamento e sem
        // failureCode; o saldo observado é o atual (FR-036). A 1ª tentativa do worker fica para a criação + a base do
        // backoff (I-21); `createdAt` é o `clock.now()` do recebimento da requisição.
        const nextAttemptAt = new Date(transaction.createdAt.getTime() + this.deps.firstReferenceAttemptDelayMs);
        transaction.markPendingReference(wallet.balance, nextAttemptAt, at.now);
        await this.persist(em, transaction, mode);
        return [WagerTransactionPendingReference.from(transaction, context())];
      }
    }

    if (transaction.status === WagerTransactionStatus.Processed || transaction.status === WagerTransactionStatus.Rejected) {
      await this.deps.transactions.anticipateDependents(em, transaction.providerId, transaction.externalTransactionId, at.now);
    }
    // `transactions_total` não é contado aqui: esta gravação ainda pode ser desfeita (rollback, 40P01, 40001). Quem chama
    // conta depois do commit da unit of work (N-45).
    return events;
  }

  private async persist(em: EntityManager, transaction: WagerTransaction, mode: RecordMode): Promise<void> {
    if (mode === 'insert') await this.deps.transactions.insert(em, transaction);
    else await this.deps.transactions.updateResolution(em, transaction);
  }
}
