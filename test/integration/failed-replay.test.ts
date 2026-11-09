// T053 — replay de FAILED (US2 cenário 5; FR-012, FR-030; I-62): com uma transação FAILED semeada por SQL respeitando as
// constraints, o replay por HTTP responde 500 INTERNAL_ERROR com retryable false no envelope do I-38, e o replay pela
// fila é confirmado, sem efeito nem evento.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { computePayloadHash } from '../../src/wagering/application/payload-hash.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { idempotencyKeyFor, wagerRequest, type WagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody } from '../support/http.ts';
import { sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('failed_replay');
const queues = useTestQueues('failed-replay');
let app: RunningApp;

beforeAll(async () => {
  app = await startApp({ databaseUrl: database.url, roles: { consumer: true }, queues: queues.env(), env: { CONSUMER_WAIT_SECONDS: '1' } });
});

afterAll(async () => {
  await app?.close();
});

/** FAILED como o worker de PENDING_REFERENCE deixaria (I-61): um REFUND que estava pendente, com saldo observado. */
async function seedFailed(request: WagerRequest): Promise<string> {
  const id = Bun.randomUUIDv7();
  const now = new Date();
  await database.db.query(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
        kind, amount, currency, reference_external_transaction_id, status, failure_code, observed_balance,
        observed_balance_currency, correlation_id, reference_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', 'INTERNAL_ERROR', ?, 'BRL', 'corr-failed', 3, ?, ?)`,
    [
      id,
      request.providerId,
      request.externalTransactionId,
      idempotencyKeyFor(request),
      computePayloadHash(request),
      request.walletId,
      request.playerId,
      request.roundId,
      request.gameId,
      request.kind,
      request.money.amount,
      request.money.currency,
      request.referenceExternalTransactionId ?? null,
      '100.00',
      now,
      now,
    ],
  );
  return id;
}

const outboxCount = async (walletId: string) =>
  (await database.db.query('SELECT 1 FROM outbox_messages WHERE aggregate_id = ?', [walletId])).length;

test('replay por HTTP de uma FAILED → 500 INTERNAL_ERROR com retryable false, sem efeito', async () => {
  const wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
  const request = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: `ref-${crypto.randomUUID()}` });
  await seedFailed(request);
  const before = await outboxCount(wallet.id);

  const response = await submitWager<ErrorBody>(fetcherFor(app.baseUrl), request, { 'X-Correlation-Id': 'corr-replay-1' });
  expect(response.status).toBe(500);
  expect(response.body).toEqual({
    error: { code: 'INTERNAL_ERROR', message: expect.any(String), retryable: false, correlationId: 'corr-replay-1' },
  });
  expect(await outboxCount(wallet.id)).toBe(before);
  const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
  expect(row).toEqual({ balance: '100.00', version: 1 });
  await assertWalletMatchesLedger(database.db, wallet.id);
});

test('replay pela fila de uma FAILED → confirmado, sem efeito nem evento, com a inbox apontando a transação', async () => {
  const wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
  const request = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: `ref-${crypto.randomUUID()}` });
  const failedId = await seedFailed(request);
  const before = await outboxCount(wallet.id);

  const envelope = wagerEnvelope(request);
  await sendEnvelope(queues.urls.transactions, envelope);
  await waitFor(async () => (await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).length === 1);
  await waitForEmpty(queues.urls.transactions, 5_000);

  const inbox = await database.db.query<{ transaction_id: string }>('SELECT transaction_id FROM inbox_messages WHERE message_id = ?', [
    envelope.messageId,
  ]);
  expect(inbox).toEqual([{ transaction_id: failedId }]);
  expect(await outboxCount(wallet.id)).toBe(before);
  const [tx] = await database.db.query<{ status: string }>('SELECT status FROM wager_transactions WHERE id = ?', [failedId]);
  expect(tx?.status).toBe('FAILED');
  const line = app.logs
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.messageId === envelope.messageId && l.msg === 'consumer.message');
  expect(line).toMatchObject({ outcome: 'replay', status: 'FAILED' });
  await assertWalletMatchesLedger(database.db, wallet.id);
});
