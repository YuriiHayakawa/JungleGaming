import { defineConfig, type EntitySchema, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { PoolConfig } from 'pg';
import { Migration20261107000100 } from '../../../migrations/Migration20261107000100.ts';
import { Migration20261107000200 } from '../../../migrations/Migration20261107000200.ts';
import { Migration20261107000300 } from '../../../migrations/Migration20261107000300.ts';
import { Migration20261107000400 } from '../../../migrations/Migration20261107000400.ts';
import { ENTITY_SCHEMAS } from './entity-schemas.ts';

/** Migrations registradas explicitamente, sem descoberta por arquivo (data-model §2.6, spike S-08). */
export const MIGRATIONS = [
  { name: 'Migration20261107000100', class: Migration20261107000100 },
  { name: 'Migration20261107000200', class: Migration20261107000200 },
  { name: 'Migration20261107000300', class: Migration20261107000300 },
  { name: 'Migration20261107000400', class: Migration20261107000400 },
];

export interface OrmSettings {
  databaseUrl: string;
  dbPoolMax: number;
  dbPoolAcquireTimeoutMs: number;
}

/**
 * Opções do MikroORM (research R-04, R-05, R-11):
 * - o timeout de aquisição do pool vai para o pg.Pool via driverOptions, porque o PoolConfig do MikroORM 7 só tem
 *   min, max e idleTimeoutMillis (spike S-09);
 * - migrations sem arquivos de snapshot (spike S-08).
 */
export function buildOrmOptions(settings: OrmSettings, entities: EntitySchema[] = ENTITY_SCHEMAS): Options {
  const driverOptions: PoolConfig = { connectionTimeoutMillis: settings.dbPoolAcquireTimeoutMs };
  return defineConfig({
    clientUrl: settings.databaseUrl,
    entities,
    pool: { min: 0, max: settings.dbPoolMax },
    driverOptions,
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
    debug: false,
  });
}
