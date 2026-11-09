import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from './platform/config/app-config.ts';
import { LOGGER, type JsonLogger } from './platform/logging/json-logger.ts';
import { EnvFailpoints, FAILPOINTS } from './platform/failpoints/failpoints.ts';
import { InMemoryMetrics } from './platform/metrics/in-memory-metrics.ts';
import { METRICS, type MetricsPort } from './platform/metrics/metrics.port.ts';
import { CryptoRandomSource } from './platform/random/crypto-random-source.ts';
import { RANDOM_SOURCE, type RandomSource } from './platform/random/random-source.port.ts';
import { WORKER_REGISTRY, WorkerRegistry } from './platform/workers/worker-registry.ts';
import { GlobalExceptionFilter } from './platform/http/global-exception.filter.ts';
import { NoopAuthGuard } from './platform/auth/noop-auth.guard.ts';
import { NoopProviderIdentity, PROVIDER_IDENTITY } from './platform/auth/provider-identity.port.ts';
import { ORM, ormProvider, OrmLifecycle } from './platform/persistence/orm.provider.ts';
import { UNIT_OF_WORK, UnitOfWork } from './platform/persistence/unit-of-work.ts';
import { CLOCK } from './shared-kernel/domain/clock.port.ts';
import { ID_GENERATOR } from './shared-kernel/domain/id-generator.port.ts';
import { SystemClock } from './shared-kernel/infrastructure/system-clock.ts';
import { UuidV7IdGenerator } from './shared-kernel/infrastructure/uuidv7-id-generator.ts';
import { MessagingModule } from './messaging/messaging.module.ts';
import { OutboxModule } from './outbox/outbox.module.ts';
import { WageringModule } from './wagering/wagering.module.ts';
import { WalletsModule } from './wallets/wallets.module.ts';

export interface AppModuleOptions {
  logger: JsonLogger;
  /** Fonte do jitter; padrão CryptoRandomSource (testes em processo passam um FixedRandom). */
  random?: RandomSource;
}

/**
 * Módulo raiz. Toda injeção é por token (`@Inject(TOKEN)`), sem emitDecoratorMetadata (research R-02).
 * Os módulos de contexto importados aqui recebem os tokens globais (ORM, UNIT_OF_WORK, CLOCK, ID_GENERATOR...).
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, options: AppModuleOptions): DynamicModule {
    const providers = [
      { provide: APP_CONFIG, useValue: config },
      { provide: LOGGER, useValue: options.logger },
      { provide: CLOCK, useClass: SystemClock },
      { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
      // Porta de métricas em memória, uma por instância (FR-036, R-32); jitter pela porta RandomSource (R-25).
      // Fora de NODE_ENV=test, amostra fora do contrato é descartada com aviso, nunca lança (003, R-43).
      {
        provide: METRICS,
        useValue: new InMemoryMetrics({
          nodeEnv: config.nodeEnv,
          warn: (message, fields) => options.logger.warn(message, fields),
        }),
      },
      { provide: RANDOM_SOURCE, useValue: options.random ?? new CryptoRandomSource() },
      {
        provide: FAILPOINTS,
        useFactory: () => new EnvFailpoints({ failpoint: config.failpoint, nodeEnv: config.nodeEnv }),
      },
      // Trabalhadores de fundo registrados para o término gracioso (R-28); drenados antes do fechamento do pool.
      { provide: WORKER_REGISTRY, useValue: new WorkerRegistry() },
      ormProvider,
      OrmLifecycle,
      {
        provide: UNIT_OF_WORK,
        inject: [ORM, METRICS],
        useFactory: (orm: MikroORM, metrics: MetricsPort) => new UnitOfWork(orm.em, config.walletLockTimeoutMs, metrics),
      },
      { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
      { provide: APP_GUARD, useClass: NoopAuthGuard },
      {
        provide: APP_FILTER,
        inject: [LOGGER],
        useFactory: (logger: JsonLogger) => new GlobalExceptionFilter(config, logger),
      },
    ];
    return {
      module: AppModule,
      global: true,
      imports: [WalletsModule, WageringModule, MessagingModule, OutboxModule],
      providers,
      exports: [
        APP_CONFIG,
        LOGGER,
        CLOCK,
        ID_GENERATOR,
        METRICS,
        RANDOM_SOURCE,
        WORKER_REGISTRY,
        FAILPOINTS,
        ORM,
        UNIT_OF_WORK,
        PROVIDER_IDENTITY,
      ],
    };
  }
}
