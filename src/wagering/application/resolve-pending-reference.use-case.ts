import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../outbox/domain/outbox-message.ts';
import type { MikroOrmOutboxWriter } from '../../outbox/infrastructure/mikro-orm-outbox.writer.ts';
import { runWithRequestContext } from '../../platform/correlation/request-context.ts';
import type { Failpoints } from '../../platform/failpoints/failpoints.ts';
import type { MetricsPort } from '../../platform/metrics/metrics.port.ts';
import type { RandomSource } from '../../platform/random/random-source.port.ts';
import { classifyDbError } from '../../platform/persistence/pg-errors.ts';
import type { UnitOfWork } from '../../platform/persistence/unit-of-work.ts';
import { ServiceUnavailableError } from '../../shared-kernel/application/errors.ts';
import type { Clock } from '../../shared-kernel/domain/clock.port.ts';
import type { IntegrationEvent } from '../../shared-kernel/domain/integration-event.ts';
import type { MikroOrmWalletRepository } from '../../wallets/infrastructure/mikro-orm-wallet.repository.ts';
import { FailureCode } from '../domain/failure-code.ts';
import type { PendingReferencePolicy } from '../domain/pending-reference-policy.ts';
import { WagerRulesService } from '../domain/wager-rules.service.ts';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction.ts';
import type {
  MikroOrmWagerTransactionRepository,
  PendingClaim,
} from '../infrastructure/mikro-orm-wager-transaction.repository.ts';
import type { TransactionRecorder } from './transaction-recorder.ts';

/** Uma única repetição da reavaliação depois de 23505 no índice de reversão única (como no submit, 001 R-12). */
const MAX_REVERSAL_RACE_RETRIES = 1;
/** Rodadas "irmãs mais antigas → esta" antes de deixar a pendente para a próxima varredura (I-63). */
const MAX_ORDER_ROUNDS = 3;

export interface ResolvePendingLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export interface ResolvePendingReferenceDeps {
  orm: Pick<MikroORM, 'em'>;
  unitOfWork: UnitOfWork<EntityManager>;
  wallets: MikroOrmWalletRepository;
  transactions: MikroOrmWagerTransactionRepository;
  outbox: MikroOrmOutboxWriter;
  recorder: TransactionRecorder;
  policy: PendingReferencePolicy;
  random: RandomSource;
  failpoints: Failpoints;
  /** FR-036: FAILED em `transactions_total`, falhas transitórias em `retries_total` e latência por reavaliação. */
  metrics: MetricsPort;
  clock: Clock;
  logger: ResolvePendingLogger;
  batchSize: number;
  leaseMs: number;
}

/** Resultado de uma reavaliação. `skipped`: já não estava pendente (outra instância concluiu, FR-028). */
export type EvaluationOutcome =
  | 'processed'
  | 'rejected'
  | 'rescheduled'
  | 'exhausted'
  | 'skipped'
  | 'deferred'
  | 'failed'
  | 'lock_conflict';

export interface ResolveRound {
  claimed: number;
}

/**
 * Worker de PENDING_REFERENCE (plan, "Worker"; FR-023 a FR-031; I-21, I-61, I-63, I-64, I-72; R-24 a R-26):
 *
 * 1. claim por lease (transação mínima, `SKIP LOCKED`, sem lock de wallet);
 * 2. para cada reservada, **irmãs mais antigas primeiro** (mesma wallet e mesma referência, por `created_at`), cada uma na
 *    própria transação da unit of work (I-63);
 * 3. em cada transação: lock da wallet → **relê a linha** (não pendente → nada a fazer, FR-028) → referência e reversão
 *    existente relidas sob o lock → `WagerRulesService.decide` (a mesma regra do submit, I-44);
 *    - aplicar ou rejeitar → `TransactionRecorder` (`resolve`), com a antecipação das dependentes. Antes, sob o lock,
 *      se ainda houver irmã mais antiga pendente, a conclusão é adiada (`deferred`, sem escrita) e as irmãs vão primeiro;
 *    - continua pendente → o esgotamento só é consultado agora, depois de a referência ser relida (I-72): esgotou →
 *      REJECTED `REFERENCE_NOT_FOUND` com evento; senão → tentativas + 1 e próxima hora com backoff e jitter (I-11);
 *    - eventos com o `correlation_id` gravado na pendente, sem `causationId` (I-69); failpoint antes do commit (R-29);
 * 4. `23505` no índice de reversão única → repete a reavaliação uma vez;
 * 5. falha transitória → rollback sem efeito; a tentativa não conta. Lock da wallet esgotado (55P03) segue para a próxima
 *    reservada; banco fora interrompe a rodada (o laço espera com backoff). A reservada volta quando o lease vence;
 * 6. erro permanente inesperado → rollback e, numa transação separada sob o lock da wallet, FAILED `INTERNAL_ERROR`, sem
 *    lançamento nem evento (FR-029, I-22, I-61).
 */
