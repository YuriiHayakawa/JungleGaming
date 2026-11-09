// T022 — ready 503 durante o encerramento, com o HTTP ainda atendendo (US2 cenário 4; FR-016; SC-006; R-40 e o
// requisito E-1 do usuário: 503 desde o instante do encerramento, antes da drenagem). Consumidor ligado; uma mensagem
// fica em andamento, presa no lock da wallet segurado por fora (FOR UPDATE real). `app.shutdown()` é o mesmo
// `gracefulShutdown` do handler de sinal. PostgreSQL e MiniStack reais.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('health_shutdown');
const queues = useTestQueues('health-shutdown');
let app: RunningApp;

beforeAll(async () => {
  app = await startApp({
    databaseUrl: database.url,
    roles: { consumer: true },
    queues: queues.env(),
    env: {
      CONSUMER_WAIT_SECONDS: '1',
      CONSUMER_SHUTDOWN_TIMEOUT_MS: '15000',
      WALLET_LOCK_TIMEOUT_MS: '8000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '9000',
      HTTP_SERVER_TIMEOUT_MS: '20000',
    },
  });
});

afterAll(async () => {
  await app?.close();
});

test('durante a drenagem: ready 503 com checks reais, outras rotas respondendo; a mensagem conclui uma vez', async () => {
  const http = fetcherFor(app.baseUrl);
  const wallet = await openWallet(http, '100.00');
  const ready = async () => {
    const response = await http('/health/ready');
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  expect(await ready()).toEqual({ status: 200, body: { status: 'ok', checks: { postgres: 'up', sqs: 'up' } } });

  const envelope = wagerEnvelope(wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), {
    messageId: newMessageId('health-shutdown'),
  });
  const holder = await database.db.connect();
  await holder.q.query('BEGIN');
  await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await holder.q.query('ROLLBACK').catch(() => {});
    holder.release();
  };

  let shutdown: Promise<void> | undefined;
  try {
    await sendEnvelope(queues.urls.transactions, envelope);
    // Recebida e presa no lock da wallet.
    await waitFor(async () => (await counts(queues.urls.transactions)).notVisible === 1, 15_000, 100);
    await Bun.sleep(300);

    let finished = false;
    shutdown = app.shutdown().then(() => void (finished = true));

    // Logo depois do início do encerramento: 503 (o encerramento começou; a drenagem ainda espera o lock).
    const first = await ready();
    expect(first).toEqual({ status: 503, body: { status: 'unavailable', checks: { postgres: 'up', sqs: 'up' } } });
    expect(finished).toBe(false);

    // Enquanto drena: o HTTP continua atendendo as demais rotas, e o ready continua 503.
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(200);
      const wallets = await http(`/wallets/${wallet.id}`);
      expect(wallets.status).toBe(200);
      expect((await ready()).status).toBe(503);
      const live = await http('/health/live');
      expect(live.status).toBe(200);
    }
    expect(finished).toBe(false);
    // Nada concluído ainda: a mensagem está presa no lock.
    expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(0);

    await release();
    await shutdown;
  } finally {
    await release();
    await shutdown?.catch(() => {});
  }

  // A mensagem foi concluída (commit e ack) antes de a app fechar, uma única vez.
  const processed = app.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === 'consumer.message' && entry.messageId === envelope.messageId);
  expect(processed).toHaveLength(1);
  expect(processed[0]!.outcome).toBe('processed');
  expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(1);
  expect(await database.db.query("SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'", [wallet.id])).toHaveLength(1);
  expect(await counts(queues.urls.transactions)).toEqual({ visible: 0, notVisible: 0 });
  // Depois do encerramento, o servidor HTTP fechou.
  await expect(fetch(`${app.baseUrl}/health/live`)).rejects.toThrow();
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
