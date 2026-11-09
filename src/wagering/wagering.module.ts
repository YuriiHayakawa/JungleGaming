import { Module } from '@nestjs/common';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmInboxRepository } from '../inbox/infrastructure/mikro-orm-inbox.repository.ts';
import { MikroOrmOutboxWriter } from '../outbox/infrastructure/mikro-orm-outbox.writer.ts';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config.ts';
import { FAILPOINTS, type Failpoints } from '../platform/failpoints/failpoints.ts';
import { METRICS, type MetricsPort } from '../platform/metrics/metrics.port.ts';
import { LOGGER, type JsonLogger } from '../platform/logging/json-logger.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../platform/persistence/unit-of-work.ts';
import { RANDOM_SOURCE, type RandomSource } from '../platform/random/random-source.port.ts';
import { CLOCK, type Clock } from '../shared-kernel/domain/clock.port.ts';
import { ID_GENERATOR, type IdGenerator } from '../shared-kernel/domain/id-generator.port.ts';
import { MikroOrmLedgerRepository } from '../wallets/infrastructure/mikro-orm-ledger.repository.ts';
import { MikroOrmWalletRepository } from '../wallets/infrastructure/mikro-orm-wallet.repository.ts';
import { GetTransactionUseCase } from './application/get-transaction.use-case.ts';
import { ResolvePendingReferenceUseCase } from './application/resolve-pending-reference.use-case.ts';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case.ts';
import { TransactionRecorder } from './application/transaction-recorder.ts';
import { PendingReferencePolicy } from './domain/pending-reference-policy.ts';
import { MikroOrmWagerTransactionRepository } from './infrastructure/mikro-orm-wager-transaction.repository.ts';
import { ProvidersController } from './interfaces/http/providers.controller.ts';
import {
  GET_TRANSACTION_USE_CASE,
  SUBMIT_WAGER_TRANSACTION_USE_CASE,
  WageringController,
} from './interfaces/http/wagering.controller.ts';
import { PendingReferenceWorker, RESOLVE_PENDING_REFERENCE_USE_CASE } from './interfaces/workers/pending-reference.worker.ts';

/** Gravação da decisão compartilhada pelo submit e pelo worker (R-24): repositórios sem estado, EM por chamada. */
const TRANSACTION_RECORDER = Symbol('TRANSACTION_RECORDER');

/** Contexto de apostas: injeção só por token, sem emitDecoratorMetadata (research R-02). */
@Module({
  controllers: [WageringController, ProvidersController],
  providers: [
    {
      provide: TRANSACTION_RECORDER,
      inject: [APP_CONFIG, ID_GENERATOR],
      useFactory: (config: AppConfig, ids: IdGenerator) =>
        new TransactionRecorder({
          wallets: new MikroOrmWalletRepository(),
          transactions: new MikroOrmWagerTransactionRepository(),
          ledger: new MikroOrmLedgerRepository(),
          ids,
          firstReferenceAttemptDelayMs: config.pendingWorker.backoffBaseMs,
        }),
    },
    {
      provide: SUBMIT_WAGER_TRANSACTION_USE_CASE,
      inject: [ORM, UNIT_OF_WORK, TRANSACTION_RECORDER, FAILPOINTS, CLOCK, ID_GENERATOR, LOGGER, METRICS],
      useFactory: (
        orm: MikroORM,
        unitOfWork: UnitOfWork<EntityManager>,
        recorder: TransactionRecorder,
        failpoints: Failpoints,
        clock: Clock,
        ids: IdGenerator,
        logger: JsonLogger,
        metrics: MetricsPort,
      ) =>
        new SubmitWagerTransactionUseCase({
          orm,
          unitOfWork,
          wallets: new MikroOrmWalletRepository(),
          transactions: new MikroOrmWagerTransactionRepository(),
          outbox: new MikroOrmOutboxWriter(),
          recorder,
          inbox: new MikroOrmInboxRepository(),
          failpoints,
          metrics,
          clock,
          ids,
          logger,
        }),
    },
    {
      provide: GET_TRANSACTION_USE_CASE,
      inject: [ORM],
      useFactory: (orm: MikroORM) => new GetTransactionUseCase({ orm, transactions: new MikroOrmWagerTransactionRepository() }),
    },
    {
      provide: RESOLVE_PENDING_REFERENCE_USE_CASE,
      inject: [APP_CONFIG, ORM, UNIT_OF_WORK, TRANSACTION_RECORDER, RANDOM_SOURCE, FAILPOINTS, CLOCK, LOGGER, METRICS],
      useFactory: (
        config: AppConfig,
        orm: MikroORM,
        unitOfWork: UnitOfWork<EntityManager>,
        recorder: TransactionRecorder,
        random: RandomSource,
        failpoints: Failpoints,
        clock: Clock,
        logger: JsonLogger,
        metrics: MetricsPort,
      ) => {
        const { pendingWorker } = config;
        return new ResolvePendingReferenceUseCase({
          orm,
          unitOfWork,
          wallets: new MikroOrmWalletRepository(),
          transactions: new MikroOrmWagerTransactionRepository(),
          outbox: new MikroOrmOutboxWriter(),
          recorder,
          policy: new PendingReferencePolicy({
            maxAttempts: pendingWorker.maxAttempts,
            ttlMs: pendingWorker.ttlMs,
            baseMs: pendingWorker.backoffBaseMs,
            maxMs: pendingWorker.backoffMaxMs,
            jitterRatio: pendingWorker.jitterRatio,
          }),
          random,
          failpoints,
          metrics,
          clock,
          logger,
          batchSize: pendingWorker.batchSize,
          leaseMs: pendingWorker.leaseMs,
        });
      },
    },
    // Worker de PENDING_REFERENCE (US4), ligado por PENDING_WORKER_ENABLED (R-27).
    PendingReferenceWorker,
  ],
  // O consumidor da fila (MessagingModule) reutiliza o mesmo use case do HTTP (constitution IV, FR-001).
  exports: [SUBMIT_WAGER_TRANSACTION_USE_CASE],
})
export class WageringModule {}
