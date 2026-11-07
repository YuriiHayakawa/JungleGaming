// S-08: script programático `bun src/migrate.ts up|down`.
import { initOrm } from './orm.ts';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: bun src/migrate.ts up|down');
  process.exit(2);
}
const orm = await initOrm();
try {
  const result = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down({ to: 0 });
  console.log(JSON.stringify({ direction, migrations: result.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
