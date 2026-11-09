import type { MikroORM } from '@mikro-orm/postgresql';
import type { JsonLogger } from '../../platform/logging/json-logger.ts';
import type { OutboxLagGauges } from '../../platform/metrics/prometheus-text.ts';
import type { Clock } from '../../shared-kernel/domain/clock.port.ts';

/** Prazo da leitura dos gauges na coleta (R-44), o mesmo das checagens do ready. */
export const OUTBOX_LAG_TIMEOUT_MS = 2000;

interface LagRow {
  pending: string;
  oldest: Date | string | null;
}

/**
 * Atraso da outbox medido na hora da coleta (R-44; data-model §2.3; FR-021, FR-022): uma consulta só, coberta pelo
 * índice parcial `outbox_pending_idx` da 001 (só linhas pendentes). A idade vem da porta `Clock` (constitution VI).
 * Somente leitura. Banco fora ou prazo esgotado → `undefined` (os dois gauges são omitidos) e um aviso no log, sem
 * derrubar a coleta.
 */
export class OutboxLagReader {
  constructor(
    private readonly deps: {
      orm: Pick<MikroORM, 'em'>;
      clock: Clock;
      logger: Pick<JsonLogger, 'warn'>;
      timeoutMs?: number;
    },
  ) {}

  async read(): Promise<OutboxLagGauges | undefined> {
    const timeoutMs = this.deps.timeoutMs ?? OUTBOX_LAG_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = this.deps.orm.em
      .fork()
      .execute<LagRow[]>('SELECT count(*)::text AS pending, min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL');
    try {
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const result = await Promise.race([query, deadline]);
      if (result === 'timeout') throw new Error(`outbox lag query did not finish in ${timeoutMs} ms`);
      const [row] = result;
      if (!row) throw new Error('outbox lag query returned no row');
      if (!/^\d+$/.test(row.pending)) throw new Error(`invalid pending count: ${row.pending}`);
      const pendingEvents = Number.parseInt(row.pending, 10);
      const oldest = row.oldest === null ? undefined : new Date(row.oldest);
      const ageMs = oldest ? Math.max(0, this.deps.clock.now().getTime() - oldest.getTime()) : 0;
      return { pendingEvents, oldestPendingAgeSeconds: ageMs / 1000 };
    } catch (error) {
      query.catch(() => {}); // a consulta que passou do prazo pode falhar depois; não vira rejeição não tratada
      this.deps.logger.warn('metrics.outbox_lag_unavailable', {
        event: 'metrics.outbox_lag_unavailable',
        error: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
