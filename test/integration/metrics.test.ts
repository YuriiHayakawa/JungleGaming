// T082 — contadores pela porta de métricas (US7 cenários 1 a 3; FR-036; constitution VIII), lidos de
// app.get(METRICS) (InMemoryMetrics da instância), com PostgreSQL e MiniStack reais. Cada situação é provocada de verdade:
// duplicata pela inbox e pela idempotência, falha transitória (lock segurado por fora), erro permanente (DLQ), lock
// esgotado, publicação, mensagem e pendente processadas, transação gravada. Nenhum rótulo carrega valor monetário.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { FixedRandom } from '../support/fakes.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type Fetcher, type WalletBody } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { drainQueue, sendRaw, waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('metrics');
const queues = useTestQueues('metrics');
let app: RunningApp;
let http: Fetcher;
let wallet: WalletBody;

beforeAll(async () => {
  app = await startApp({
    databaseUrl: database.url,
    roles: { consumer: true, publisher: true, pendingWorker: true },
    queues: queues.env(),
    random: new FixedRandom(0.5),
    env: {
      CONSUMER_WAIT_SECONDS: '1',
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '6',
      CONSUMER_RETRY_BASE_SECONDS: '1',
      WALLET_LOCK_TIMEOUT_MS: '300',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
      PUBLISHER_POLL_MS: '100',
      PENDING_WORKER_POLL_MS: '100',
      PENDING_BACKOFF_BASE_MS: '100',
      PENDING_BACKOFF_MAX_MS: '400',
    },
  });
  http = fetcherFor(app.baseUrl);
  wallet = await openWallet(http, '1000.00');
});

afterAll(async () => {
  await app?.close();
});

const counter = (name: Parameters<RunningApp['metrics']['counter']>[0], labels: Record<string, string> = {}) => app.metrics.counter(name, labels);
const base = () => ({ walletId: wallet.id, playerId: wallet.playerId });

test('transação gravada → transactions_total{status}', async () => {
  const before = { processed: counter('transactions_total', { status: 'PROCESSED' }), rejected: counter('transactions_total', { status: 'REJECTED' }), pending: counter('transactions_total', { status: 'PENDING_REFERENCE' }) };
  expect((await submitWager(http, wagerRequest('BET', base()))).status).toBe(201);
  expect((await submitWager(http, wagerRequest('BET', { ...base(), money: { amount: '99999.00', currency: 'BRL' } }))).status).toBe(422);
  expect((await submitWager(http, wagerRequest('REFUND', { ...base(), referenceExternalTransactionId: `never-${crypto.randomUUID()}` }))).status).toBe(202);
  expect(counter('transactions_total', { status: 'PROCESSED' })).toBe(before.processed + 1);
  expect(counter('transactions_total', { status: 'REJECTED' })).toBe(before.rejected + 1);
  expect(counter('transactions_total', { status: 'PENDING_REFERENCE' })).toBe(before.pending + 1);
});

test('duplicata pela idempotência e pela inbox → duplicates_total{source} (cenário 1)', async () => {
  const idempotency = counter('duplicates_total', { source: 'idempotency' });
  const inbox = counter('duplicates_total', { source: 'inbox' });
  const bet = wagerRequest('BET', base());
  expect((await submitWager(http, bet)).status).toBe(201);
  expect((await submitWager(http, bet)).status).toBe(200); // replay pela idempotência
  expect(counter('duplicates_total', { source: 'idempotency' })).toBe(idempotency + 1);

  // A mesma mensagem duas vezes (deduplicação da fila contornada com outro MessageDeduplicationId): a 2ª é duplicata.
  const envelope = wagerEnvelope(wagerRequest('BET', base()), { messageId: newMessageId('dup') });
  await sendEnvelope(queues.urls.transactions, envelope);
  await waitForEmpty(queues.urls.transactions, 10_000);
  await sendEnvelope(queues.urls.transactions, envelope, { deduplicationId: `${envelope.messageId}-again` });
  await waitFor(() => counter('duplicates_total', { source: 'inbox' }) === inbox + 1, 10_000, 50);
}, 30_000);

test('falha transitória → retries_total{worker="consumer"}; lock esgotado → lock_conflicts_total; mensagem → processing_latency_ms{worker="consumer"}', async () => {
  const retries = counter('retries_total', { worker: 'consumer' });
  const conflicts = counter('lock_conflicts_total');
  const latencies = app.metrics.observations('processing_latency_ms', { worker: 'consumer' }).length;
  const holder = await database.db.connect();
  await holder.q.query('BEGIN');
  await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
  try {
    await sendEnvelope(queues.urls.transactions, wagerEnvelope(wagerRequest('BET', base()), { messageId: newMessageId('locked') }));
    await waitFor(() => counter('retries_total', { worker: 'consumer' }) > retries, 10_000, 50);
    expect(counter('lock_conflicts_total')).toBeGreaterThan(conflicts);
  } finally {
    await holder.q.query('ROLLBACK').catch(() => {});
    holder.release();
  }
  await waitForEmpty(queues.urls.transactions, 15_000);
  const observed = app.metrics.observations('processing_latency_ms', { worker: 'consumer' });
  expect(observed.length).toBeGreaterThan(latencies);
  expect(observed.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
}, 30_000);

test('erro permanente → dlq_total{errorCode, errorClass} (cenário 2)', async () => {
  const before = counter('dlq_total', { errorCode: 'MALFORMED_MESSAGE', errorClass: 'permanent' });
  await sendRaw(queues.urls.transactions, '{ not json', { groupId: 'metrics-malformed', deduplicationId: newMessageId('malformed') });
  await waitFor(() => counter('dlq_total', { errorCode: 'MALFORMED_MESSAGE', errorClass: 'permanent' }) === before + 1, 10_000, 50);
  await drainQueue(queues.urls.dlq, { quietMs: 500, timeoutMs: 3_000 });
});

test('publicação → outbox_lag_ms; pendente concluída → processing_latency_ms{worker="pending_worker"} (cenário 3)', async () => {
  const lags = app.metrics.observations('outbox_lag_ms').length;
  const pendingLatencies = app.metrics.observations('processing_latency_ms', { worker: 'pending_worker' }).length;
  const bet = wagerRequest('BET', base());
  const refund = wagerRequest('REFUND', { ...base(), referenceExternalTransactionId: bet.externalTransactionId });
  expect((await submitWager(http, refund)).status).toBe(202);
  expect((await submitWager(http, bet)).status).toBe(201);
  await waitFor(async () => {
    const rows = await database.db.query<{ status: string }>('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [refund.externalTransactionId]);
    return rows[0]!.status === 'PROCESSED';
  }, 10_000, 50);
  await waitFor(async () => (await database.db.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).length === 0, 15_000, 100);
  expect(app.metrics.observations('outbox_lag_ms').length).toBeGreaterThan(lags);
  expect(app.metrics.observations('processing_latency_ms', { worker: 'pending_worker' }).length).toBeGreaterThan(pendingLatencies);
}, 30_000);

test('nenhum rótulo carrega valor monetário (FR-037)', async () => {
  const snapshot = app.metrics.snapshot();
  const labels = [...snapshot.counters, ...snapshot.observations].flatMap((s) => Object.entries(s.labels));
  expect(labels.length).toBeGreaterThan(0);
  for (const [key, value] of labels) {
    expect(['status', 'source', 'worker', 'errorCode', 'errorClass']).toContain(key);
    expect(value).not.toMatch(/^\d+(\.\d+)?$/);
  }
  await assertWalletMatchesLedger(database.db, wallet.id);
});
