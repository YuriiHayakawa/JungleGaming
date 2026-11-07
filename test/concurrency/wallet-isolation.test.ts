// T072 — wallets distintas em paralelo e isolamento do lock por wallet (SC-004, FR-038; constitution III).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertAllWalletsMatchLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { type TransactionResultBody, type WalletBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('wallet_isolation');
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url });
});
afterAll(async () => {
  await cluster?.stop();
});

test('20 wallets recebem BETs em paralelo e todas terminam com o resultado esperado', async () => {
  const wallets: WalletBody[] = await Promise.all(Array.from({ length: 20 }, () => openWallet(cluster.fetch, '100.00')));
  // 3 BETs de 10.00 por wallet, todas disparadas ao mesmo tempo nas 3 instâncias
  const requests = wallets.flatMap((w) =>
    [0, 1, 2].map(() => wagerRequest('BET', { walletId: w.id, playerId: w.playerId, money: { amount: '10.00', currency: 'BRL' } })),
  );
  const responses = await Promise.all(requests.map((r) => submitWager<TransactionResultBody>(cluster.fetch, r)));
  expect(responses.every((r) => r.status === 201 && r.body.status === 'PROCESSED')).toBe(true);

  const rows = await database.db.query<{ id: string; balance: string; version: number }>(
    `SELECT id, balance, version FROM wallets WHERE id IN (${wallets.map(() => '?').join(',')})`,
    wallets.map((w) => w.id),
  );
  expect(rows).toHaveLength(20);
  for (const row of rows) expect({ balance: row.balance, version: row.version }).toEqual({ balance: '70.00', version: 4 });
  expect(await assertAllWalletsMatchLedger(database.db)).toBeGreaterThanOrEqual(20);
}, 60_000);

test('com a wallet A travada por uma conexão externa, uma BET na wallet B responde 201 em menos de 1 s', async () => {
  const [a, b] = await Promise.all([openWallet(cluster.fetch, '100.00'), openWallet(cluster.fetch, '100.00')]);
  const holder = await database.db.connect();
  try {
    await holder.q.query('BEGIN');
    await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [a.id]);

    // disputa contínua em A: uma BET em A fica presa no lock enquanto B é atendida
    const blockedOnA = submitWager<TransactionResultBody>(
      cluster.fetch,
      wagerRequest('BET', { walletId: a.id, playerId: a.playerId, money: { amount: '1.00', currency: 'BRL' } }),
    );
    for (const instance of cluster.instances) {
      const response = await submitWager<TransactionResultBody>(
        (path, init) => fetch(`${instance.baseUrl}${path}`, init),
        wagerRequest('BET', { walletId: b.id, playerId: b.playerId, money: { amount: '1.00', currency: 'BRL' } }),
      );
      expect(response.status).toBe(201);
      expect(response.elapsedMs).toBeLessThan(1000);
    }

    await holder.q.query('ROLLBACK');
    const released = await blockedOnA;
    expect(released.status).toBe(201);
  } finally {
    await holder.q.query('ROLLBACK').catch(() => {});
    holder.release();
  }
  const [rowB] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [b.id]);
  expect(rowB?.balance).toBe('97.00');
  await assertAllWalletsMatchLedger(database.db);
}, 60_000);
