// T051 — erros transitórios (US2 cenários 1, 2 e 4; FR-009, FR-034; I-30, I-34, I-51; SC-004), com a app atrás do proxy
// TCP da 001 na frente do PostgreSQL (tráfego real, sem mock) e CONSUMER_RETRY_BASE_SECONDS=1.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type WalletBody } from '../support/http.ts';
import { sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, receive, waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('consumer_transient');
const queues = useTestQueues('consumer-transient');
let proxy: TcpProxy;
let app: RunningApp;
let wallet: WalletBody;

beforeAll(async () => {
  proxy = await startTcpProxy(database.url);
  app = await startApp({
    databaseUrl: proxy.url,
    roles: { consumer: true },
    queues: queues.env(),
    env: {
      CONSUMER_WAIT_SECONDS: '1',
      CONSUMER_RETRY_BASE_SECONDS: '1',
      WALLET_LOCK_TIMEOUT_MS: '1000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
    },
  });
  wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
});

afterAll(async () => {
  await app?.close();
  proxy?.close();
});

const errorLines = (messageId: string) =>
  app.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.messageId === messageId && line.msg === 'consumer.message' && line.outcome === 'error');

test('banco cortado em todas as entregas: DLQ pelo redrive depois de 5 recebimentos, sem os atributos da aplicação, nada gravado', async () => {
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
  const envelope = wagerEnvelope(request);
  proxy.cut();
  try {
    await sendEnvelope(queues.urls.transactions, envelope);
    await waitFor(async () => (await counts(queues.urls.dlq)).visible === 1, 75_000, 500);
  } finally {
    proxy.restore();
  }
  const [dead] = await receive(queues.urls.dlq, { max: 1, waitSeconds: 1, visibilitySeconds: 300 });
  expect(dead?.body).toBe(JSON.stringify(envelope));
  expect(dead?.attributes).toEqual({}); // redrive: sem errorCode/errorClass da aplicação
  const errors = errorLines(envelope.messageId);
  expect(errors).toHaveLength(5);
  expect(errors.map((l) => l.errorClass)).toEqual(['transient', 'transient', 'transient', 'transient', 'transient']);
  expect(errors.map((l) => l.retryInSeconds)).toEqual([1, 2, 4, 8, 16]);
  expect(await counts(queues.urls.transactions)).toEqual({ visible: 0, notVisible: 0 });
  expect(await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId])).toHaveLength(0);
  expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(0);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 90_000);

test('banco cortado só nas 2 primeiras entregas: processada uma única vez', async () => {
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '5.00', currency: 'BRL' } });
  const envelope = wagerEnvelope(request);
  proxy.cut();
  try {
    await sendEnvelope(queues.urls.transactions, envelope);
    await waitFor(() => errorLines(envelope.messageId).length >= 2, 15_000);
  } finally {
    proxy.restore();
  }
  await waitFor(
    async () => (await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).length === 1,
    20_000,
  );
  await waitForEmpty(queues.urls.transactions, 10_000);
  const txs = await database.db.query<{ status: string }>('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [
    request.externalTransactionId,
  ]);
  expect(txs).toEqual([{ status: 'PROCESSED' }]);
  expect(await counts(queues.urls.dlq)).toEqual({ visible: 0, notVisible: 1 }); // só a do teste anterior, já lida
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);

test('lock da wallet segurado por fora: a mensagem não é confirmada; solto o lock, é processada uma vez', async () => {
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } });
  const envelope = wagerEnvelope(request);
  const holder = await database.db.connect();
  try {
    await holder.q.query('BEGIN');
    await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
    await sendEnvelope(queues.urls.transactions, envelope);
    await waitFor(() => errorLines(envelope.messageId).length >= 1, 15_000);
    const pending = await counts(queues.urls.transactions);
    expect(pending.visible + pending.notVisible).toBe(1);
    expect(await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId])).toHaveLength(0);
    expect(errorLines(envelope.messageId)[0]?.errorClass).toBe('transient');
  } finally {
    await holder.q.query('ROLLBACK');
    holder.release();
  }
  await waitFor(
    async () => (await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).length === 1,
    20_000,
  );
  await waitForEmpty(queues.urls.transactions, 10_000);
  const txs = await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]);
  expect(txs).toHaveLength(1);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
