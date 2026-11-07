// Acesso direto ao PostgreSQL real do Compose, para os testes. Nada de mock (constitution VII).
import { Client, Pool, type PoolClient } from 'pg';

export const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://junglegaming:junglegaming@localhost:5432/postgres';

export const TEMPLATE_DATABASE = 'jg_test_template';

/** URL do banco `name` no mesmo servidor do ADMIN_URL. */
export function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Converte placeholders `?` (convenção do projeto) para `$n` do driver, ignorando `?` dentro de aspas simples. */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let inQuote = false;
  for (const ch of sql) {
    if (ch === "'") inQuote = !inQuote;
    if (ch === '?' && !inQuote) {
      index += 1;
      out += `$${index}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export type Row = Record<string, unknown>;

export interface Queryable {
  query<R extends Row = Row>(sql: string, params?: unknown[]): Promise<R[]>;
}

function wrap(target: Pool | PoolClient | Client): Queryable {
  return {
    async query<R extends Row = Row>(sql: string, params: unknown[] = []) {
      const result = await target.query(toPgPlaceholders(sql), params);
      return result.rows as R[];
    },
  };
}

/** Pool pequeno sobre um banco de teste. */
export class TestDb implements Queryable {
  private readonly pool: Pool;

  constructor(readonly url: string, max = 5) {
    this.pool = new Pool({ connectionString: url, max });
  }

  async query<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R[]> {
    return wrap(this.pool).query<R>(sql, params);
  }

  /** Executa `fn` numa transação; faz rollback se `fn` lançar e propaga o erro (inclusive o do COMMIT). */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Conexão dedicada, para testes que seguram locks ou transações abertas. */
  async connect(): Promise<{ q: Queryable; release(): void }> {
    const client = await this.pool.connect();
    return { q: wrap(client), release: () => client.release() };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Comando administrativo (CREATE/DROP/ALTER DATABASE) numa conexão própria ao banco `postgres`. */
export async function adminExec(sql: string, params: unknown[] = []): Promise<Row[]> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const result = await client.query(toPgPlaceholders(sql), params);
    return result.rows as Row[];
  } finally {
    await client.end();
  }
}

/** Nome de banco seguro para identificador: minúsculas, dígitos e _, com sufixo aleatório. */
export function uniqueDatabaseName(tag: string): string {
  const safe = tag.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30);
  return `jg_test_${safe}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}
