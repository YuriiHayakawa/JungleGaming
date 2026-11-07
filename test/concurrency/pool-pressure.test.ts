// T074 — pool-pressure: dentro da transação só o EM da transação (R-19, FR-038). Com pool 5 por instância, uma
// única query fora do EM transacional travaria a fila e geraria 503.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { type TransactionResultBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pool_pressure');
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url, env: { DB_POOL_MAX: '5' } });
});
afterAll(async () => {
  await cluster?.stop();
});

test('3 instâncias com DB_POOL_MAX=5: 100 BETs paralelas na mesma wallet → 100 × 201, nenhum 503', async () => {
  const wallet = await openWallet(cluster.fetch, '1000.00');
  const requests = Array.from({ length: 100 }, () =>
    wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } }),
  );
  const responses = await Promise.all(requests.map((r) => submitWager<TransactionResultBody>(cluster.fetch, r)));

  const byStatus = responses.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  expect(byStatus).toEqual({ 201: 100 });

  const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
  expect(row).toEqual({ balance: '900.00', version: 101 });
  const debits = await database.db.query("SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [wallet.id]);
  expect(debits).toHaveLength(100);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 120_000);
