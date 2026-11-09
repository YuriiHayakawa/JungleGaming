// T041 — atomicidade pela fila (FR-003, FR-013; constitution IV): com o failpoint entre o lançamento e o commit, a
// mensagem não deixa nenhuma linha (transação, ledger, outbox nem inbox) e não é confirmada (volta a ficar visível);
// depois de reiniciar a app sem failpoint, é processada uma única vez.
import { afterAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('consumer_atomicity');
const queues = useTestQueues('consumer-atomicity');
const opened: RunningApp[] = [];

afterAll(async () => {
  for (const app of opened) await app.close();
});

async function start(env: Record<string, string>, consumer: boolean) {
  const app = await startApp({
    databaseUrl: database.url,
    roles: { consumer },
    queues: queues.env(),
    env: { CONSUMER_WAIT_SECONDS: '1', CONSUMER_RETRY_BASE_SECONDS: '1', ...env },
  });
  opened.push(app);
  return app;
}

test('falha antes do commit: nada gravado, mensagem não confirmada; reinício sem failpoint processa uma vez', async () => {
  const setup = await start({}, false);
  const wallet = await openWallet(fetcherFor(setup.baseUrl), '100.00');
  await setup.close();

  const failing = await start({ FAILPOINT: 'after_ledger_insert_before_commit' }, true);
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '30.00', currency: 'BRL' } });
  const envelope = wagerEnvelope(request);
  await sendEnvelope(queues.urls.transactions, envelope);

  // Pelo menos duas entregas com erro: a mensagem voltou a ficar visível depois da primeira.
  const failures = () => failing.logs.filter((line) => line.includes(envelope.messageId) && line.includes('"outcome":"error"')).length;
  await waitFor(() => failures() >= 2, 10_000);
  await failing.close();

  const txs = await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]);
  expect(txs).toHaveLength(0);
  expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(0);
  const ledger = await database.db.query('SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ?', [wallet.id]);
  expect(ledger).toHaveLength(1); // só a abertura
  const outbox = await database.db.query<{ event_type: string }>('SELECT event_type FROM outbox_messages WHERE aggregate_id = ?', [wallet.id]);
  expect(outbox.map((r) => r.event_type)).toEqual(['WalletBalanceChanged']); // só a da abertura
  const c = await counts(queues.urls.transactions);
  expect(c.visible + c.notVisible).toBe(1);
  await assertWalletMatchesLedger(database.db, wallet.id);

  await start({}, true);
  await waitFor(
    async () => (await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).length === 1,
    15_000,
  );
  await waitForEmpty(queues.urls.transactions, 10_000);
  const processed = await database.db.query<{ status: string }>('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [
    request.externalTransactionId,
  ]);
  expect(processed).toEqual([{ status: 'PROCESSED' }]);
  const [row] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
  expect(row?.balance).toBe('70.00');
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
