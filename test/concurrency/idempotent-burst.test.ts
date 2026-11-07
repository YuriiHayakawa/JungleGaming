// T083 — critério de parada do MVP: a mesma BET 50 vezes em paralelo nas 3 instâncias → 1 débito (US3 cenário 3;
// SC-002, SC-005, FR-035; falha eliminatória 3).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type TransactionResultBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('idempotent_burst');
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url });
});
afterAll(async () => {
  await cluster?.stop();
});

test('50 envios paralelos da mesma BET com a mesma chave → 1 DEBIT; 1 × 201 e 49 × 200 com o mesmo transactionId', async () => {
  const wallet = await openWallet(cluster.fetch, '1000.00');
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });

  const responses = await Promise.all(
    Array.from({ length: 50 }, (_, i) => submitWager<TransactionResultBody>(fetcherFor(cluster.instances[i % 3]!.baseUrl), request)),
  );

  const byStatus = responses.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  // nenhuma resposta 409, 500 ou 503 (SC-002)
  expect(byStatus).toEqual({ 200: 49, 201: 1 });

  const ids = new Set(responses.map((r) => r.body.transactionId));
  expect(ids.size).toBe(1);
  const transactionId = [...ids][0]!;
  expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
  expect(responses.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
  for (const r of responses) {
    expect(r.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' } });
  }
  expect(responses.find((r) => r.status === 201)!.body.idempotentReplay).toBe(false);

  const debits = await database.db.query<{ transaction_id: string }>(
    "SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
    [wallet.id],
  );
  expect(debits).toEqual([{ transaction_id: transactionId }]);
  const txs = await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]);
  expect(txs).toHaveLength(1);
  const events = await database.db.query("SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?", [transactionId]);
  expect(events).toHaveLength(2);
  const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
  expect(row).toEqual({ balance: '975.00', version: 2 });
  // diagnóstico: onde cada replay foi reconhecido (caminho rápido ou releitura sob o lock); nenhuma linha traz dinheiro
  const sources: Record<string, number> = {};
  for (const line of cluster.instances.flatMap((i) => i.logs)) {
    if (!line.includes('"wager.idempotency"')) continue;
    const entry = JSON.parse(line) as { source: string; outcome: string; amount?: unknown };
    expect(entry.amount).toBeUndefined();
    expect(entry.outcome).toBe('replay');
    sources[entry.source] = (sources[entry.source] ?? 0) + 1;
  }
  expect(Object.values(sources).reduce((a, b) => a + b, 0)).toBe(49);
  console.log(`T083 caminhos dos 49 replays: ${JSON.stringify(sources)}`);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
