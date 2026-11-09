// T078 — término gracioso com SIGTERM real em container Linux (FR-014; I-34; SC-007; R-30, R-35), com a app como PID 1
// (`app-test`) e atrás do init do Docker (`app-test-init`), consumidor ligado. Uma mensagem fica em andamento, presa no
// lock da wallet segurado por fora (FOR UPDATE real); o SIGTERM chega; o lock é solto depois. A instância conclui a
// mensagem, confirma (ack depois do commit) e sai com 0; a mensagem é processada uma única vez. PostgreSQL e MiniStack
// reais.
// T023 da 003 (FR-016; SC-006; R-40 e o requisito E-1): antes do SIGTERM o ready, lido de dentro do container, é 200;
// depois do SIGTERM e antes de soltar o lock (a drenagem está esperando a mensagem), ele é 503 com as dependências up e o
// live continua 200. O resto do teste não muda.
import { afterAll, describe, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import {
  containerDatabaseUrl,
  startContainerInstance,
  type ContainerInstance,
  type ContainerService,
} from '../support/container-instance.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('graceful_sigterm');
const queues = useTestQueues('graceful-sigterm');
const SHUTDOWN_TIMEOUT_MS = 10_000;
const containers: ContainerInstance[] = [];
let setup: RunningApp | undefined;

afterAll(async () => {
  for (const container of containers) await container.remove();
  await setup?.close();
});

function parseLines(logs: string): Array<Record<string, unknown>> {
  return logs
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

describe.each(['app-test', 'app-test-init'] as ContainerService[])('%s', (service) => {
  test(
    'SIGTERM com uma mensagem em andamento: conclui, confirma e sai com 0; a mensagem é processada uma vez',
    async () => {
      setup ??= await startApp({ databaseUrl: database.url });
      const wallet = await openWallet(fetcherFor(setup.baseUrl), '100.00');
      const envelope = wagerEnvelope(wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), {
        messageId: newMessageId(`sigterm-${service}`),
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
      try {
        await sendEnvelope(queues.urls.transactions, envelope);
        const instance = await startContainerInstance({
          service,
          env: {
            DATABASE_URL: containerDatabaseUrl(database.url),
            NODE_ENV: 'test',
            CONSUMER_ENABLED: 'true',
            CONSUMER_WAIT_SECONDS: '1',
            CONSUMER_SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
            WALLET_LOCK_TIMEOUT_MS: '5000',
            DB_POOL_ACQUIRE_TIMEOUT_MS: '6000',
            HTTP_SERVER_TIMEOUT_MS: '15000',
            ...queues.env('http://sqs:4566'),
          },
        });
        containers.push(instance);
        // Recebida e presa no lock da wallet.
        await waitFor(async () => (await counts(queues.urls.transactions)).notVisible === 1, 30_000, 100);
        await Bun.sleep(300);

        const READY_UP = { status: 'ok', checks: { postgres: 'up', sqs: 'up' } };
        const before = await instance.fetchInside('/health/ready');
        expect(before.status).toBe(200);
        expect(JSON.parse(before.body)).toEqual(READY_UP);

        const sentAt = performance.now();
        await instance.kill('SIGTERM');
        // Durante a drenagem (a mensagem continua presa no lock): ready 503 com o estado real, live 200.
        const draining = await instance.fetchInside('/health/ready');
        expect(draining.status).toBe(503);
        expect(JSON.parse(draining.body)).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'up' } });
        expect((await instance.fetchInside('/health/live')).status).toBe(200);
        expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(0);
        await release();
        const code = await instance.wait(SHUTDOWN_TIMEOUT_MS + 15_000);
        const elapsed = performance.now() - sentAt;

        const lines = parseLines(await instance.logs());
        const events = lines.map((l) => l.event ?? l.msg);
        expect(code).toBe(0);
        expect(elapsed).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 5_000);
        const processed = lines.filter((l) => l.msg === 'consumer.message' && l.messageId === envelope.messageId);
        expect(processed).toHaveLength(1);
        expect(processed[0]!.outcome).toBe('processed');
        // A mensagem terminou (commit + ack) antes da drenagem e do fechamento do ORM.
        expect(events.indexOf('shutdown.started')).toBeLessThan(events.indexOf('consumer.message'));
        expect(events.indexOf('consumer.message')).toBeLessThan(events.indexOf('shutdown.workers_drained'));
        expect(events.indexOf('shutdown.workers_drained')).toBeLessThan(events.indexOf('shutdown.orm_closed'));
        expect(lines.find((l) => l.msg === 'shutdown.workers_drained')!.drained).toBe(true);
        expect(events).not.toContain('consumer.message_returned');
        expect(events).not.toContain('shutdown.timeout');

        // Uma única vez: uma transação, uma linha de inbox, fila vazia (o ack aconteceu).
        expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [envelope.messageId])).toHaveLength(1);
        expect(await database.db.query("SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'", [wallet.id])).toHaveLength(1);
        expect(await counts(queues.urls.transactions)).toEqual({ visible: 0, notVisible: 0 });
        await assertWalletMatchesLedger(database.db, wallet.id);
      } finally {
        await release();
      }
    },
    240_000,
  );
});
