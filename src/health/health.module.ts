import { Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MessagingModule } from '../messaging/messaging.module.ts';
import { SQS_PORT, type SqsPort } from '../messaging/application/sqs.port.ts';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import { PostgresHealthCheck } from './infrastructure/postgres.health-check.ts';
import { SqsHealthCheck } from './infrastructure/sqs.health-check.ts';
import { HealthController, POSTGRES_HEALTH_CHECK, SQS_HEALTH_CHECK } from './interfaces/http/health.controller.ts';

/**
 * Health (feature 003, US2): liveness e readiness. A fila é checada em toda instância, qualquer que seja o papel ligado
 * (R-39, enunciado §9). Injeção só por token (001, R-02).
 */
@Module({
  imports: [MessagingModule],
  controllers: [HealthController],
  providers: [
    { provide: POSTGRES_HEALTH_CHECK, inject: [ORM], useFactory: (orm: MikroORM) => new PostgresHealthCheck(orm) },
    {
      provide: SQS_HEALTH_CHECK,
      inject: [SQS_PORT, APP_CONFIG],
      useFactory: (sqs: SqsPort, config: AppConfig) =>
        new SqsHealthCheck(sqs, [config.sqs.transactionsQueue, config.sqs.transactionsDlq, config.sqs.eventsQueue]),
    },
  ],
})
export class HealthModule {}
