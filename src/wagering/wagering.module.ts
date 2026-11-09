import { Module } from '@nestjs/common';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmInboxRepository } from '../inbox/infrastructure/mikro-orm-inbox.repository.ts';
import { MikroOrmOutboxWriter } from '../outbox/infrastructure/mikro-orm-outbox.writer.ts';
import { FAILPOINTS, type Failpoints } from '../platform/failpoints/failpoints.ts';
import { LOGGER, type JsonLogger } from '../platform/logging/json-logger.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../platform/persistence/unit-of-work.ts';
import { CLOCK, type Clock } from '../shared-kernel/domain/clock.port.ts';
import { ID_GENERATOR, type IdGenerator } from '../shared-kernel/domain/id-generator.port.ts';
import { MikroOrmLedgerRepository } from '../wallets/infrastructure/mikro-orm-ledger.repository.ts';
import { MikroOrmWalletRepository } from '../wallets/infrastructure/mikro-orm-wallet.repository.ts';
import { GetTransactionUseCase } from './application/get-transaction.use-case.ts';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case.ts';
import { MikroOrmWagerTransactionRepository } from './infrastructure/mikro-orm-wager-transaction.repository.ts';
import { ProvidersController } from './interfaces/http/providers.controller.ts';
import {
  GET_TRANSACTION_USE_CASE,
  SUBMIT_WAGER_TRANSACTION_USE_CASE,
  WageringController,
} from './interfaces/http/wagering.controller.ts';

/** Contexto de apostas: injeção só por token, sem emitDecoratorMetadata (research R-02). */
@Module({
  controllers: [WageringController, ProvidersController],
  providers: [
    {
      provide: SUBMIT_WAGER_TRANSACTION_USE_CASE,
      inject: [ORM, UNIT_OF_WORK, FAILPOINTS, CLOCK, ID_GENERATOR, LOGGER],
      useFactory: (
        orm: MikroORM,
        unitOfWork: UnitOfWork<EntityManager>,
        failpoints: Failpoints,
        clock: Clock,
        ids: IdGenerator,
        logger: JsonLogger,
      ) =>
        new SubmitWagerTransactionUseCase({
          orm,
          unitOfWork,
          wallets: new MikroOrmWalletRepository(),
          transactions: new MikroOrmWagerTransactionRepository(),
          ledger: new MikroOrmLedgerRepository(),
          outbox: new MikroOrmOutboxWriter(),
          inbox: new MikroOrmInboxRepository(),
          failpoints,
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
  ],
  // O consumidor da fila (MessagingModule) reutiliza o mesmo use case do HTTP (constitution IV, FR-001).
  exports: [SUBMIT_WAGER_TRANSACTION_USE_CASE],
})
export class WageringModule {}
