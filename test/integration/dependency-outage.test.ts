// T080 — indisponibilidade de uma dependência (US6 cenários 1 a 3; FR-033 a FR-035; I-30, I-34), com proxies TCP reais na
// frente do PostgreSQL e do MiniStack e os três papéis ligados numa única app (consumidor, publicador e worker):
// 1. SQS cortado → o HTTP responde; consumidor e publicador esperam com backoff crescente (1 a 30 s) sem derrubar o
//    processo; o worker (só banco) segue;
// 2. PostgreSQL cortado → nenhuma mensagem é confirmada nem vai à DLQ antes do limite de recebimentos; publicador e
//    worker não gravam nada;
// 3. com os dois de volta, sem reinício, tudo é processado e publicado uma vez. Termina com assertWalletMatchesLedger.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { FixedRandom } from '../support/fakes.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type Fetcher, type WalletBody } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { SQS_ENDPOINT, collectUntil, counts, drainQueue, waitFor } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('dependency_outage');
const queues = useTestQueues('dependency-outage');
let sqsProxy: TcpProxy;
let pgProxy: TcpProxy;
let app: RunningApp;
let http: Fetcher;
let wallet: WalletBody;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled);
  sqsProxy = await startTcpProxy(SQS_ENDPOINT);
  pgProxy = await startTcpProxy(database.url);
  app = await startApp({
    databaseUrl: pgProxy.url,
    roles: { consumer: true, publisher: true, pendingWorker: true },
    queues: queues.env(sqsProxy.url.replace(/\/$/, '')),
    random: new FixedRandom(0.5),
    env: {
      CONSUMER_WAIT_SECONDS: '1',
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '6',
      CONSUMER_RETRY_BASE_SECONDS: '1',
      WALLET_LOCK_TIMEOUT_MS: '1000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
      PUBLISHER_POLL_MS: '100',
      PUBLISHER_LEASE_MS: '6000',
      PENDING_WORKER_POLL_MS: '100',
      PENDING_WORKER_LEASE_MS: '6000',
      PENDING_BACKOFF_BASE_MS: '200',
      PENDING_BACKOFF_MAX_MS: '400',
      PENDING_MAX_ATTEMPTS: '1000',
    },
  });
  http = fetcherFor(app.baseUrl);
  wallet = await openWallet(http, '1000.00');
});

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  await app?.close();
  sqsProxy?.close();
  pgProxy?.close();
});

const logged = () => app.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
const delaysOf = (msg: string, since: number) =>
  logged()
    .filter((l) => l.msg === msg && Date.parse(String(l.time)) >= since)
    .map((l) => Number(l.nextDelayMs));
const unpublished = async () => (await database.db.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).length;

test('SQS fora: o HTTP responde e consumidor e publicador esperam com backoff crescente, sem derrubar o processo (cenário 1)', async () => {
  const since = Date.now();
  sqsProxy.cut();
  const bet = await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
  expect(bet.status).toBe(201);
  // O worker só depende do banco: a pendente criada com a fila fora é reavaliada normalmente.
  const refund = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: `never-${crypto.randomUUID()}` });
  expect((await submitWager(http, refund)).status).toBe(202);

  await waitFor(async () => delaysOf('consumer.poll_failed', since).length >= 3 && delaysOf('publisher.poll_failed', since).length >= 3, 20_000, 100);
  for (const name of ['consumer.poll_failed', 'publisher.poll_failed']) {
    const delays = delaysOf(name, since);
    expect(delays.slice(0, 3)).toEqual([1_000, 2_000, 4_000]); // backoff do laço: 1, 2, 4 … até 30 s
  }
  expect(await unpublished()).toBeGreaterThan(0); // a outbox acumula
  await waitFor(async () => {
    const rows = await database.db.query<{ reference_attempts: number }>('SELECT reference_attempts FROM wager_transactions WHERE external_transaction_id = ?', [refund.externalTransactionId]);
    return rows[0]!.reference_attempts >= 1;
  }, 5_000, 50);
  // A app segue viva e atendendo.
  const health = await submitWager(http, wagerRequest('LOSS', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '0.00', currency: 'BRL' } }));
  expect(health.status).toBe(201);
  expect(unhandled).toEqual([]);

  sqsProxy.restore();
  await waitFor(async () => (await unpublished()) === 0, 40_000, 200);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 90_000);

