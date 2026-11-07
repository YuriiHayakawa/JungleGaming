// T132 — repetição interna da transação de submissão (R-12): 40001 na 1ª passagem, sucesso na 2ª, um só efeito.
// O 40001 vem do failpoint `after_ledger_insert_before_commit:serialization_failure_once` (I-40), lançado depois do
// INSERT do lançamento e antes do commit; a 1ª tentativa sofre rollback e a 2ª precisa recomeçar do zero.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { EnvFailpoints, FAILPOINTS } from '../../src/platform/failpoints/failpoints.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type TransactionResultBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('transaction_retry');
let running: RunningApp;

beforeAll(async () => {
  running = await startApp({
    databaseUrl: database.url,
    env: { FAILPOINT: 'after_ledger_insert_before_commit:serialization_failure_once' },
  });
});
afterAll(async () => {
  await running?.close();
});

test('BET com 40001 só na 1ª passagem → 201, 1 transação, 1 débito, 1 lançamento e eventos uma vez', async () => {
  const http = fetcherFor(running.baseUrl);
  const wallet = await openWallet(http, '100.00');
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '30.00', currency: 'BRL' } });

  const response = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'corr-retry' });
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '70.00', currency: 'BRL' } });

  // a repetição aconteceu: o failpoint disparou uma vez e foi atravessado duas
  const failpoints = running.app.get<EnvFailpoints>(FAILPOINTS);
  expect(failpoints.triggered('after_ledger_insert_before_commit')).toBe(1);
  expect(failpoints.passes('after_ledger_insert_before_commit')).toBe(2);

  const txs = await database.db.query<{ id: string; status: string }>(
    'SELECT id, status FROM wager_transactions WHERE external_transaction_id = ?',
    [request.externalTransactionId],
  );
  expect(txs).toEqual([{ id: response.body.transactionId, status: 'PROCESSED' }]);

  const debits = await database.db.query<{ transaction_id: string; amount: string }>(
    "SELECT transaction_id, amount FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
    [wallet.id],
  );
  expect(debits).toEqual([{ transaction_id: response.body.transactionId, amount: '30.00' }]);
  const entries = await database.db.query('SELECT id FROM wallet_ledger_entries WHERE transaction_id = ?', [response.body.transactionId]);
  expect(entries).toHaveLength(1);

  const [walletRow] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
  expect(walletRow).toEqual({ balance: '70.00', version: 2 });

  const events = await database.db.query<{ id: string; event_type: string }>(
    "SELECT id, event_type FROM outbox_messages WHERE correlation_id = 'corr-retry' ORDER BY id",
  );
  expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);

  await assertWalletMatchesLedger(database.db, wallet.id);
});
