// T060 — publicadores concorrentes (US3 cenários 2 e 3; FR-017, FR-019; I-31, I-65; SC-003, SC-008): 3 instâncias
// publicadoras sobre a mesma outbox e 200 eventos gerados por HTTP; uma delas, com FAILPOINT=before_publish_mark, sai
// depois do primeiro envio (antes de marcar). Ao final todo eventId aparece em wager-events, nenhuma linha fica com
// published_at nulo e qualquer repetição tem o mesmo eventId.
import { afterAll, expect, test } from 'bun:test';
import { assertAllWalletsMatchLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { startInstance, type Instance } from '../support/instance-cluster.ts';
import { collectUntil, waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('concurrent_publishers');
const queues = useTestQueues('concurrent-publishers');
const instances: Instance[] = [];

afterAll(async () => {
  for (const instance of instances) await instance.stop();
});

// Lease curto para a retomada depois da queda; a hierarquia do R-27 continua valendo (6 s > 2 s + 1 s + 2 s).
const SHORT = {
  WALLET_LOCK_TIMEOUT_MS: '1000',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
  PUBLISHER_LEASE_MS: '6000',
  PENDING_WORKER_LEASE_MS: '6000',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '6',
  PUBLISHER_POLL_MS: '100',
};

async function start(env: Record<string, string> = {}) {
  const instance = await startInstance({ databaseUrl: database.url, roles: { publisher: true }, queues: queues.env(), env: { ...SHORT, ...env } });
  instances.push(instance);
  return instance;
}

test('3 publicadores, 200 eventos, um deles morre entre o envio e a marca: todos publicados, nenhum pendente', async () => {
  const [crashing, a, b] = await Promise.all([start({ FAILPOINT: 'before_publish_mark' }), start(), start()]);
  const http = fetcherFor(a!.baseUrl);

  // 10 aberturas (10 eventos) + 95 BETs (190 eventos) = 200 eventos.
  const wallets = [];
  for (let i = 0; i < 10; i++) wallets.push(await openWallet(http, '1000.00'));
  for (let i = 0; i < 95; i++) {
    const wallet = wallets[i % wallets.length]!;
    const response = await submitWager(i % 2 === 0 ? http : fetcherFor(b!.baseUrl), wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } }));
    expect(response.status).toBe(201);
  }
  const all = await database.db.query<{ id: string }>('SELECT id FROM outbox_messages');
  expect(all).toHaveLength(200);

  expect(await crashing!.exited).toBe(1); // saiu depois de um envio, sem marcar
  await waitFor(async () => (await database.db.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).length === 0, 60_000, 250);

  const ids = new Set(all.map((r) => r.id));
  const received = await collectUntil(queues.urls.events, (got) => [...ids].every((id) => got.some((m) => m.deduplicationId === id)), 30_000);
  // Repetições (reentrega depois da queda) carregam o mesmo eventId: o corpo repete o envelope gravado.
  for (const message of received) {
    expect(ids.has(message.deduplicationId ?? '')).toBe(true);
    expect((JSON.parse(message.body) as { eventId: string }).eventId).toBe(message.deduplicationId!);
  }
  const marked = await database.db.query<{ published_at: Date | null }>('SELECT published_at FROM outbox_messages');
  expect(marked.every((r) => r.published_at !== null)).toBe(true);
  await assertAllWalletsMatchLedger(database.db);
}, 120_000);
