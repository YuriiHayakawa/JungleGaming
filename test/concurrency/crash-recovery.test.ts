// T109 — processo morto depois do commit e antes da resposta; outra instância recebe o reenvio (SC-007, I-40, R-16).
// Dois processos reais (Bun.spawn) no mesmo banco. O failpoint `after_commit_before_response` encerra o processo A
// logo depois do COMMIT; o provedor vê a conexão cair, reenvia para B e recebe o replay do efeito já confirmado.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { idempotencyKeyFor, wagerRequest } from '../support/factories.ts';
import { fetcherFor, type TransactionResultBody } from '../support/http.ts';
import { isProcessAlive, startInstance, type Instance } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('crash_recovery');
let crashing: Instance;
let healthy: Instance;

beforeAll(async () => {
  [crashing, healthy] = await Promise.all([
    startInstance({ databaseUrl: database.url, env: { FAILPOINT: 'after_commit_before_response' } }),
    startInstance({ databaseUrl: database.url }),
  ]);
});
afterAll(async () => {
  await Promise.all([crashing?.stop(), healthy?.stop()]);
});

test('a BET confirmada em A, que morre antes de responder, vira replay em B: mesmo transactionId e 1 DEBIT', async () => {
  const wallet = await openWallet(fetcherFor(healthy.baseUrl), '100.00');
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '30.00', currency: 'BRL' } });

  // A confirma e sai antes de responder: o provedor vê a conexão cair, sem status
  let firstError: unknown;
  try {
    await fetch(`${crashing.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKeyFor(request) },
      body: JSON.stringify(request),
    });
  } catch (error) {
    firstError = error;
  }
  expect(firstError).toBeDefined();
  expect(await crashing.exited).toBe(1);
  expect(isProcessAlive(crashing.pid)).toBe(false);

  // o efeito foi confirmado antes da queda
  const committed = await database.db.query<{ id: string; status: string }>(
    'SELECT id, status FROM wager_transactions WHERE external_transaction_id = ?',
    [request.externalTransactionId],
  );
  expect(committed).toHaveLength(1);
  expect(committed[0]!.status).toBe('PROCESSED');

  // o reenvio para B é replay do resultado original
  const replay = await submitWager<TransactionResultBody>(fetcherFor(healthy.baseUrl), request);
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body).toEqual({
    transactionId: committed[0]!.id,
    status: 'PROCESSED',
    balance: { amount: '70.00', currency: 'BRL' },
    idempotentReplay: true,
  });

  const debits = await database.db.query("SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [wallet.id]);
  expect(debits).toEqual([{ transaction_id: committed[0]!.id }]);
  const events = await database.db.query<{ event_type: string }>(
    "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY id",
    [committed[0]!.id],
  );
  expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
  const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
  expect(row).toEqual({ balance: '70.00', version: 2 });
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
