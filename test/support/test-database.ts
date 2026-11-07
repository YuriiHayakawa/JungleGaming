// Banco próprio por arquivo de teste, clonado do template já migrado (research R-17). Sem limpeza de dados.
import { afterAll, beforeAll } from 'bun:test';
import { TEMPLATE_DATABASE, TestDb, adminExec, databaseUrl, uniqueDatabaseName } from './db.ts';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly db: TestDb;
}

/** Registra beforeAll/afterAll: cria `jg_test_<tag>_<aleatório>` a partir do template e o apaga no fim. */
export function useTestDatabase(tag: string): TestDatabase {
  let name: string | undefined;
  let db: TestDb | undefined;

  beforeAll(async () => {
    name = uniqueDatabaseName(tag);
    await adminExec(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
    db = new TestDb(databaseUrl(name));
  });

  afterAll(async () => {
    await db?.close();
    if (name) await adminExec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });

  const required = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`test database not ready: ${what} (use inside tests or hooks)`);
    return value;
  };

  return {
    get name() {
      return required(name, 'name');
    },
    get url() {
      return databaseUrl(required(name, 'url'));
    },
    get db() {
      return required(db, 'db');
    },
  };
}
