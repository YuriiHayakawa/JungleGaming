import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmOptions } from './mikro-orm.config.ts';

/**
 * Aplica (`up`) ou desfaz todas (`down`) as migrations, pela API programática do MikroORM (spike S-08).
 * Usado por scripts/migrate.ts e pelo preload dos testes. Devolve os nomes executados, em ordem.
 */
export async function runMigrations(databaseUrl: string, direction: 'up' | 'down'): Promise<string[]> {
  const orm = await MikroORM.init(buildOrmOptions({ databaseUrl, dbPoolMax: 1, dbPoolAcquireTimeoutMs: 10_000 }));
  try {
    const executed = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down({ to: 0 });
    return executed.map((m) => m.name);
  } finally {
    await orm.close(true);
  }
}
