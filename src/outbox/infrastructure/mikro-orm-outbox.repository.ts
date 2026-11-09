import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/outbox-message.ts';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  correlation_id: string;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

function toDomain(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload,
    correlationId: row.correlation_id,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    ...(row.published_at ? { publishedAt: new Date(row.published_at) } : {}),
  });
}

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

/**
 * Leitura e marcação da outbox pelo publicador (data-model da 002, §3.2; research R-34). SQL com `?`; EM por chamada
 * (001, R-19). A gravação continua no `MikroOrmOutboxWriter`, dentro da transação do efeito.
 */
export class MikroOrmOutboxRepository {
  /**
   * Claim com lease (I-31, I-65): numa transação curta — o `em` recebido DEVE ser o de uma transação aberta —, reserva
   * até `batch` eventos pendentes e vencidos (ordem `next_attempt_at, id`, determinística no empate) com `FOR UPDATE SKIP LOCKED` (publicadores concorrentes nunca esperam uns
   * pelos outros nem pegam a mesma linha) e avança `next_attempt_at` para `now + leaseMs`. Depois do commit, outro
   * publicador só vê esses eventos de novo quando o lease vence (queda antes de publicar → retomada, FR-017).
   */
  async claim(em: EntityManager, now: Date, batch: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await em.execute<OutboxRow[]>(
      `SELECT id, aggregate_id, event_type, event_version, payload, correlation_id, occurred_at, attempts,
              next_attempt_at, published_at
         FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= ?
        ORDER BY next_attempt_at, id
        LIMIT ?
          FOR UPDATE SKIP LOCKED`,
      [now, batch],
    );
    if (rows.length === 0) return [];
    const leaseUntil = new Date(now.getTime() + leaseMs);
    await em.execute(`UPDATE outbox_messages SET next_attempt_at = ? WHERE id IN (${placeholders(rows.length)})`, [
      leaseUntil,
      ...rows.map((row) => row.id),
    ]);
    return rows.map((row) => toDomain({ ...row, next_attempt_at: leaseUntil }));
  }

  /**
   * Marca como publicado, só depois do SendMessage aceito (FR-019). Idempotente: `WHERE published_at IS NULL` — se dois
   * publicadores marcarem o mesmo evento (lease vencido no meio do envio), o primeiro instante fica. Devolve se marcou.
   */
  async markPublished(em: EntityManager, id: string, at: Date): Promise<boolean> {
    const result = await em.execute<{ affectedRows?: number }>(
      'UPDATE outbox_messages SET published_at = ? WHERE id = ? AND published_at IS NULL',
      [at, id],
      'run',
    );
    return (result.affectedRows ?? 0) > 0;
  }

  /**
   * Devolve eventos reservados e não tentados (lote interrompido pela falha de envio de outro evento, N-22):
   * `next_attempt_at = at` (agora), sem incrementar `attempts`, para que voltem na próxima reserva sem esperar o lease.
   */
  async release(em: EntityManager, ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await em.execute(
      `UPDATE outbox_messages SET next_attempt_at = ? WHERE id IN (${placeholders(ids.length)}) AND published_at IS NULL`,
      [at, ...ids],
    );
  }

  /** Falha de envio: grava `attempts` e `next_attempt_at` calculados por `OutboxMessage.scheduleRetry` (I-31, I-65). */
  async scheduleRetry(em: EntityManager, message: OutboxMessage): Promise<void> {
    await em.execute('UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ? AND published_at IS NULL', [
      message.attempts,
      message.nextAttemptAt,
      message.id,
    ]);
  }
}
