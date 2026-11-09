// T035 — SIGTERM real em container Linux (FR-014, I-34, R-30, R-35; spike S-12.8): com a app como PID 1 (`app-test`)
// e atrás do init do Docker (`app-test-init`), o handler próprio de sinal drena o WorkerRegistry, fecha o ORM e sai
// com 0 dentro do prazo; um segundo SIGTERM durante o encerramento não muda o resultado. A drenagem de mensagem em
// andamento entra no T078 (US5).
import { afterAll, describe, expect, test } from 'bun:test';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import {
  containerDatabaseUrl,
  startContainerInstance,
  type ContainerInstance,
  type ContainerService,
} from '../support/container-instance.ts';

const database = useTestDatabase('signal_exit');
const queues = useTestQueues('signal-exit');
const SHUTDOWN_TIMEOUT_MS = 10_000;
const started: ContainerInstance[] = [];

afterAll(async () => {
  for (const instance of started) await instance.remove();
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
    'SIGTERM → drain do WorkerRegistry, fechamento do ORM e saída 0 dentro do prazo; o 2º SIGTERM é ignorado',
    async () => {
      const instance = await startContainerInstance({
        service,
        env: {
          DATABASE_URL: containerDatabaseUrl(database.url),
          NODE_ENV: 'test',
          CONSUMER_SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
          ...queues.env('http://sqs:4566'),
        },
      });
      started.push(instance);

      const sentAt = performance.now();
      await instance.kill('SIGTERM');
      await instance.kill('SIGTERM').catch(() => {}); // pode chegar com o processo já saindo
      const code = await instance.wait(SHUTDOWN_TIMEOUT_MS + 15_000);
      const elapsed = performance.now() - sentAt;

      const lines = parseLines(await instance.logs());
      const events = lines.map((l) => l.event ?? l.msg);
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 5_000);
      expect(events).toContain('shutdown.started');
      expect(events).toContain('shutdown.workers_drained');
      expect(events).toContain('shutdown.orm_closed');
      expect(events).toContain('shutdown.completed');
      expect(events.indexOf('shutdown.workers_drained')).toBeLessThan(events.indexOf('shutdown.orm_closed'));
      expect(events.filter((e) => e === 'shutdown.started')).toHaveLength(1);
      expect(events).not.toContain('shutdown.timeout');
    },
    240_000,
  );
});
