import { Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { LOGGER, type JsonLogger } from '../platform/logging/json-logger.ts';
import { METRICS, type MetricsPort } from '../platform/metrics/metrics.port.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case.ts';
import { MikroOrmReconciliationReader } from './infrastructure/mikro-orm-reconciliation.reader.ts';
import { RECONCILE_WALLET_USE_CASE, ReconciliationController } from './interfaces/http/reconciliation.controller.ts';

/**
 * Reconciliação (feature 003, US1): contexto próprio, que lê wallets e ledger por SQL próprio, somente leitura, sem
 * reutilizar os repositórios de escrita (plan, "Structure Decision"). Injeção só por token (001, R-02).
 */
@Module({
  controllers: [ReconciliationController],
  providers: [
    {
      provide: RECONCILE_WALLET_USE_CASE,
      inject: [ORM, LOGGER, METRICS],
      useFactory: (orm: MikroORM, logger: JsonLogger, metrics: MetricsPort) =>
        new ReconcileWalletUseCase({ orm, reader: new MikroOrmReconciliationReader(), logger, metrics }),
    },
  ],
})
export class ReconciliationModule {}
