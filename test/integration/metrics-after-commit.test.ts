// N-45 — `transactions_total{status}` só depois do commit: uma tentativa desfeita pela unit of work (rollback, 40P01,
// 40001) não conta. PostgreSQL real; a falha de serialização vem do failpoint (SQLSTATE 40001 real no classificador) e o
// lock esgotado vem de um FOR UPDATE real segurado pelo teste.
import { afterAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { FixedRandom } from '../support/fakes.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('metrics_after_commit');
const opened: RunningApp[] = [];

afterAll(async () => {
  for (const app of opened) await app.close();
});

const ENV = { WALLET_LOCK_TIMEOUT_MS: '300', DB_POOL_ACQUIRE_TIMEOUT_MS: '2000' };

async function start(env: Record<string, string>, roles = {}) {
  const app = await startApp({ databaseUrl: database.url, roles, env: { ...ENV, ...env }, random: new FixedRandom(0.5) });
  opened.push(app);
  return app;
}

const processed = (app: RunningApp) => app.metrics.counter('transactions_total', { status: 'PROCESSED' });
const total = (app: RunningApp) => app.metrics.counter('transactions_total');

test('submit: a tentativa desfeita por falha de serialização (40001) não conta; o commit conta uma única vez', async () => {
  const app = await start({ FAILPOINT: 'after_ledger_insert_before_commit:serialization_failure_once' });
  const http = fetcherFor(app.baseUrl);
  const wallet = await openWallet(http, '100.00');
  const before = processed(app);

  const response = await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
  expect(response.status).toBe(201);
  // A unit of work repetiu: o failpoint disparou na 1ª tentativa, depois do lançamento e antes do commit; só a 2ª commitou.
  expect(await database.db.query("SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'", [wallet.id])).toHaveLength(1);
  expect(processed(app)).toBe(before + 1);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 30_000);

test('submit: um 503 por lock esgotado deixa o contador inalterado', async () => {
  const app = await start({});
  const http = fetcherFor(app.baseUrl);
  const wallet = await openWallet(http, '100.00');
  const before = total(app);
  const holder = await database.db.connect();
  try {
    await holder.q.query('BEGIN');
    await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
    const response = await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
    expect(response.status).toBe(503);
  } finally {
    await holder.q.query('ROLLBACK').catch(() => {});
    holder.release();
  }
  expect(total(app)).toBe(before);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 30_000);

test('worker: a reavaliação desfeita por falha de serialização não conta; a conclusão confirmada conta uma vez', async () => {
  const setup = await start({ PENDING_BACKOFF_BASE_MS: '100', PENDING_BACKOFF_MAX_MS: '400' });
  const http = fetcherFor(setup.baseUrl);
  const wallet = await openWallet(http, '100.00');
  const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
  const refund = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: bet.externalTransactionId });
  expect((await submitWager(http, refund)).status).toBe(202);
  expect((await submitWager(http, bet)).status).toBe(201);

  const worker = await start(
    {
      FAILPOINT: 'after_pending_resolution_before_commit:serialization_failure_once',
      PENDING_WORKER_POLL_MS: '100',
      PENDING_BACKOFF_BASE_MS: '100',
      PENDING_BACKOFF_MAX_MS: '400',
    },
    { pendingWorker: true },
  );
  await waitFor(async () => {
    const rows = await database.db.query<{ status: string }>('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [refund.externalTransactionId]);
    return rows[0]!.status === 'PROCESSED';
  }, 10_000, 50);
  expect(processed(worker)).toBe(1);
  expect(total(worker)).toBe(1);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 30_000);
