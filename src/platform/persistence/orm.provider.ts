import { Inject, Injectable, type FactoryProvider, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';
import { LOGGER, type JsonLogger } from '../logging/json-logger.ts';
import { WORKER_REGISTRY, type WorkerRegistry } from '../workers/worker-registry.ts';
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

/**
 * Fecha o pool no shutdown (app.close(), disparado pelo handler de sinal do main.ts, R-35). Antes, drena os
 * trabalhadores de fundo (R-28): o Nest não garante a ordem entre providers no mesmo hook, e o pool não pode fechar com
 * uma transação de trabalhador em andamento.
 */
@Injectable()
export class OrmLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(WORKER_REGISTRY) private readonly workers: WorkerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: JsonLogger,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    const drained = await this.workers.drainAll(this.config.consumer.shutdownTimeoutMs);
    this.logger.info('shutdown.workers_drained', { event: 'shutdown.workers_drained', drained });
    await this.orm.close();
    this.logger.info('shutdown.orm_closed', { event: 'shutdown.orm_closed' });
  }
}
