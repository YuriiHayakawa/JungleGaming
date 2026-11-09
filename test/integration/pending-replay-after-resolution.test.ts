// T067 — replay depois da resolução de uma PENDING_REFERENCE (FR-039; I-62, I-67): a mesma requisição responde 202 antes
// e, depois da conclusão pelo worker, 200 (PROCESSED) ou 422 (REJECTED, com failureCode), sempre com o saldo observado na
// conclusão; o correlation_id gravado não muda; a pendente que ficou FAILED pelo worker responde 500 com retryable false.
// PostgreSQL real; o worker roda numa app própria por cenário.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { FixedRandom } from '../support/fakes.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type Fetcher, type TransactionResultBody } from '../support/http.ts';
import { waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pending_replay');
const FAST = { PENDING_WORKER_POLL_MS: '100', PENDING_BACKOFF_BASE_MS: '100', PENDING_BACKOFF_MAX_MS: '400', PENDING_MAX_ATTEMPTS: '3' };
let idle: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  idle = await startApp({ databaseUrl: database.url, env: FAST });
  http = fetcherFor(idle.baseUrl);
});
afterAll(async () => {
  await idle?.close();
});

async function withWorker(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const app = await startApp({ databaseUrl: database.url, roles: { pendingWorker: true }, env: { ...FAST, ...env }, random: new FixedRandom(0.5) });
  try {
    await fn();
  } finally {
    await app.close();
  }
}

const statusOf = async (transactionId: string) =>
  (await database.db.query<{ status: string; correlation_id: string }>('SELECT status, correlation_id FROM wager_transactions WHERE id = ?', [transactionId]))[0]!;

test('PROCESSED: 202 antes; 200 depois, com o saldo da conclusão e o correlation_id original', async () => {
  const wallet = await openWallet(http, '100.00');
  const betExternal = `bet-${crypto.randomUUID()}`;
  const refund = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: betExternal });
  const first = await submitWager(http, refund, { 'X-Correlation-Id': 'corr-original-1' });
  expect(first.status).toBe(202);
  expect(first.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  const again = await submitWager(http, refund, { 'X-Correlation-Id': 'corr-replay-1' });
  expect(again.status).toBe(202);
  expect(again.body).toMatchObject({ transactionId: first.body.transactionId, status: 'PENDING_REFERENCE', idempotentReplay: true });

  expect((await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: betExternal }))).status).toBe(201);
  await withWorker({}, async () => {
    await waitFor(async () => (await statusOf(first.body.transactionId)).status === 'PROCESSED', 5_000, 20);
  });

  const replay = await submitWager<TransactionResultBody>(http, refund, { 'X-Correlation-Id': 'corr-replay-2' });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual({
    transactionId: first.body.transactionId,
    status: 'PROCESSED',
    balance: { amount: '100.00', currency: 'BRL' }, // 100 − 10 (BET) + 10 (REFUND): o saldo na conclusão
    idempotentReplay: true,
  });
  expect((await statusOf(first.body.transactionId)).correlation_id).toBe('corr-original-1');
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 30_000);

test('REJECTED: 202 antes; 422 depois, com failureCode e o saldo da conclusão', async () => {
  const wallet = await openWallet(http, '50.00');
  const betExternal = `bet-${crypto.randomUUID()}`;
  const rollback = wagerRequest('ROLLBACK', {
    walletId: wallet.id,
    playerId: wallet.playerId,
    money: { amount: '40.00', currency: 'BRL' },
    referenceExternalTransactionId: betExternal,
  });
  const first = await submitWager(http, rollback);
  expect(first.status).toBe(202);
  expect(first.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });
  // A BET de 40 é aplicada (saldo 10) e depois um WIN muda o saldo antes da conclusão: o 422 traz o saldo da conclusão.
  expect((await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: betExternal, money: { amount: '40.00', currency: 'BRL' } }))).status).toBe(201);
  expect((await submitWager(http, wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '40.00', currency: 'BRL' }, referenceExternalTransactionId: betExternal }))).status).toBe(201); // 50; a BET já foi revertida
  await withWorker({}, async () => {
    await waitFor(async () => (await statusOf(first.body.transactionId)).status === 'REJECTED', 5_000, 20);
  });
  const replay = await submitWager<TransactionResultBody>(http, rollback);
  expect(replay.status).toBe(422);
  expect(replay.body).toEqual({
    transactionId: first.body.transactionId,
    status: 'REJECTED',
    balance: { amount: '50.00', currency: 'BRL' },
    idempotentReplay: true,
    failureCode: 'ALREADY_REVERSED',
    retryable: false,
  });
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 30_000);

test('FAILED pelo worker: o replay responde 500 INTERNAL_ERROR com retryable false (I-62)', async () => {
  const wallet = await openWallet(http, '100.00');
  const betExternal = `bet-${crypto.randomUUID()}`;
  const refund = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: betExternal });
  const first = await submitWager(http, refund);
  expect(first.status).toBe(202);
  expect((await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: betExternal }))).status).toBe(201);
  await withWorker({ FAILPOINT: 'after_pending_resolution_before_commit:invariant_violation' }, async () => {
    await waitFor(async () => (await statusOf(first.body.transactionId)).status === 'FAILED', 5_000, 20);
  });
  const replay = await submitWager<ErrorBody>(http, refund);
  expect(replay.status).toBe(500);
  expect(replay.body.error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false });
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 30_000);
