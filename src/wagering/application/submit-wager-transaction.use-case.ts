import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../outbox/domain/outbox-message.ts';
import type { MikroOrmOutboxWriter } from '../../outbox/infrastructure/mikro-orm-outbox.writer.ts';
import { currentRequestContext, setRequestContextValues } from '../../platform/correlation/request-context.ts';
import type { Failpoints } from '../../platform/failpoints/failpoints.ts';
import { classifyDbError } from '../../platform/persistence/pg-errors.ts';
import type { UnitOfWork } from '../../platform/persistence/unit-of-work.ts';
import {
  IdempotencyConflictError,
  InternalError,
  WalletNotFoundError,
} from '../../shared-kernel/application/errors.ts';
import type { Clock } from '../../shared-kernel/domain/clock.port.ts';
import type { IdGenerator } from '../../shared-kernel/domain/id-generator.port.ts';
import type { EventContext, IntegrationEvent } from '../../shared-kernel/domain/integration-event.ts';
import { Money, type MoneyProps } from '../../shared-kernel/domain/money.ts';
import { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed.event.ts';
import { LedgerDirection } from '../../wallets/domain/ledger-direction.ts';
import type { Wallet } from '../../wallets/domain/wallet.ts';
import type { MikroOrmLedgerRepository } from '../../wallets/infrastructure/mikro-orm-ledger.repository.ts';
import type { MikroOrmWalletRepository } from '../../wallets/infrastructure/mikro-orm-wallet.repository.ts';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event.ts';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event.ts';
import { WagerRulesService, type WagerDecision } from '../domain/wager-rules.service.ts';
import { WagerTransaction, WagerTransactionStatus, type WagerTransactionKind } from '../domain/wager-transaction.ts';
import type { MikroOrmWagerTransactionRepository } from '../infrastructure/mikro-orm-wager-transaction.repository.ts';
import { computePayloadHash } from './payload-hash.ts';
import { toTransactionResult, type TransactionResult } from './transaction-result.ts';

/** Uma única repetição do use case depois de 23505 no índice de reversão única (R-12). */
const MAX_REVERSAL_RACE_RETRIES = 1;

/** Payload de negócio já validado e normalizado pela borda (HTTP agora; fila na feature de mensageria). */
export interface SubmitWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  input: SubmitWagerTransactionInput;
}

/** Dados fixos de uma requisição aceita, iguais em todas as tentativas da unit of work. */
interface AcceptedRequest {
  command: SubmitWagerTransactionCommand;
  payloadHash: string;
  correlationId: string;
  receivedAt: Date;
}

/** Onde a duplicata foi reconhecida (R-08): caminho rápido, releitura sob o lock ou releitura depois do 23505. */
type IdempotencySource = 'fast-path' | 'under-lock' | 'after-unique-violation';

/** Log estruturado mínimo (o JsonLogger da plataforma); nunca recebe valores monetários (FR-058). */
export interface UseCaseLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface SubmitWagerTransactionDeps {
  orm: Pick<MikroORM, 'em'>;
  unitOfWork: UnitOfWork<EntityManager>;
  wallets: MikroOrmWalletRepository;
  transactions: MikroOrmWagerTransactionRepository;
  ledger: MikroOrmLedgerRepository;
  outbox: MikroOrmOutboxWriter;
  failpoints: Failpoints;
  clock: Clock;
  ids: IdGenerator;
  logger: UseCaseLogger;
}

