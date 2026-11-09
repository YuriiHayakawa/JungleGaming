// T058 — publicador da outbox (US3 cenários 1, 3 e 5; FR-016 a FR-022; I-29, I-31, I-32, I-65; SC-010), com PostgreSQL e
// MiniStack reais. A fila de eventos "inacessível" é um proxy TCP cortado na frente do MiniStack (tráfego real, sem mock).
import { afterAll, describe, expect, test } from 'bun:test';
import { MikroOrmOutboxRepository } from '../../src/outbox/infrastructure/mikro-orm-outbox.repository.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { SQS_ENDPOINT, collectUntil, waitFor } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('outbox_publisher');
const queues = useTestQueues('outbox-publisher');
const opened: RunningApp[] = [];
const proxies: TcpProxy[] = [];

afterAll(async () => {
  for (const app of opened) await app.close();
  for (const proxy of proxies) proxy.close();
});

async function start(options: { publisher: boolean; endpoint?: string }) {
  const app = await startApp({
    databaseUrl: database.url,
    roles: { publisher: options.publisher },
    queues: queues.env(options.endpoint),
    env: { PUBLISHER_POLL_MS: '100' },
  });
  opened.push(app);
  return app;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

const outboxOf = (transactionId: string) =>
  database.db.query<OutboxRow>(
    "SELECT id, aggregate_id, payload, attempts, next_attempt_at, published_at FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?",
    [transactionId],
  );

describe('publicação', () => {
  test('os eventos de uma BET aparecem em wager-events em até 5 s, com o payload gravado, grupo = aggregateId e deduplicação = eventId', async () => {
    const app = await start({ publisher: true });
    const wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
    const response = await submitWager(fetcherFor(app.baseUrl), wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
    expect(response.status).toBe(201);
    const committedAt = performance.now();
    const rows = await outboxOf(response.body.transactionId);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id);

    const received = await collectUntil(queues.urls.events, (all) => ids.every((id) => all.some((m) => m.deduplicationId === id)), 5_000);
    expect(performance.now() - committedAt).toBeLessThan(5_000); // SC-010
    for (const row of rows) {
      const message = received.find((m) => m.deduplicationId === row.id);
      expect(message).toBeDefined();
      expect(JSON.parse(message!.body)).toEqual(row.payload); // FR-022: o envelope gravado, sem alteração
      expect(message!.groupId).toBe(row.aggregate_id);
    }
    await waitFor(async () => (await outboxOf(response.body.transactionId)).every((r) => r.published_at !== null), 5_000);
    await app.close();
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);
});

describe('falha de envio', () => {
  // Com a fila fora, cada rodada para na primeira falha de envio (N-22): o evento que falhou conta tentativa com o
  // backoff do I-65 (1 s, depois 2 s) e os não tentados voltam sem contar. Cada evento é acompanhado individualmente.
  test('com a fila de eventos inacessível: published_at continua nulo, e cada evento que falha avança 1 s, depois 2 s', async () => {
    const proxy = await startTcpProxy(SQS_ENDPOINT);
    proxies.push(proxy);
    const endpoint = proxy.url.replace(/\/$/, '');
    const app = await start({ publisher: true, endpoint });
    const wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
    // O evento de abertura sai com a fila no ar; só os eventos da BET ficam sob a fila cortada.
    await waitFor(async () => (await database.db.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).length === 0, 10_000);
    proxy.cut();
    const response = await submitWager(fetcherFor(app.baseUrl), wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
    expect(response.status).toBe(201); // o HTTP não depende da fila (FR-033)

    // Primeira observação de cada (evento, attempts): quanto falta para a próxima tentativa naquele instante.
    const ahead = new Map<string, number>();
    await waitFor(async () => {
      const observedAt = Date.now();
      const rows = await outboxOf(response.body.transactionId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.published_at).toBeNull();
        const key = `${row.id}:${row.attempts}`;
        if (row.attempts > 0 && !ahead.has(key)) ahead.set(key, row.next_attempt_at.getTime() - observedAt);
      }
      return rows.every((r) => r.attempts >= 2);
    }, 30_000, 20);

    const ids = (await outboxOf(response.body.transactionId)).map((r) => r.id);
    for (const id of ids) {
      const first = ahead.get(`${id}:1`)!;
      const second = ahead.get(`${id}:2`)!;
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(1_000);
      expect(second).toBeGreaterThan(1_000);
      expect(second).toBeLessThanOrEqual(2_000);
    }
    await app.close();
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 45_000);
});

describe('claim com lease (data-model §3.2)', () => {
  test('reserva no máximo 10 eventos e avança next_attempt_at em 30 s; outra reserva não pega os mesmos', async () => {
    const app = await start({ publisher: false });
    const http = fetcherFor(app.baseUrl);
    for (let i = 0; i < 15; i++) await openWallet(http, '1.00'); // 15 eventos de abertura pendentes
    const repository = new MikroOrmOutboxRepository();
    const now = new Date(Date.now() + 60_000); // todos os pendentes já vencidos
    const pendingBefore = await database.db.query('SELECT id FROM outbox_messages WHERE published_at IS NULL');
    expect(pendingBefore.length).toBeGreaterThanOrEqual(15);

    const claimed = await app.orm.em.fork().transactional((em) => repository.claim(em, now, 10, 30_000));
    expect(claimed).toHaveLength(10);
    const rows = await database.db.query<{ id: string; next_attempt_at: Date }>('SELECT id, next_attempt_at FROM outbox_messages WHERE id = ANY(?)', [
      claimed.map((m) => m.id),
    ]);
    for (const row of rows) expect(row.next_attempt_at.getTime()).toBe(now.getTime() + 30_000);

    const again = await app.orm.em.fork().transactional((em) => repository.claim(em, now, 10, 30_000));
    expect(again.map((m) => m.id).filter((id) => claimed.some((c) => c.id === id))).toEqual([]);
    await app.close();
  }, 30_000);
});
