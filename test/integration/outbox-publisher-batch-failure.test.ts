// Ajuste N-22 do publicador (implementation-notes): com o SQS indisponível, a rodada para na primeira falha de envio.
// Só o evento que falhou conta tentativa (attempts + 1, backoff de 1 s); os outros 9 reservados e não tentados são
// devolvidos (next_attempt_at = agora, attempts inalterado), sem esperar o lease de 30 s. PostgreSQL e MiniStack reais; o
// SQS "indisponível" é um proxy TCP cortado na frente do MiniStack (tráfego real, sem mock).
import { afterAll, expect, test } from 'bun:test';
import type { PublishOutboxUseCase } from '../../src/outbox/application/publish-outbox.use-case.ts';
import { PUBLISH_OUTBOX_USE_CASE } from '../../src/outbox/interfaces/outbox-publisher.worker.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertAllWalletsMatchLedger } from '../support/assert-wallet-matches-ledger.ts';
import { fetcherFor } from '../support/http.ts';
import { SQS_ENDPOINT } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('outbox_batch_failure');
const queues = useTestQueues('outbox-batch-failure');
let app: RunningApp | undefined;
let proxy: TcpProxy | undefined;

afterAll(async () => {
  await app?.close();
  proxy?.close();
});

interface Row extends Record<string, unknown> {
  id: string;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

test('SQS indisponível com lote de 10: 1 evento com attempts incrementado e 9 devolvidos sem contar tentativa', async () => {
  proxy = await startTcpProxy(SQS_ENDPOINT);
  proxy.cut();
  // Publicador desligado: a rodada é disparada aqui, uma única vez, pelo use case do container.
  app = await startApp({ databaseUrl: database.url, roles: {}, queues: queues.env(proxy.url.replace(/\/$/, '')) });
  const http = fetcherFor(app.baseUrl);
  for (let i = 0; i < 12; i++) await openWallet(http, '1.00');

  // Empate em next_attempt_at (ajuste do claim: ORDER BY next_attempt_at, id): com todos iguais, a ordem é a do id.
  await database.db.query('UPDATE outbox_messages SET next_attempt_at = (SELECT min(next_attempt_at) FROM outbox_messages)');
  const before = await database.db.query<Row>('SELECT id, attempts, next_attempt_at, published_at FROM outbox_messages ORDER BY id');
  expect(new Set(before.map((r) => r.next_attempt_at.getTime())).size).toBe(1);
  expect(before.length).toBeGreaterThanOrEqual(12);
  expect(before.every((r) => r.attempts === 0 && r.published_at === null)).toBe(true);
  const expectedBatch = before.slice(0, 10).map((r) => r.id); // a ordem do claim: next_attempt_at, id

  const useCase = app.app.get<PublishOutboxUseCase>(PUBLISH_OUTBOX_USE_CASE);
  const startedAt = Date.now();
  const round = await useCase.publishOnce();
  const endedAt = Date.now();
  expect(round).toEqual({ claimed: 10, published: 0, failed: 1, released: 9 });

  const after = await database.db.query<Row>('SELECT id, attempts, next_attempt_at, published_at FROM outbox_messages');
  const byId = new Map(after.map((r) => [r.id, r]));
  expect(after.every((r) => r.published_at === null)).toBe(true);

  // O primeiro do lote falhou: attempts 1 e próxima tentativa 1 s depois da falha (OutboxMessage.scheduleRetry).
  const failed = byId.get(expectedBatch[0]!)!;
  expect(failed.attempts).toBe(1);
  expect(failed.next_attempt_at.getTime()).toBeGreaterThanOrEqual(startedAt + 1_000);
  expect(failed.next_attempt_at.getTime()).toBeLessThanOrEqual(endedAt + 1_000);

  // Os 9 seguintes foram devolvidos: attempts 0 e next_attempt_at = agora (não o lease de 30 s).
  for (const id of expectedBatch.slice(1)) {
    const row = byId.get(id)!;
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(endedAt);
  }

  // Os que ficaram fora do lote não foram tocados.
  for (const original of before.slice(10)) {
    const row = byId.get(original.id)!;
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at.getTime()).toBe(original.next_attempt_at.getTime());
  }

  const logged = app.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(logged.filter((l) => l.msg === 'publisher.send_failed')).toHaveLength(1);

  // A próxima rodada não pega o que acabou de falhar (vence só em 1 s): pega os vencidos, por next_attempt_at, id —
  // primeiro os que ficaram fora do lote (vencidos desde a criação), depois os devolvidos. Só o primeiro conta tentativa.
  const next = await useCase.publishOnce();
  expect(next).toEqual({ claimed: 10, published: 0, failed: 1, released: 9 });
  const second = await database.db.query<Row>('SELECT id, attempts FROM outbox_messages WHERE attempts > 0');
  expect(second.map((r) => r.id).sort()).toEqual([expectedBatch[0]!, before[10]!.id].sort());
  expect(second.every((r) => r.attempts === 1)).toBe(true);

  expect(await assertAllWalletsMatchLedger(database.db)).toBe(12);
}, 60_000);
