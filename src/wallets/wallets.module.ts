import { Module } from '@nestjs/common';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmOutboxWriter } from '../outbox/infrastructure/mikro-orm-outbox.writer.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../platform/persistence/unit-of-work.ts';
import { CLOCK, type Clock } from '../shared-kernel/domain/clock.port.ts';
import { ID_GENERATOR, type IdGenerator } from '../shared-kernel/domain/id-generator.port.ts';
import { MikroOrmWagerTransactionRepository } from '../wagering/infrastructure/mikro-orm-wager-transaction.repository.ts';
import { CreateWalletUseCase } from './application/create-wallet.use-case.ts';
import { MikroOrmLedgerRepository } from './infrastructure/mikro-orm-ledger.repository.ts';
import { MikroOrmWalletRepository } from './infrastructure/mikro-orm-wallet.repository.ts';
import { CREATE_WALLET_USE_CASE, WalletsController } from './interfaces/http/wallets.controller.ts';

/** Contexto de wallets: injeção só por token, sem emitDecoratorMetadata (research R-02). */
@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: CREATE_WALLET_USE_CASE,
      inject: [ORM, UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (orm: MikroORM, unitOfWork: UnitOfWork<EntityManager>, clock: Clock, ids: IdGenerator) =>
        new CreateWalletUseCase({
          orm,
          unitOfWork,
          wallets: new MikroOrmWalletRepository(),
          ledger: new MikroOrmLedgerRepository(),
          transactions: new MikroOrmWagerTransactionRepository(),
          outbox: new MikroOrmOutboxWriter(),
          clock,
          ids,
        }),
    },
  ],
})
export class WalletsModule {}
