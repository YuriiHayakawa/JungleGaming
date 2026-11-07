// T073 — espera de lock limitada: 503 sem efeito, reenvio seguro (FR-059, I-51; US2/US9).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { type ErrorBody, type TransactionResultBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('lock_timeout');
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({
    size: 3,
    databaseUrl: database.url,
    // hierarquia do I-51 respeitada: 500 < 1000 e 4000 > 1000 + 500 + 2000
    env: { WALLET_LOCK_TIMEOUT_MS: '500', DB_POOL_ACQUIRE_TIMEOUT_MS: '1000', HTTP_SERVER_TIMEOUT_MS: '4000' },
  });
});
afterAll(async () => {
  await cluster?.stop();
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

test('lock segurado por fora → 503 SERVICE_UNAVAILABLE com Retry-After em ~500 ms, sem efeito; depois do lock, 201', async () => {
  const wallet = await openWallet(cluster.fetch, '100.00');
  const before = await counts(wallet.id);
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } });

  const holder = await database.db.connect();
  try {
    await holder.q.query('BEGIN');
    await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);

    for (const instance of cluster.instances) {
      const response = await submitWager<ErrorBody>((path, init) => fetch(`${instance.baseUrl}${path}`, init), request);
      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
      expect(response.headers.get('retry-after')).toBe('1');
      expect(response.elapsedMs).toBeGreaterThanOrEqual(450);
      expect(response.elapsedMs).toBeLessThanOrEqual(1500);
    }
    expect(await counts(wallet.id)).toEqual(before);
  } finally {
    await holder.q.query('ROLLBACK').catch(() => {});
    holder.release();
  }

  const retried = await submitWager<TransactionResultBody>(cluster.fetch, request);
  expect(retried.status).toBe(201);
  expect(retried.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '90.00', currency: 'BRL' } });
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
