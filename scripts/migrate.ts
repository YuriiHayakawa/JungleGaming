// bun scripts/migrate.ts up|down — aplica ou desfaz todas as migrations sobre DATABASE_URL (S-08).
// Código de saída 0 em sucesso e diferente de 0 em erro.
import { runMigrations } from '../src/platform/persistence/run-migrations.ts';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error(JSON.stringify({ level: 'error', msg: 'usage: bun scripts/migrate.ts up|down' }));
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(JSON.stringify({ level: 'error', msg: 'DATABASE_URL is required' }));
  process.exit(2);
}

try {
  const migrations = await runMigrations(databaseUrl, direction);
  console.log(JSON.stringify({ level: 'info', msg: 'migrations.done', direction, migrations }));
  process.exit(0);
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'migrations.failed',
      direction,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
