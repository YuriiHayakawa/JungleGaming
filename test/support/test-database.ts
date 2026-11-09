// Banco próprio por arquivo de teste, clonado do template já migrado (research R-17). Sem limpeza de dados.
import { afterAll, beforeAll } from 'bun:test';
import { BARE_TEMPLATE_DATABASE, TEMPLATE_DATABASE, TestDb, adminExec, databaseUrl, uniqueDatabaseName } from './db.ts';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly db: TestDb;
}

function useDatabaseFrom(template: string, tag: string): TestDatabase {
  let name: string | undefined;
  let db: TestDb | undefined;

  beforeAll(async () => {
    name = uniqueDatabaseName(tag);
    await adminExec(`CREATE DATABASE ${name} TEMPLATE ${template}`);
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

/** Registra beforeAll/afterAll: cria `jg_test_<tag>_<aleatório>` a partir do template e o apaga no fim. */
export function useTestDatabase(tag: string): TestDatabase {
  return useDatabaseFrom(TEMPLATE_DATABASE, tag);
}

/**
 * Banco **sem as guardas** do armazenamento (feature 003, R-38), clonado do template próprio criado pelo preload só com
 * as migrations de tabelas (até Migration20261107000300): os CHECKs e as unicidades das tabelas valem, mas as funções e
 * os triggers da Migration20261107000400 nunca existiram ali, então um `UPDATE` direto consegue provocar a divergência
 * que a reconciliação precisa detectar. Nenhum trigger é desligado em nenhum banco. Só os testes de divergência
 * (reconciliação e métricas) podem importá-lo (guardrail (j), T034).
 */
export function useBareTestDatabase(tag: string): TestDatabase {
  return useDatabaseFrom(BARE_TEMPLATE_DATABASE, tag);
}