export class ResolvePendingReferenceUseCase {
  private readonly rules = new WagerRulesService();

  constructor(private readonly deps: ResolvePendingReferenceDeps) {}

  async resolveOnce(): Promise<ResolveRound> {
    const { transactions, clock, batchSize, leaseMs } = this.deps;
    const claimed = await this.deps.unitOfWork.run((em) => transactions.claimDuePending(em, clock.now(), batchSize, leaseMs));
    for (const pending of claimed) await this.resolve(pending);
    return { claimed: claimed.length };
  }

  /** Irmãs mais antigas primeiro, depois a reservada; repete enquanto a conclusão for adiada por uma irmã (I-63). */
  private async resolve(pending: PendingClaim): Promise<void> {
    for (let round = 0; round < MAX_ORDER_ROUNDS; round++) {
      const siblings = await this.deps.transactions.findOlderSiblings(this.deps.orm.em.fork(), pending);
      for (const sibling of siblings) await this.evaluate(sibling);
      if ((await this.evaluate(pending)) !== 'deferred') return;
    }
    // Irmã mais antiga ainda pendente depois das rodadas: a reservada volta quando o lease vencer.
    this.deps.logger.warn('pending_worker.deferred', { transactionId: pending.id, walletId: pending.walletId });
  }

  private async evaluate(pending: PendingClaim): Promise<EvaluationOutcome> {
    const startedAt = this.deps.clock.now().getTime();
    const outcome = await this.evaluateWithRetry(pending);
    if (outcome !== 'skipped' && outcome !== 'deferred') {
      this.deps.metrics.observe('processing_latency_ms', Math.max(0, this.deps.clock.now().getTime() - startedAt), {
        worker: 'pending_worker',
      });
    }
    return outcome;
  }

