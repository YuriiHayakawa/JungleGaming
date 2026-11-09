// T108 — timeout de aquisição do pool: 503 padronizado, sem efeito, e reenvio seguro (FR-043, FR-059, I-51, S-09).
// Sem endpoint de teste e sem failpoint: a única conexão do pool é ocupada por um pg_sleep pelo handle in-process do ORM
// que o app-harness expõe. Nada novo no código de produção.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type TransactionResultBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pool_acquire_timeout');
let running: RunningApp;

beforeAll(async () => {
  // hierarquia do I-51 respeitada: 200 < 500 e 3000 > 500 + 200 + 2000
  running = await startApp({
    databaseUrl: database.url,
    env: { DB_POOL_MAX: '1', WALLET_LOCK_TIMEOUT_MS: '200', DB_POOL_ACQUIRE_TIMEOUT_MS: '500', HTTP_SERVER_TIMEOUT_MS: '3000' },
  });
});
afterAll(async () => {
  await running?.close();
});

async function counts(walletId: string) {
  const [row] = await database.db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = ?)::text AS txs,
            (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::text AS entries,
            (SELECT count(*) FROM outbox_messages WHERE aggregate_id = ?)::text AS events,
            (SELECT balance::text || '/' || version::text FROM wallets WHERE id = ?) AS wallet`,
    [walletId, walletId, walletId, walletId],
  );
  return row;
}

test('a única conexão ocupada → 503 SERVICE_UNAVAILABLE em ~500 ms, sem efeito; depois de liberada, o reenvio → 201', async () => {
  const http = fetcherFor(running.baseUrl);
  const wallet = await openWallet(http, '100.00');
  const before = await counts(wallet.id);
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } });

  // ocupa a única conexão do pool por 2 s
  const sleeping = running.orm.em.fork().execute('select pg_sleep(2)');
  await Bun.sleep(100);

  const response = await submitWager<ErrorBody>(http, request);
  expect(response.status, JSON.stringify(response.body)).toBe(503);
  expect(response.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
  expect(response.headers.get('retry-after')).toBe('1');
  expect(response.elapsedMs).toBeGreaterThanOrEqual(450);
  expect(response.elapsedMs).toBeLessThanOrEqual(1500);
  console.log(`pool-acquire-timeout: 503 em ${Math.round(response.elapsedMs)} ms`);

  await sleeping;
  expect(await counts(wallet.id)).toEqual(before);

  const retried = await submitWager<TransactionResultBody>(http, request);
  expect(retried.status, JSON.stringify(retried.body)).toBe(201);
  expect(retried.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '90.00', currency: 'BRL' } });
  expect(await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId])).toHaveLength(1);
  expect(await database.db.query('SELECT id FROM wallet_ledger_entries WHERE transaction_id = ?', [retried.body.transactionId])).toHaveLength(1);
  await assertWalletMatchesLedger(database.db, wallet.id);
});
