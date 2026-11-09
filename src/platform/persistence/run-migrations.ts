import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmOptions } from './mikro-orm.config.ts';

export interface RunMigrationsOptions {
  /**
   * Só com `up`: aplica até esta migration, inclusive (o `migrator.up({ to })` do MikroORM). Usado pelos testes de
   * divergência da 003 para criar um banco só com as migrations de tabelas, sem as guardas (research R-38).
   */
  to?: string;
}

/**
 * Aplica (`up`) ou desfaz todas (`down`) as migrations, pela API programática do MikroORM (spike S-08).
 * Usado por scripts/migrate.ts e pelo preload dos testes. Devolve os nomes executados, em ordem.
 */
export async function runMigrations(
  databaseUrl: string,
  direction: 'up' | 'down',
  options: RunMigrationsOptions = {},
): Promise<string[]> {
  if (options.to !== undefined && direction !== 'up') throw new Error('runMigrations: `to` is only supported with "up"');
  const orm = await MikroORM.init(buildOrmOptions({ databaseUrl, dbPoolMax: 1, dbPoolAcquireTimeoutMs: 10_000 }));
  try {
    const executed =
      direction === 'up'
        ? await orm.migrator.up(options.to !== undefined ? { to: options.to } : undefined)
        : await orm.migrator.down({ to: 0 });
    return executed.map((m) => m.name);
  } finally {
    await orm.close(true);
  }
}
