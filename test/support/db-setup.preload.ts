// Preload de `bun test` (integração e concorrência), uma vez por execução (research R-17):
// recria o banco template já migrado do qual cada arquivo de teste clona o seu banco.
// Feature 003 (R-38): recria também o template "sem guardas", só com as migrations de tabelas, do qual os testes de
// divergência clonam o seu banco (useBareTestDatabase). Nenhum trigger é desligado: as guardas nunca são criadas ali.
// Sem TRUNCATE/DELETE para limpar dados: só bancos novos.
import { Client } from 'pg';
import { runMigrations } from '../../src/platform/persistence/run-migrations.ts';
import { ADMIN_URL, BARE_TEMPLATE_DATABASE, BARE_TEMPLATE_LAST_MIGRATION, TEMPLATE_DATABASE, databaseUrl } from './db.ts';

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
  const leftovers = await admin.query<{ datname: string; datistemplate: boolean }>(
    "SELECT datname, datistemplate FROM pg_database WHERE datname LIKE 'jg\_test\_%'",
  );
  for (const { datname, datistemplate } of leftovers.rows) {
    // O PostgreSQL não apaga um banco marcado como template, nem com FORCE.
    if (datistemplate) await admin.query(`ALTER DATABASE "${datname}" WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
    await admin.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
  }
  await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  await admin.query(`CREATE DATABASE ${BARE_TEMPLATE_DATABASE}`);
});

await runMigrations(databaseUrl(TEMPLATE_DATABASE), 'up');
await runMigrations(databaseUrl(BARE_TEMPLATE_DATABASE), 'up', { to: BARE_TEMPLATE_LAST_MIGRATION });

await withAdmin(async (admin) => {
  for (const name of [TEMPLATE_DATABASE, BARE_TEMPLATE_DATABASE]) {
    await admin.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`);
  }
});
