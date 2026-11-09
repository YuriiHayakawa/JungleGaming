import { Module } from '@nestjs/common';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { MessagingModule } from '../messaging/messaging.module.ts';
import { SQS_PORT, type SqsPort } from '../messaging/application/sqs.port.ts';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config.ts';
import { FAILPOINTS, type Failpoints } from '../platform/failpoints/failpoints.ts';
import { LOGGER, type JsonLogger } from '../platform/logging/json-logger.ts';
import { METRICS, type MetricsPort } from '../platform/metrics/metrics.port.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../platform/persistence/unit-of-work.ts';
import { CLOCK, type Clock } from '../shared-kernel/domain/clock.port.ts';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case.ts';
import { MikroOrmOutboxRepository } from './infrastructure/mikro-orm-outbox.repository.ts';
import { OutboxPublisherWorker, PUBLISH_OUTBOX_USE_CASE } from './interfaces/outbox-publisher.worker.ts';

/** Publicação da outbox (feature 002, US3): use case e trabalhador de fundo, sobre a porta SQS do MessagingModule. */
@Module({
  imports: [MessagingModule],
  providers: [
    {
      provide: PUBLISH_OUTBOX_USE_CASE,
      inject: [APP_CONFIG, ORM, UNIT_OF_WORK, SQS_PORT, FAILPOINTS, METRICS, CLOCK, LOGGER],
      useFactory: (
        config: AppConfig,
        orm: MikroORM,
        unitOfWork: UnitOfWork<EntityManager>,
        sqs: SqsPort,
        failpoints: Failpoints,
        metrics: MetricsPort,
        clock: Clock,
        logger: JsonLogger,
      ) =>
        new PublishOutboxUseCase({
          orm,
          unitOfWork,
          outbox: new MikroOrmOutboxRepository(),
          sqs,
          eventsQueue: config.sqs.eventsQueue,
          batchSize: config.publisher.batchSize,
          leaseMs: config.publisher.leaseMs,
          backoff: { minMs: config.publisher.backoffMinMs, maxMs: config.publisher.backoffMaxMs },
          failpoints,
          metrics,
          clock,
          logger,
        }),
    },
    OutboxPublisherWorker,
  ],
})
export class OutboxModule {}
