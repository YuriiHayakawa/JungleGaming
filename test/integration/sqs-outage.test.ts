// T059 — SQS indisponível (US3 cenário 4; FR-033, FR-035; I-34; SC-009), com um proxy TCP na frente do MiniStack: o HTTP
// continua, a outbox acumula, consumidor e publicador esperam com backoff sem derrubar a app e, com a fila de volta,
// sem reiniciar, todos os eventos são publicados.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type WalletBody } from '../support/http.ts';
import { SQS_ENDPOINT, collectUntil, waitFor } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('sqs_outage');
const queues = useTestQueues('sqs-outage');
let proxy: TcpProxy;
let app: RunningApp;
let wallet: WalletBody;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled);
  proxy = await startTcpProxy(SQS_ENDPOINT);
  app = await startApp({
    databaseUrl: database.url,
    roles: { consumer: true, publisher: true },
    queues: queues.env(proxy.url.replace(/\/$/, '')),
    env: { PUBLISHER_POLL_MS: '100', CONSUMER_WAIT_SECONDS: '1' },
  });
  wallet = await openWallet(fetcherFor(app.baseUrl), '1000.00');
});

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  await app?.close();
  proxy?.close();
});

const pendingCount = async () =>
  (await database.db.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).length;

test('fila fora: 10 BETs por HTTP respondem 201 e a outbox acumula; fila de volta: tudo publicado sem reiniciar', async () => {
  proxy.cut();
  const transactionIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const response = await submitWager(fetcherFor(app.baseUrl), wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
    expect(response.status).toBe(201);
    transactionIds.push(response.body.transactionId);
  }
  const eventIds = (
    await database.db.query<{ id: string }>("SELECT id FROM outbox_messages WHERE payload->'data'->>'transactionId' = ANY(?)", [transactionIds])
  ).map((r) => r.id);
  expect(eventIds).toHaveLength(20);

  // Com a fila fora, os envios falham e os eventos ficam pendentes. Cada rodada para na primeira falha (N-22): o
  // evento que falhou conta tentativa e os não tentados voltam sem contar e sem esperar o lease de 30 s.
  await waitFor(async () => {
    const rows = await database.db.query<{ attempts: number }>('SELECT attempts FROM outbox_messages WHERE id = ANY(?)', [eventIds]);
    return rows.filter((r) => r.attempts >= 1).length >= 2;
  }, 15_000);
  expect(await pendingCount()).toBeGreaterThanOrEqual(20);
  const leased = await database.db.query(
    "SELECT 1 FROM outbox_messages WHERE id = ANY(?) AND attempts = 0 AND next_attempt_at > now() + interval '5 seconds'",
    [eventIds],
  );
  expect(leased).toHaveLength(0);
  // A app continua viva e atendendo.
  const health = await submitWager(fetcherFor(app.baseUrl), wagerRequest('LOSS', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '0.00', currency: 'BRL' } }));
  expect(health.status).toBe(201);
  const logged = app.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(logged.some((l) => l.msg === 'publisher.send_failed')).toBe(true);
  expect(logged.some((l) => l.msg === 'consumer.poll_failed')).toBe(true);

  proxy.restore();
  await waitFor(async () => (await pendingCount()) === 0, 45_000, 250);
  const received = await collectUntil(
    queues.urls.events,
    (all) => eventIds.every((id) => all.some((m) => m.deduplicationId === id)),
    20_000,
  );
  expect(received.length).toBeGreaterThanOrEqual(20);
  expect(unhandled).toEqual([]);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 90_000);
