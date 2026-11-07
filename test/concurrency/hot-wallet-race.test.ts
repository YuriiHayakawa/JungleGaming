// T071 — critério de parada do MVP: 100/80/80 em 3 instâncias, repetido 20 vezes (US2 cenários 3 e 4; SC-001,
// SC-005; falha eliminatória 2).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type TransactionResultBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('hot_wallet_race');
const REPETITIONS = 20;
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url });
});
afterAll(async () => {
  await cluster?.stop();
});

test(`saldo 100.00 e duas BETs de 80.00 simultâneas por instâncias diferentes, ${REPETITIONS} vezes`, async () => {
  const instances = cluster.instances;
  expect(instances).toHaveLength(3);
  const pairsUsed = new Set<string>();

  for (let round = 0; round < REPETITIONS; round++) {
    const [a, b] = [instances[round % 3]!, instances[(round + 1) % 3]!];
    pairsUsed.add(`${a.pid}-${b.pid}`);
    const wallet = await openWallet(fetcherFor(instances[(round + 2) % 3]!.baseUrl), '100.00');
    const bets = [0, 1].map(() =>
      wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '80.00', currency: 'BRL' } }),
    );

    const responses = await Promise.all([
      submitWager<TransactionResultBody>(fetcherFor(a.baseUrl), bets[0]!),
      submitWager<TransactionResultBody>(fetcherFor(b.baseUrl), bets[1]!),
    ]);

    const processed = responses.filter((r) => r.status === 201 && r.body.status === 'PROCESSED');
    const rejected = responses.filter(
      (r) => r.status === 422 && r.body.status === 'REJECTED' && r.body.failureCode === 'INSUFFICIENT_FUNDS',
    );
    expect(processed, `round ${round}: ${JSON.stringify(responses.map((r) => [r.status, r.body]))}`).toHaveLength(1);
    expect(rejected, `round ${round}`).toHaveLength(1);
    expect(processed[0]!.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(row).toEqual({ balance: '20.00', version: 2 });
    const debits = await database.db.query("SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [
      wallet.id,
    ]);
    expect(debits).toEqual([{ transaction_id: processed[0]!.body.transactionId }]);
    const statuses = await database.db.query<{ status: string }>(
      "SELECT status FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' ORDER BY status",
      [wallet.id],
    );
    expect(statuses.map((s) => s.status)).toEqual(['PROCESSED', 'REJECTED']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }

  // as requisições de cada par chegaram por instâncias diferentes, e todas as 3 participaram
  expect(pairsUsed.size).toBe(3);
}, 120_000);
