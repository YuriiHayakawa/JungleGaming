// Apoio aos testes do worker de PENDING_REFERENCE (US4): env curto para instâncias com o worker e consultas de estado.
import type { Queryable } from './db.ts';

/** Varredura e espera curtas; lease acima do pior caso da unit of work (R-27: 6 s > 2 s + 1 s + margem). */
export const PENDING_WORKER_ENV: Record<string, string> = {
  WALLET_LOCK_TIMEOUT_MS: '1000',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
  PENDING_WORKER_LEASE_MS: '6000',
  PENDING_WORKER_POLL_MS: '50',
  PENDING_BACKOFF_BASE_MS: '50',
  PENDING_BACKOFF_MAX_MS: '50',
  // Reavaliação sem parar enquanto a referência não chega: o esgotamento não pode decidir estes testes.
  PENDING_MAX_ATTEMPTS: '1000000',
};

export interface PendingRow extends Record<string, unknown> {
  id: string;
  status: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
  created_at: Date;
}

export async function transactionByExternalId(db: Queryable, externalId: string): Promise<PendingRow> {
  const rows = await db.query<PendingRow>(
    'SELECT id, status, failure_code, reference_transaction_id, created_at FROM wager_transactions WHERE external_transaction_id = ?',
    [externalId],
  );
  if (rows.length !== 1) throw new Error(`expected one transaction ${externalId}, got ${rows.length}`);
  return rows[0]!;
}

/** Lançamentos e eventos de conclusão de uma transação: a prova de "concluída uma única vez". */
export async function effectsOf(db: Queryable, transactionId: string) {
  const ledger = await db.query<{ direction: string; amount: string }>(
    'SELECT direction, amount FROM wallet_ledger_entries WHERE transaction_id = ?',
    [transactionId],
  );
  const events = await db.query<{ event_type: string }>(
    "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? AND event_type <> 'WagerTransactionPendingReference'",
    [transactionId],
  );
  return { ledger, events: events.map((e) => e.event_type) };
}
