// T043 — queda entre o commit e o ack (US1 cenário 4; FR-005; I-28, I-40; SC-002): uma instância com
// FAILPOINT=after_commit_before_ack processa a mensagem e sai (código 1) depois do commit; outra instância recebe a
// reentrega depois da visibilidade, reconhece a duplicata pela inbox e confirma. Exatamente 1 efeito.
import { afterAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { startInstance, type Instance } from '../support/instance-cluster.ts';
import { sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('crash_before_ack');
const queues = useTestQueues('crash-before-ack');
const instances: Instance[] = [];

afterAll(async () => {
  for (const instance of instances) await instance.stop();
});

// Visibilidade curta para a reentrega acontecer logo; a hierarquia do R-27 continua valendo (6 s > 2 s + 1 s + 2 s).
const SHORT_TIMEOUTS = {
  WALLET_LOCK_TIMEOUT_MS: '1000',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '6',
  PUBLISHER_LEASE_MS: '6000',
  PENDING_WORKER_LEASE_MS: '6000',
  CONSUMER_WAIT_SECONDS: '1',
};

async function start(env: Record<string, string>) {
  const instance = await startInstance({ databaseUrl: database.url, roles: { consumer: true }, queues: queues.env(), env: { ...SHORT_TIMEOUTS, ...env } });
  instances.push(instance);
  return instance;
}

test('a reentrega depois da queda é duplicata pela inbox: 1 efeito, ApproximateReceiveCount 2, confirmada', async () => {
  const crashing = await start({ FAILPOINT: 'after_commit_before_ack' });
  const wallet = await openWallet(fetcherFor(crashing.baseUrl), '100.00');
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '40.00', currency: 'BRL' } });
  const envelope = wagerEnvelope(request);
  await sendEnvelope(queues.urls.transactions, envelope);

  expect(await crashing.exited).toBe(1);
  // O commit aconteceu: transação e inbox gravadas; a mensagem continua na fila (sem ack).
  const committed = await database.db.query<{ id: string }>('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [
    request.externalTransactionId,
  ]);
  expect(committed).toHaveLength(1);
  const c = await counts(queues.urls.transactions);
  expect(c.visible + c.notVisible).toBe(1);

  const survivor = await start({});
  await waitForEmpty(queues.urls.transactions, 20_000);

  const lines = survivor.logs
    .filter((line) => line.includes(envelope.messageId))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === 'consumer.message');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ outcome: 'duplicate', receiveCount: 2 });

  const txs = await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]);
  expect(txs).toHaveLength(1);
  expect(await database.db.query('SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?', [committed[0]!.id])).toHaveLength(1);
  expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(1);
  const [row] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
  expect(row?.balance).toBe('60.00');
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
