// T052 — erro inesperado no consumidor (US2 cenário 4a; FR-009a, FR-011, FR-040; I-61, I-71; SC-004): com
// FAILPOINT=after_ledger_insert_before_commit em toda entrega, as 4 primeiras voltam com espera crescente; no 5º
// recebimento a aplicação envia à DLQ com INTERNAL_ERROR/unexpected e só então apaga da principal. Nada gravado, nenhum
// FAILED.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, receive, waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('consumer_unexpected');
const queues = useTestQueues('consumer-unexpected');
let app: RunningApp;

beforeAll(async () => {
  app = await startApp({
    databaseUrl: database.url,
    roles: { consumer: true },
    queues: queues.env(),
    env: { CONSUMER_WAIT_SECONDS: '1', CONSUMER_RETRY_BASE_SECONDS: '1', FAILPOINT: 'after_ledger_insert_before_commit' },
  });
});

afterAll(async () => {
  await app?.close();
});

test('4 voltas com espera crescente e, no 5º recebimento, DLQ pela aplicação com INTERNAL_ERROR/unexpected', async () => {
  // A abertura da wallet não passa pelo failpoint da submissão.
  const wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
  const envelope = wagerEnvelope(request);
  await sendEnvelope(queues.urls.transactions, envelope);

  await waitFor(async () => (await counts(queues.urls.dlq)).visible === 1, 40_000, 250);
  const [dead] = await receive(queues.urls.dlq, { max: 1, waitSeconds: 1, visibilitySeconds: 300 });
  expect(dead?.body).toBe(JSON.stringify(envelope));
  expect(dead?.groupId).toBe(wallet.id);
  expect(dead?.attributes).toEqual({
    errorCode: 'INTERNAL_ERROR',
    errorClass: 'unexpected',
    receiveCount: '5',
    consumer: 'wager-transactions-consumer',
  });
  expect(await counts(queues.urls.transactions)).toEqual({ visible: 0, notVisible: 0 });

  const lines = app.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.messageId === envelope.messageId && line.msg === 'consumer.message');
  expect(lines.map((l) => [l.outcome, l.receiveCount, l.retryInSeconds ?? null])).toEqual([
    ['error', 1, 1],
    ['error', 2, 2],
    ['error', 3, 4],
    ['error', 4, 8],
    ['dlq', 5, null],
  ]);
  expect(lines.slice(0, 4).every((l) => l.errorClass === 'unexpected')).toBe(true);

  expect(await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId])).toHaveLength(0);
  expect(await database.db.query("SELECT 1 FROM wager_transactions WHERE status = 'FAILED'")).toHaveLength(0);
  expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(0);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