test('PostgreSQL fora: nada é confirmado nem vai à DLQ; publicador e worker não gravam nada; tudo volta sem reinício (cenários 2 e 3)', async () => {
  // Uma pendente cuja referência chega pela fila durante a queda do banco.
  const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
  const refund = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: bet.externalTransactionId });
  expect((await submitWager(http, refund)).status).toBe(202);
  await waitFor(async () => (await unpublished()) === 0, 20_000, 100);

  const snapshot = async () => ({
    transactions: await database.db.query<{ id: string; status: string; reference_attempts: number; updated_at: Date }>(
      'SELECT id, status, reference_attempts, updated_at FROM wager_transactions ORDER BY id',
    ),
    outbox: await database.db.query<{ id: string; attempts: number; next_attempt_at: Date; published_at: Date | null }>(
      'SELECT id, attempts, next_attempt_at, published_at FROM outbox_messages ORDER BY id',
    ),
    inbox: await database.db.query('SELECT message_id FROM inbox_messages ORDER BY message_id'),
  });

  const since = Date.now();
  pgProxy.cut();
  const envelopes = [
    wagerEnvelope(bet, { messageId: newMessageId('outage-bet') }),
    wagerEnvelope(wagerRequest('WIN', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '3.00', currency: 'BRL' } }), { messageId: newMessageId('outage-win') }),
  ];
  for (const envelope of envelopes) await sendEnvelope(queues.urls.transactions, envelope); // direto no MiniStack
  const before = await snapshot();

  // Banco fora por ~4 s: recebimentos com falha transitória, sempre abaixo do limite de 5.
  await waitFor(async () => {
    const consumerFailed = logged().some((l) => l.msg === 'consumer.message' && l.outcome === 'error' && Date.parse(String(l.time)) >= since);
    return consumerFailed && delaysOf('publisher.poll_failed', since).length >= 1 && delaysOf('pending_worker.poll_failed', since).length >= 1;
  }, 15_000, 100);
  await Bun.sleep(2_000);
  const during = await snapshot();
  expect(during).toEqual(before); // nada gravado: nenhuma inbox, transação, tentativa ou publicação
  const c = await counts(queues.urls.transactions);
  expect(c.visible + c.notVisible).toBe(2); // nenhuma confirmada
  expect((await counts(queues.urls.dlq)).visible).toBe(0); // nenhuma na DLQ antes do limite
  expect(unhandled).toEqual([]);

  pgProxy.restore();
  // Sem reinício: as duas mensagens processadas uma vez, a pendente concluída e tudo publicado.
  await waitFor(async () => {
    const inbox = await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ANY(?)', [envelopes.map((e) => e.messageId)]);
    const pending = await database.db.query<{ status: string }>('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [refund.externalTransactionId]);
    return inbox.length === 2 && pending[0]!.status === 'PROCESSED' && (await unpublished()) === 0;
  }, 45_000, 200);
  const q = await counts(queues.urls.transactions);
  expect(q).toEqual({ visible: 0, notVisible: 0 });
  expect(await drainQueue(queues.urls.dlq, { quietMs: 500, timeoutMs: 2_000 })).toEqual([]);
  for (const envelope of envelopes) {
    expect(await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [envelope.data.externalTransactionId])).toHaveLength(1);
  }
  const ids = (await database.db.query<{ id: string }>('SELECT id FROM outbox_messages')).map((r) => r.id);
  await collectUntil(queues.urls.events, (got) => ids.every((id) => got.some((m) => m.deduplicationId === id)), 30_000);
  expect(unhandled).toEqual([]);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 120_000);
