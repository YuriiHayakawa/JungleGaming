// T070 — atomicidade com failpoint entre o lançamento e o commit (FR-040, SC-007, I-40; falha eliminatória 6).
import { afterAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type TransactionResultBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('atomicity');
let running: RunningApp | undefined;

afterAll(async () => {
  await running?.close();
});

async function snapshot(walletId: string) {
  const [row] = await database.db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = ?)::text AS txs,
            (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::text AS entries,
            (SELECT count(*) FROM outbox_messages WHERE aggregate_id = ?)::text AS events,
            (SELECT balance::text FROM wallets WHERE id = ?) AS balance,
            (SELECT version::text FROM wallets WHERE id = ?) AS version`,
    [walletId, walletId, walletId, walletId, walletId],
  );
  return row;
}

test('falha depois do lançamento e antes do commit → 500 sem nenhum efeito; o reenvio processa uma vez', async () => {
  running = await startApp({ databaseUrl: database.url, env: { FAILPOINT: 'after_ledger_insert_before_commit' } });
  const wallet = await openWallet(fetcherFor(running.baseUrl), '100.00');
  const before = await snapshot(wallet.id);
  expect(before).toEqual({ txs: '1', entries: '1', events: '1', balance: '100.00', version: '1' });

  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '30.00', currency: 'BRL' } });
  const failed = await submitWager<ErrorBody>(fetcherFor(running.baseUrl), request);
  expect(failed.status).toBe(500);
  expect(failed.body.error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });

  // nenhuma linha nova em transações, ledger e outbox; wallet intacta (nenhum evento antes do commit)
  expect(await snapshot(wallet.id)).toEqual(before);
  expect(await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId])).toEqual([]);

  // reinicia a app sem o failpoint e reenvia a mesma requisição
  await running.close();
  running = await startApp({ databaseUrl: database.url });
  const retried = await submitWager<TransactionResultBody>(fetcherFor(running.baseUrl), request);
  expect(retried.status).toBe(201);
  expect(retried.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '70.00', currency: 'BRL' } });

  const debits = await database.db.query("SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [wallet.id]);
  expect(debits).toHaveLength(1);
  expect(await snapshot(wallet.id)).toEqual({ txs: '2', entries: '2', events: '3', balance: '70.00', version: '2' });
  await assertWalletMatchesLedger(database.db, wallet.id);
});
