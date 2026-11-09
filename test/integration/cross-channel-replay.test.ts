// T040 — replay cruzado HTTP × fila (US1 cenário 3; FR-006; I-26, I-28): HTTP e fila compartilham o mesmo use case
// e as mesmas tabelas de idempotência.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('cross_channel_replay');
const queues = useTestQueues('cross-channel');
let app: RunningApp;

beforeAll(async () => {
  app = await startApp({ databaseUrl: database.url, roles: { consumer: true }, queues: queues.env(), env: { CONSUMER_WAIT_SECONDS: '1' } });
});

afterAll(async () => {
  await app?.close();
});

const http = () => fetcherFor(app.baseUrl);
const outboxCount = async (walletId: string) =>
  (await database.db.query('SELECT 1 FROM outbox_messages WHERE aggregate_id = ?', [walletId])).length;

test('BET por HTTP e depois pela fila com a mesma chave: replay sem efeito nem evento, confirmado, inbox apontando a transação existente', async () => {
  const wallet = await openWallet(http(), '100.00');
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
  const viaHttp = await submitWager(http(), request);
  expect(viaHttp.status).toBe(201);
  const eventsBefore = await outboxCount(wallet.id);

  const envelope = wagerEnvelope(request);
  await sendEnvelope(queues.urls.transactions, envelope);
  await waitFor(async () => (await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).length === 1);
  await waitForEmpty(queues.urls.transactions);

  const inbox = await database.db.query<{ transaction_id: string }>('SELECT transaction_id FROM inbox_messages WHERE message_id = ?', [
    envelope.messageId,
  ]);
  expect(inbox).toEqual([{ transaction_id: viaHttp.body.transactionId }]);
  expect(await outboxCount(wallet.id)).toBe(eventsBefore);
  const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
  expect(row).toEqual({ balance: '90.00', version: 2 });
  await assertWalletMatchesLedger(database.db, wallet.id);
});

test('BET pela fila e depois por HTTP com a mesma chave: 200 com idempotentReplay true', async () => {
  const wallet = await openWallet(http(), '100.00');
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
  const envelope = wagerEnvelope(request);
  await sendEnvelope(queues.urls.transactions, envelope);
  await waitFor(async () => (await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).length === 1);
  await waitForEmpty(queues.urls.transactions);
  const [tx] = await database.db.query<{ id: string }>('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [
    request.externalTransactionId,
  ]);

  const replay = await submitWager(http(), request);
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({ transactionId: tx?.id, status: 'PROCESSED', idempotentReplay: true, balance: { amount: '90.00', currency: 'BRL' } });
  const [row] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
  expect(row?.balance).toBe('90.00');
  await assertWalletMatchesLedger(database.db, wallet.id);
});
