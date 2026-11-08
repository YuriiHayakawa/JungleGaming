// T093 — REFUND × ROLLBACK simultâneos da mesma BET em 3 instâncias, repetido 20 vezes (US5 cenário 4; SC-003,
// SC-005, FR-025, I-16; falha eliminatória 3: crédito duplicado).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type TransactionResultBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('reversal_race');
const REPETITIONS = 20;
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url });
});
afterAll(async () => {
  await cluster?.stop();
});

test(`REFUND e ROLLBACK simultâneos da mesma BET PROCESSED, por instâncias diferentes, ${REPETITIONS} vezes`, async () => {
  const instances = cluster.instances;
  expect(instances).toHaveLength(3);
  const pairsUsed = new Set<string>();
  const winners = { REFUND: 0, ROLLBACK: 0 };

  for (let round = 0; round < REPETITIONS; round++) {
    const [a, b, c] = [instances[round % 3]!, instances[(round + 1) % 3]!, instances[(round + 2) % 3]!];
    pairsUsed.add(`${a.pid}-${b.pid}`);
    const setup = fetcherFor(c.baseUrl);
    const wallet = await openWallet(setup, '100.00');
    const betRequest = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const bet = await submitWager<TransactionResultBody>(setup, betRequest);
    expect(bet.status).toBe(201);

    const reversal = (kind: 'REFUND' | 'ROLLBACK') =>
      wagerRequest(kind, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: betRequest.externalTransactionId,
      });
    // alterna quem sai primeiro para não favorecer um tipo
    const [first, second] = round % 2 === 0 ? (['REFUND', 'ROLLBACK'] as const) : (['ROLLBACK', 'REFUND'] as const);
    const requests = [reversal(first), reversal(second)];
    const responses = await Promise.all([
      submitWager<TransactionResultBody>(fetcherFor(a.baseUrl), requests[0]!),
      submitWager<TransactionResultBody>(fetcherFor(b.baseUrl), requests[1]!),
    ]);
    const detail = `round ${round}: ${JSON.stringify(responses.map((r) => [r.status, r.body]))}`;

    const processed = responses.filter((r) => r.status === 201 && r.body.status === 'PROCESSED');
    const alreadyReversed = responses.filter(
      (r) => r.status === 422 && r.body.status === 'REJECTED' && r.body.failureCode === 'ALREADY_REVERSED',
    );
    expect(processed, detail).toHaveLength(1);
    expect(alreadyReversed, detail).toHaveLength(1);
    expect(processed[0]!.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const winnerIndex = responses.indexOf(processed[0]!);
    winners[requests[winnerIndex]!.kind as 'REFUND' | 'ROLLBACK'] += 1;

    // exatamente 1 crédito de reversão, da transação vencedora
    const reversalCredits = await database.db.query<{ transaction_id: string; amount: string }>(
      `SELECT l.transaction_id, l.amount
         FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
        WHERE l.wallet_id = ? AND l.direction = 'CREDIT' AND t.kind IN ('REFUND','ROLLBACK')`,
      [wallet.id],
    );
    expect(reversalCredits, detail).toEqual([{ transaction_id: processed[0]!.body.transactionId, amount: '25.00' }]);

    const reversals = await database.db.query<{ status: string; failure_code: string | null; reference_transaction_id: string | null }>(
      "SELECT status, failure_code, reference_transaction_id FROM wager_transactions WHERE wallet_id = ? AND kind IN ('REFUND','ROLLBACK') ORDER BY status",
      [wallet.id],
    );
    expect(reversals, detail).toEqual([
      { status: 'PROCESSED', failure_code: null, reference_transaction_id: bet.body.transactionId },
      { status: 'REJECTED', failure_code: 'ALREADY_REVERSED', reference_transaction_id: null },
    ]);

    const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(row).toEqual({ balance: '100.00', version: 3 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }

  expect(pairsUsed.size).toBe(3);
  expect(winners.REFUND + winners.ROLLBACK).toBe(REPETITIONS);
  console.log(`reversal-race: vencedores ${JSON.stringify(winners)} em ${REPETITIONS} rodadas`);
}, 120_000);