  private async evaluateWithRetry(pending: PendingClaim): Promise<EvaluationOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await this.deps.unitOfWork.run((em) => this.evaluateUnderLock(em, pending));
        // FR-036, N-45: só depois do commit; uma reavaliação desfeita (rollback, 40P01, 40001) não conta.
        const status = COMMITTED_STATUS[outcome];
        if (status) this.deps.metrics.increment('transactions_total', { status });
        return outcome;
      } catch (error) {
        const kind = classifyDbError(error);
        if (kind === 'reversal-race' && attempt < MAX_REVERSAL_RACE_RETRIES) {
          this.deps.logger.info('pending_worker.reversal_race', { transactionId: pending.id, outcome: 'retry' });
          continue;
        }
        if (isTransient(error)) {
          const lockConflict = rootCode(error) === '55P03';
          this.deps.metrics.increment('retries_total', { worker: 'pending_worker' });
          this.deps.logger.warn('pending_worker.attempt_failed', {
            transactionId: pending.id,
            walletId: pending.walletId,
            errorClass: 'transient',
            lockConflict,
            error: describe(error),
          });
          if (lockConflict) return 'lock_conflict';
          throw error; // banco indisponível: interrompe a rodada; o laço aplica o backoff (FR-034)
        }
        await this.fail(pending, error);
        return 'failed';
      }
    }
  }

  private async evaluateUnderLock(em: EntityManager, pending: PendingClaim): Promise<EvaluationOutcome> {
    const { wallets, transactions, clock } = this.deps;
    const wallet = await wallets.lockById(em, pending.walletId);
    if (!wallet) throw new Error(`wallet ${pending.walletId} of pending transaction ${pending.id} not found`);

    // Releitura sob o lock (FR-028, R-26): em READ COMMITTED, enxerga toda conclusão confirmada antes do lock.
    const transaction = await transactions.findById(em, pending.id);
    if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return 'skipped';

    return runWithRequestContext(
      {
        correlationId: transaction.correlationId,
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
      },
      async () => {
        const reference = await this.loadReference(em, transaction);
        const referenceAlreadyReversed = await this.isAlreadyReversed(em, transaction, reference);
        const decision = this.rules.decide({ wallet, transaction, reference, referenceAlreadyReversed });
        const now = clock.now();
        // Eventos do worker: correlation_id gravado na pendente, sem causationId (I-69, FR-038).
        const at = { correlationId: transaction.correlationId, causationId: undefined, now };

        let outcome: EvaluationOutcome;
        let events: IntegrationEvent<unknown>[] = [];
        if (decision.type === 'PENDING_REFERENCE') {
          // A referência foi relida agora e segue ausente ou pendente: esta avaliação conta como tentativa (I-64, I-72).
          const attemptsAfterThis = transaction.referenceAttempts + 1;
          if (this.deps.policy.isExhausted(attemptsAfterThis, transaction.createdAt, now)) {
            events = await this.deps.recorder.record(em, {
              decision: { type: 'REJECT', code: FailureCode.ReferenceNotFound },
              wallet,
              transaction,
              reference,
              mode: 'resolve',
              at,
            });
            outcome = 'exhausted';
          } else {
            const delay = this.deps.policy.delayBefore(attemptsAfterThis + 1, this.deps.random.next());
            transaction.scheduleNextReferenceAttempt(new Date(now.getTime() + delay), now);
            await transactions.scheduleNextAttempt(em, transaction);
            outcome = 'rescheduled';
          }
        } else {
          // I-63: a conclusão respeita a ordem de criação. Sob o lock, uma irmã mais antiga ainda pendente vai primeiro.
          if ((await transactions.findOlderSiblings(em, pending)).length > 0) return 'deferred';
          events = await this.deps.recorder.record(em, { decision, wallet, transaction, reference, mode: 'resolve', at });
          outcome = transaction.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
        }

        await this.deps.outbox.append(em, events.map((event) => OutboxMessage.enqueue(event)));
        // Antes do commit da reavaliação (testes de queda e do FAILED, R-29); no-op em produção (I-40).
        this.deps.failpoints.hit('after_pending_resolution_before_commit');
        this.deps.logger.info('pending_worker.evaluated', {
          outcome,
          status: transaction.status,
          failureCode: transaction.failureCode,
          referenceAttempts: transaction.referenceAttempts,
        });
        return outcome;
      },
    );
  }

  /**
   * Erro permanente inesperado (FR-029, I-22, I-61): a transação principal já sofreu rollback; esta é uma unidade
   * separada, sob o lock da wallet, que só marca FAILED se a linha ainda estiver pendente. Sem lançamento, sem saldo e
   * sem evento. Se a própria marcação falhar, a pendente volta quando o lease vencer.
   */
  private async fail(pending: PendingClaim, cause: unknown): Promise<void> {
    try {
      const marked = await this.deps.unitOfWork.run(async (em) => {
        await this.deps.wallets.lockById(em, pending.walletId);
        const transaction = await this.deps.transactions.findById(em, pending.id);
        if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return false;
        transaction.fail(FailureCode.InternalError, this.deps.clock.now());
        return this.deps.transactions.markFailed(em, transaction);
      });
      if (marked) this.deps.metrics.increment('transactions_total', { status: 'FAILED' });
      this.deps.logger.error('pending_worker.failed', {
        transactionId: pending.id,
        walletId: pending.walletId,
        marked,
        errorClass: 'unexpected',
        error: describe(cause),
      });
    } catch (error) {
      this.deps.logger.error('pending_worker.fail_unrecorded', {
        transactionId: pending.id,
        cause: describe(cause),
        error: describe(error),
      });
    }
  }

  /** A referência por (providerId, referenceExternalTransactionId), relida sob o lock, em qualquer estado (I-14). */
  private async loadReference(em: EntityManager, transaction: WagerTransaction): Promise<WagerTransaction | undefined> {
    const externalId = transaction.referenceExternalTransactionId;
    if (externalId === undefined) return undefined;
    return (await this.deps.transactions.findByProviderAndExternalId(em, transaction.providerId, externalId)) ?? undefined;
  }

  /** ALREADY_REVERSED (I-16): só para REFUND/ROLLBACK de referência PROCESSED, como no submit. */
  private async isAlreadyReversed(
    em: EntityManager,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
  ): Promise<boolean> {
    if (!transaction.requiresReference() || reference?.status !== WagerTransactionStatus.Processed) return false;
    return this.deps.transactions.existsProcessedReversal(em, reference.id);
  }
}

/** Status gravado por uma reavaliação confirmada; reagendamento, `skipped` e `deferred` não gravam transação nova. */
const COMMITTED_STATUS: Partial<Record<EvaluationOutcome, WagerTransactionStatus>> = {
  processed: WagerTransactionStatus.Processed,
  rejected: WagerTransactionStatus.Rejected,
  exhausted: WagerTransactionStatus.Rejected,
};

/** Banco fora, conexão perdida, pool esgotado ou lock esgotado: rollback sem efeito, a tentativa não conta. */
function isTransient(error: unknown): boolean {
  if (error instanceof ServiceUnavailableError) return true;
  const kind = classifyDbError(error);
  return kind === 'transient' || kind === 'retry';
}

function rootCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
