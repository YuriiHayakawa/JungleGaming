import { Inject, Injectable, type FactoryProvider, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';
import { ENTITY_SCHEMAS } from './entity-schemas.ts';
import { buildOrmOptions } from './mikro-orm.config.ts';

/**
 * Token do MikroORM. Não há EntityManager global compartilhado: cada execução de use case usa `orm.em.fork()`
 * (identity map novo) ou a unit of work, que faz o fork (research R-05). Sem @mikro-orm/nestjs.
 */
export const ORM = Symbol('ORM');

export const ormProvider: FactoryProvider<Promise<MikroORM>> = {
  provide: ORM,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => MikroORM.init(buildOrmOptions(config, ENTITY_SCHEMAS)),
};

/** Fecha o pool no shutdown (app.close() ou SIGTERM com enableShutdownHooks). */
@Injectable()
export class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
