// T053 — 10 criações simultâneas da mesma wallet em 3 instâncias (US1 cenário 4; I-10, I-52; SC-005).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { walletRequest } from '../support/factories.ts';
import { postJson, type ErrorBody, type WalletBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';

const database = useTestDatabase('concurrent_wallet_creation');
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url });
});
afterAll(async () => {
  await cluster?.stop();
});

test('10 POST /wallets simultâneos → 1 × 201 e 9 × 409 com o mesmo walletId; 1 wallet e 1 abertura', async () => {
  const request = walletRequest({ initialBalance: { amount: '500.00', currency: 'BRL' } });
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => {
      const instance = cluster.instances[i % cluster.instances.length]!;
      return postJson<WalletBody & ErrorBody>((path, init) => fetch(`${instance.baseUrl}${path}`, init), '/wallets', request);
    }),
  );

  const created = responses.filter((r) => r.status === 201);
  const conflicts = responses.filter((r) => r.status === 409);
  expect(created).toHaveLength(1);
  expect(conflicts).toHaveLength(9);
  const walletId = created[0]!.body.id;
  for (const conflict of conflicts) {
    expect(conflict.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false, details: { walletId } });
    expect(Object.keys(conflict.body.error.details ?? {})).toEqual(['walletId']);
  }

  const wallets = await database.db.query('SELECT id FROM wallets WHERE player_id = ?', [request.playerId]);
  expect(wallets).toEqual([{ id: walletId }]);
  const openings = await database.db.query("SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'", [walletId]);
  expect(openings).toHaveLength(1);
  const entries = await database.db.query('SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
  expect(entries).toHaveLength(1);
  const events = await database.db.query('SELECT id FROM outbox_messages WHERE aggregate_id = ?', [walletId]);
  expect(events).toHaveLength(1);
  await assertWalletMatchesLedger(database.db, walletId);
});
