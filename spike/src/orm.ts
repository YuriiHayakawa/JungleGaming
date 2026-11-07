// S-04, S-05, S-06, S-07, S-09. Spike descartável.
import { DecimalType, EntitySchema, MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { MIGRATIONS } from './migrations.ts';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://spike:spike@localhost:55432/spike';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'spike_wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id', length: 255 },
    currency: { type: 'string', length: 3 },
    balance: { type: new DecimalType('string'), precision: 18, scale: 2 },
    version: { type: 'integer' },
  },
});

export interface OrmOptions {
  poolMax?: number;
  acquireTimeoutMs?: number;
}

export function initOrm(options: OrmOptions = {}): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: DATABASE_URL,
    entities: [WalletSchema],
    pool: { min: 0, max: options.poolMax ?? 10 },
    driverOptions: { connectionTimeoutMillis: options.acquireTimeoutMs ?? 8000 },
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'spike_migrations',
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
    debug: false,
  });
}
