// T045 (001) e T015 (002) — migrations up → down → up, pela API e pelo script real (constitution V, data-model §2.6, spike S-08).
// Usa bancos próprios criados de template0 (sem as migrations do template).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../../src/platform/persistence/run-migrations.ts';
import { TestDb, adminExec, databaseUrl, uniqueDatabaseName } from '../support/db.ts';

const ROOT = join(import.meta.dir, '..', '..');
const TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];
const TRIGGERS = [
  'inbox_no_truncate_trg',
  'inbox_no_update_delete_trg',
  'ledger_before_insert_trg',
  'ledger_no_truncate_trg',
  'ledger_no_update_delete_trg',
  'wager_tx_guard_trg',
  'wager_tx_no_truncate_trg',
  'wallets_guard_trg',
  'wallets_match_ledger_tail_trg',
];
const FUNCTIONS = [
  'jg_forbid_mutation',
  'jg_ledger_before_insert',
  'jg_wager_tx_guard',
  'jg_wallet_matches_ledger_tail',
  'jg_wallets_guard',
];
const INDEXES = [
  'inbox_transaction_idx',
  'ledger_wallet_seq_idx',
  'outbox_pending_idx',
  'wager_tx_pending_by_reference_idx',
  'wager_tx_pending_due_idx',
  'wager_tx_single_reversal_uq',
];
const MIGRATIONS = [
  'Migration20261107000100',
  'Migration20261107000200',
  'Migration20261107000300',
  'Migration20261107000400',
  'Migration20261108000100',
  'Migration20261108000200',
];

let apiDb: string;
let scriptDb: string;

beforeAll(async () => {
  apiDb = uniqueDatabaseName('migrations_api');
  scriptDb = uniqueDatabaseName('migrations_script');
  await adminExec(`CREATE DATABASE ${apiDb} TEMPLATE template0`);
  await adminExec(`CREATE DATABASE ${scriptDb} TEMPLATE template0`);
});

afterAll(async () => {
  for (const name of [apiDb, scriptDb]) {
    if (name) await adminExec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
});

async function catalog(url: string) {
  const db = new TestDb(url, 1);
  try {
    const names = async (sql: string, params: unknown[] = []) =>
      (await db.query<{ name: string }>(sql, params)).map((r) => r.name).sort((a, b) => a.localeCompare(b));
    return {
      tables: await names(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'",
      ),
      triggers: await names('SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal'),
      functions: await names(
        "SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'",
      ),
      indexes: await names(
        "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY(?)",
        [INDEXES],
      ),
    };
  } finally {
    await db.close();
  }
}

const sorted = (names: string[]) => [...names].sort((a, b) => a.localeCompare(b));

function expectFullSchema(c: Awaited<ReturnType<typeof catalog>>) {
  expect(c.tables).toEqual(sorted(TABLES));
  expect(c.triggers).toEqual(sorted(TRIGGERS));
  expect(c.functions).toEqual(sorted(FUNCTIONS));
  expect(c.indexes).toEqual(sorted(INDEXES));
}

function expectEmptySchema(c: Awaited<ReturnType<typeof catalog>>) {
  expect(c.tables).toEqual([]);
  expect(c.triggers).toEqual([]);
  expect(c.functions).toEqual([]);
  expect(c.indexes).toEqual([]);
}

function snapshotFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, recursive: boolean) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.includes('.snapshot')) found.push(join(dir, entry.name));
      if (recursive && entry.isDirectory()) walk(join(dir, entry.name), true);
    }
  };
  walk(ROOT, false);
  walk(join(ROOT, 'migrations'), true);
  walk(join(ROOT, 'src'), true);
  return found;
}

describe('pela API programática (runMigrations)', () => {
  test('up → down → up deixa o catálogo no estado esperado', async () => {
    const url = databaseUrl(apiDb);

    expect(await runMigrations(url, 'up')).toEqual(MIGRATIONS);
    expectFullSchema(await catalog(url));

    expect(await runMigrations(url, 'down')).toEqual([...MIGRATIONS].reverse());
    expectEmptySchema(await catalog(url));

    expect(await runMigrations(url, 'up')).toEqual(MIGRATIONS);
    expectFullSchema(await catalog(url));
  });

  test('nenhum arquivo de snapshot é criado no repositório', () => {
    expect(snapshotFiles()).toEqual([]);
  });
});

describe('pelo script real (bun scripts/migrate.ts), via Bun.spawn', () => {
  async function runScript(direction: 'up' | 'down', url: string) {
    const proc = Bun.spawn(['bun', join(ROOT, 'scripts', 'migrate.ts'), direction], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  test('up e down saem com código 0 e alteram o catálogo', async () => {
    const url = databaseUrl(scriptDb);

    const up = await runScript('up', url);
    expect(up.code).toBe(0);
    expect(up.stdout).toContain('"direction":"up"');
    expectFullSchema(await catalog(url));

    const down = await runScript('down', url);
    expect(down.code).toBe(0);
    expectEmptySchema(await catalog(url));
  }, 60_000);

  test('DATABASE_URL inválida sai com código diferente de 0', async () => {
    const result = await runScript('up', 'postgresql://junglegaming:junglegaming@127.0.0.1:1/nope');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('migrations.failed');
  }, 60_000);
});

// T001 da 003 (R-38): `to` aplica só as migrations de tabelas, sem as guardas (banco do teste de divergência).
describe('runMigrations com { to } (R-38)', () => {
  let bareDb: string | undefined;

  afterAll(async () => {
    if (bareDb) await adminExec(`DROP DATABASE IF EXISTS ${bareDb} WITH (FORCE)`);
  });

  test("até Migration20261107000300: as quatro tabelas da 001, sem funções nem triggers de guarda", async () => {
    bareDb = uniqueDatabaseName('migrations_to');
    await adminExec(`CREATE DATABASE ${bareDb} TEMPLATE template0`);
    const url = databaseUrl(bareDb);

    expect(await runMigrations(url, 'up', { to: 'Migration20261107000300' })).toEqual(MIGRATIONS.slice(0, 3));
    const c = await catalog(url);
    expect(c.tables).toEqual(sorted(['outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']));
    expect(c.functions).not.toContain('jg_wallet_matches_ledger_tail');
    expect(c.functions).toEqual([]);
    expect(c.triggers).not.toContain('ledger_before_insert_trg');
    expect(c.triggers).toEqual([]);
    expect(c.indexes).toEqual(sorted(['ledger_wallet_seq_idx', 'outbox_pending_idx', 'wager_tx_single_reversal_uq']));

    // Sem `to`, continua aplicando tudo o que falta (comportamento de antes).
    expect(await runMigrations(url, 'up')).toEqual(MIGRATIONS.slice(3));
    expectFullSchema(await catalog(url));
  });
});
