import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from './platform/config/app-config.ts';
import { LOGGER, type JsonLogger } from './platform/logging/json-logger.ts';
import { EnvFailpoints, FAILPOINTS } from './platform/failpoints/failpoints.ts';
import { GlobalExceptionFilter } from './platform/http/global-exception.filter.ts';
import { NoopAuthGuard } from './platform/auth/noop-auth.guard.ts';
import { NoopProviderIdentity, PROVIDER_IDENTITY } from './platform/auth/provider-identity.port.ts';
import { ORM, ormProvider, OrmLifecycle } from './platform/persistence/orm.provider.ts';
import { UNIT_OF_WORK, UnitOfWork } from './platform/persistence/unit-of-work.ts';
import { CLOCK } from './shared-kernel/domain/clock.port.ts';
import { ID_GENERATOR } from './shared-kernel/domain/id-generator.port.ts';
import { SystemClock } from './shared-kernel/infrastructure/system-clock.ts';
import { UuidV7IdGenerator } from './shared-kernel/infrastructure/uuidv7-id-generator.ts';
import { WageringModule } from './wagering/wagering.module.ts';
import { WalletsModule } from './wallets/wallets.module.ts';

export interface AppModuleOptions {
  logger: JsonLogger;
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
      {
        provide: FAILPOINTS,
        useFactory: () => new EnvFailpoints({ failpoint: config.failpoint, nodeEnv: config.nodeEnv }),
      },
      ormProvider,
      OrmLifecycle,
      {
        provide: UNIT_OF_WORK,
        inject: [ORM],
        useFactory: (orm: MikroORM) => new UnitOfWork(orm.em, config.walletLockTimeoutMs),
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
      imports: [WalletsModule, WageringModule],
      providers,
      exports: [APP_CONFIG, LOGGER, CLOCK, ID_GENERATOR, FAILPOINTS, ORM, UNIT_OF_WORK, PROVIDER_IDENTITY],
    };
  }
}
