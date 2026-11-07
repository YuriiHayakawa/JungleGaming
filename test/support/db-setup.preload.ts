// Preload de `bun test` (integração e concorrência), uma vez por execução (research R-17):
// recria o banco template já migrado do qual cada arquivo de teste clona o seu banco.
// Sem TRUNCATE/DELETE para limpar dados: só bancos novos.
import { Client } from 'pg';
import { runMigrations } from '../../src/platform/persistence/run-migrations.ts';
import { ADMIN_URL, TEMPLATE_DATABASE, databaseUrl } from './db.ts';

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

await withAdmin(async (admin) => {
  const template = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEMPLATE_DATABASE]);
  if (template.rowCount) {
    // O PostgreSQL não apaga um banco marcado como template, nem com FORCE.
    await admin.query(`ALTER DATABASE ${TEMPLATE_DATABASE} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
  }
  const leftovers = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'jg\\_test\\_%'",
  );
  for (const { datname } of leftovers.rows) {
    await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
  }
  await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
});

await runMigrations(databaseUrl(TEMPLATE_DATABASE), 'up');

await withAdmin(async (admin) => {
  await admin.query(`ALTER DATABASE ${TEMPLATE_DATABASE} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`);
});