/**
 * Submissão de BET, WIN, LOSS, REFUND e ROLLBACK (data-model §3; I-44; R-07, R-08, R-10, R-19). A carga da
 * referência entra nas US4 a US6 (T090, T096, T101).
 *
 * Ordem do I-44: os passos 1 e 2 (header e payload) são da borda; 3 = idempotência (replay ou conflito), antes de
 * olhar a wallet; 4 = wallet inexistente → 404 sem persistir; 5 = regras de negócio sob o lock da wallet, num
 * serviço de domínio puro.
 *
 * Idempotência (R-08, I-24, I-26, I-27, I-56), toda no banco, nunca em memória (FR-037):
 *   1. caminho rápido, fora da transação, por (provider, chave) e por (provider, id externo);
 *   2. releitura das duas chaves sob o lock da wallet, com o EM da transação;
 *   3. 23505 em `wager_tx_provider_idempotency_uq` ou `wager_tx_provider_external_uq` → depois do rollback, releitura
 *      num fork novo. O PostgreSQL só reporta a violação depois que a transação concorrente decide, então a linha
 *      vencedora já está confirmada quando é relida.
 * Mesmo hash → replay com o resultado gravado; hash diferente, ou o mesmo id externo com outra chave → 409.
 */
export class SubmitWagerTransactionUseCase {
  private readonly rules = new WagerRulesService();

  constructor(private readonly deps: SubmitWagerTransactionDeps) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<TransactionResult> {
    const { input } = command;
    const request: AcceptedRequest = {
      command,
      payloadHash: computePayloadHash(input),
      correlationId: currentRequestContext()?.correlationId ?? this.deps.ids.next(),
      receivedAt: this.deps.clock.now(),
    };

    // I-44 passo 3: caminho rápido num fork próprio, sem lock. O replay não disputa o lock da wallet nem depende
    // da checagem de wallet do passo 4.
    const known = await this.resolveExisting(this.deps.orm.em.fork(), request, 'fast-path');
    if (known) return known;

    // I-44 passo 4 (I-20): wallet inexistente → 404 sem registrar nada. Leitura num fork próprio, que termina antes
    // de a transação começar (R-19).
    const existing = await this.deps.wallets.findById(this.deps.orm.em.fork(), input.walletId);
    if (!existing) throw new WalletNotFoundError();

    let outcome: { result: TransactionResult; replay: boolean };
    try {
      outcome = await this.runRetryingReversalRace(request);
    } catch (error) {
      if (classifyDbError(error) !== 'idempotency-race') throw error;
      // R-08 passo 3: a transação desta requisição já sofreu rollback; relê fora dela, num fork novo.
      const resolved = await this.resolveExisting(this.deps.orm.em.fork(), request, 'after-unique-violation');
      if (resolved) return resolved;
      throw new InternalError({ cause: error });
    }

    // Contexto de log (C1): só depois do commit, com o id que de fato ficou gravado. Uma tentativa desfeita pela
    // unit of work (R-12) nunca deixa no contexto um id que não existe no banco. No replay sob o lock, é o id da
    // linha existente, já gravado por `resolveExisting`.
    setRequestContextValues({ transactionId: outcome.result.transactionId });

    // Depois do commit de um efeito novo e antes da resposta (testes de queda, R-16); no-op em produção (I-40).
    if (!outcome.replay) this.deps.failpoints.hit('after_commit_before_response');
    return outcome.result;
  }

