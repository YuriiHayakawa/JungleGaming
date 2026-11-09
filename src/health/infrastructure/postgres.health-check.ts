import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Checagem do PostgreSQL para o ready (R-39; data-model §2.2): `SELECT 1` num fork do EM, fora de transação. Somente
 * leitura. O prazo é aplicado por quem chama (`withTimeout`).
 */
export class PostgresHealthCheck {
  constructor(private readonly orm: Pick<MikroORM, 'em'>) {}

  async check(): Promise<void> {
    await this.orm.em.fork().execute('SELECT 1');
  }
}
