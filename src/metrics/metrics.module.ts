import { Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxLagReader } from '../outbox/infrastructure/outbox-lag.reader.ts';
import { LOGGER, type JsonLogger } from '../platform/logging/json-logger.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import { CLOCK, type Clock } from '../shared-kernel/domain/clock.port.ts';
import { MetricsController, OUTBOX_LAG_READER } from './interfaces/http/metrics.controller.ts';

/**
 * Exposição das métricas (feature 003, US3). O provider `METRICS` continua no `AppModule` (002); este módulo só lê.
 * Injeção só por token (001, R-02).
 */
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: OUTBOX_LAG_READER,
      inject: [ORM, CLOCK, LOGGER],
      useFactory: (orm: MikroORM, clock: Clock, logger: JsonLogger) => new OutboxLagReader({ orm, clock, logger }),
    },
  ],
})
export class MetricsModule {}