  /**
   * Roda a transação de escrita. Cada execução da unit of work (inclusive as repetições internas de 40P01/40001, R-12)
   * abre um fork novo e recomeça do zero: a transação de domínio, os ids e os eventos são criados dentro do callback,
   * nunca reaproveitados de uma tentativa que sofreu rollback (T132).
   *
   * `23505` em `wager_tx_single_reversal_uq` (R-12, FR-025, T096): a reversão concorrente já foi confirmada; repete o
   * use case **uma** vez, do zero, e sob o lock a nova execução vê a reversão confirmada e responde ALREADY_REVERSED.
   * Uma segunda violação é quebra de invariante → InternalError (500), sem efeito.
   */
  private async runRetryingReversalRace(request: AcceptedRequest): Promise<{ result: TransactionResult; replay: boolean }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.unitOfWork.run((em) => this.applyUnderLock(em, request));
      } catch (error) {
        if (classifyDbError(error) !== 'reversal-race') throw error;
        if (attempt >= MAX_REVERSAL_RACE_RETRIES) {
          this.deps.logger.info('wager.reversal_race', { outcome: 'exhausted', attempt });
          throw new InternalError({ cause: error });
        }
        this.deps.logger.info('wager.reversal_race', { outcome: 'retry', attempt });
      }
    }
  }

  /**
   * Dentro da transação: toda query usa o `em` recebido, que é o da transação (R-19). Trava a wallet, relê a
   * idempotência sob o lock, carrega a referência, decide e grava na ordem do data-model §3: transação já no status
   * final → saldo com asserção de versão → lançamento → outbox.
   */
  private async applyUnderLock(
    em: EntityManager,
    request: AcceptedRequest,
  ): Promise<{ result: TransactionResult; replay: boolean }> {
    const wallet = await this.deps.wallets.lockById(em, request.command.input.walletId);
    if (!wallet) throw new WalletNotFoundError();

    // R-08 passo 2: em READ COMMITTED, depois do lock esta leitura enxerga tudo o que foi confirmado antes dela.
    const known = await this.resolveExisting(em, request, 'under-lock');
    if (known) return { result: known, replay: true };

    const transaction = this.newTransaction(request);
    // data-model §3 passo 4: referência carregada sob o lock, com o EM da transação (R-19).
    const reference = await this.loadReference(em, transaction);
    const referenceAlreadyReversed = await this.isAlreadyReversed(em, transaction, reference);
    const decision = this.rules.decide({ wallet, transaction, reference, referenceAlreadyReversed });
    const now = this.deps.clock.now();
    const events = await this.record(em, decision, wallet, transaction, reference, {
      correlationId: request.correlationId,
      now,
    });

    await this.deps.outbox.append(em, events.map((event) => OutboxMessage.enqueue(event)));
    // Depois do lançamento e antes do commit: prova a atomicidade (SC-007) e as repetições (R-12, T096); no-op em
    // produção (I-40).
    if (transaction.requiresReference() && transaction.status === WagerTransactionStatus.Processed) {
      this.deps.failpoints.hit('after_reversal_insert_before_commit');
    }
    this.deps.failpoints.hit('after_ledger_insert_before_commit');
    return { result: toTransactionResult(transaction, { replay: false }), replay: false };
  }

  /**
   * Procura, numa única consulta, uma transação já registrada pela mesma chave do mesmo provedor ou pelo mesmo
   * (provider, id externo); a da mesma chave tem precedência. Mesmo hash → replay do resultado gravado (status,
   * failureCode e saldo observado, I-26), sem registrar eventos e sem tocar no correlation_id gravado (I-53). Hash
   * diferente, ou o mesmo id externo sob outra chave → IdempotencyConflictError (I-24).
   */
  private async resolveExisting(
    em: EntityManager,
    request: AcceptedRequest,
    source: IdempotencySource,
  ): Promise<TransactionResult | undefined> {
    const { idempotencyKey, input } = request.command;
    const matches = await this.deps.transactions.findByProviderAndKeyOrExternalId(
      em,
      input.providerId,
      idempotencyKey,
      input.externalTransactionId,
    );
    const byKey = matches.find((tx) => tx.idempotencyKey === idempotencyKey);
    const found = byKey ?? matches[0];
    if (!found) return undefined;

    setRequestContextValues({ transactionId: found.id });
    if (byKey && byKey.matchesPayload(request.payloadHash)) {
      this.deps.logger.info('wager.idempotency', { outcome: 'replay', source, transactionId: found.id });
      return toTransactionResult(byKey, { replay: true });
    }
    this.deps.logger.info('wager.idempotency', { outcome: 'conflict', source, transactionId: found.id });
    throw new IdempotencyConflictError();
  }

  /**
   * A referência por (providerId da requisição, referenceExternalTransactionId), em qualquer estado, ou ausente
   * (I-14, FR-021). Lida com o EM da transação, sob o lock da wallet desta requisição. A referência de outra wallet
   * não é travada: as regras só usam dela atributos imutáveis para barrar o mismatch (plan, "Invariante de projeto").
   */
  private async loadReference(em: EntityManager, transaction: WagerTransaction): Promise<WagerTransaction | undefined> {
    const externalId = transaction.referenceExternalTransactionId;
    if (externalId === undefined) return undefined;
    return (await this.deps.transactions.findByProviderAndExternalId(em, transaction.providerId, externalId)) ?? undefined;
  }

  /**
   * ALREADY_REVERSED (I-16): consultado só quando a transação é REFUND ou ROLLBACK e a referência está PROCESSED
   * (R-10). Sob o lock da wallet, em READ COMMITTED, enxerga toda reversão confirmada antes; o índice parcial
   * `wager_tx_single_reversal_uq` cobre o resto.
   */
  private async isAlreadyReversed(
    em: EntityManager,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
  ): Promise<boolean> {
    if (!transaction.requiresReference() || reference?.status !== WagerTransactionStatus.Processed) return false;
    return this.deps.transactions.existsProcessedReversal(em, reference.id);
  }

  /** Nova instância PENDING, com id novo, a cada tentativa. Não toca o contexto de log (só depois do commit). */
  private newTransaction(request: AcceptedRequest): WagerTransaction {
    const { command, payloadHash, correlationId, receivedAt } = request;
    const { input } = command;
    const transaction = WagerTransaction.create({
      id: this.deps.ids.next(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind as WagerTransactionKind,
      money: Money.from(input.money),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      correlationId,
      createdAt: receivedAt,
    });
    return transaction;
  }

  /** Aplica a decisão e devolve os eventos na ordem de gravação: WalletBalanceChanged antes do evento de status. */
  private async record(
    em: EntityManager,
    decision: WagerDecision,
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    at: { correlationId: string; now: Date },
  ): Promise<IntegrationEvent<unknown>[]> {
    const { ids } = this.deps;
    const context = (): EventContext => ({ eventId: ids.next(), correlationId: at.correlationId, occurredAt: at.now });

    switch (decision.type) {
      case 'REJECT': {
        // REJECTED não altera saldo nem gera lançamento (FR-027); o saldo observado é o atual (FR-036).
        transaction.reject(decision.code, wallet.balance, at.now);
        await this.deps.transactions.insert(em, transaction);
        return [WagerTransactionRejected.from(transaction, context())];
      }
      case 'APPLY': {
        const events: IntegrationEvent<unknown>[] = [];
        if (decision.direction === undefined) {
          // Sem efeito no saldo: PROCESSED sem lançamento e sem tocar a wallet (FR-018).
          transaction.markProcessed(reference?.id, wallet.balance, at.now);
          await this.deps.transactions.insert(em, transaction);
        } else {
          const expectedVersion = wallet.version;
          const entryId = ids.next();
          const entry =
            decision.direction === LedgerDirection.Debit
              ? wallet.debit(transaction.money, entryId, transaction.id, at.now)
              : wallet.credit(transaction.money, entryId, transaction.id, at.now);
          transaction.markProcessed(reference?.id, wallet.balance, at.now);
          await this.deps.transactions.insert(em, transaction);
          await this.deps.wallets.updateBalance(em, wallet, expectedVersion);
          await this.deps.ledger.insert(em, entry);
          events.push(WalletBalanceChanged.from(wallet, entry, context()));
        }
        events.push(WagerTransactionProcessed.from(transaction, wallet.version, context()));
        return events;
      }
      case 'PENDING_REFERENCE':
        // As regras só devolvem PENDING_REFERENCE com o passo 5.3 ativo; o tratamento entra no T101 (US6).
        throw new Error('PENDING_REFERENCE is not produced before US6 (T101)');
    }
  }
}
