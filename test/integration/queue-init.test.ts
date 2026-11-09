// T014 — init idempotente das filas (plan, "Deploy local"; I-29, I-30), pelo script real contra o MiniStack do Compose.
import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SQS_ENDPOINT, deleteQueue, queueAttributes, queueExists, queueUrl } from '../support/sqs-client.ts';

const ROOT = join(import.meta.dir, '..', '..');
const prefix = `jg-qinit-${crypto.randomUUID().slice(0, 8)}-`;
const names = {
  dlq: `${prefix}wager-transactions-dlq.fifo`,
  transactions: `${prefix}wager-transactions.fifo`,
  events: `${prefix}wager-events.fifo`,
};

async function runQueueInit(endpoint: string) {
  const proc = Bun.spawn(['bun', join(ROOT, 'scripts', 'queue-init.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      SQS_ENDPOINT: endpoint,
      SQS_TRANSACTIONS_QUEUE: names.transactions,
      SQS_TRANSACTIONS_DLQ: names.dlq,
      SQS_EVENTS_QUEUE: names.events,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterAll(async () => {
  for (const name of Object.values(names)) {
    if (await queueExists(name)) await deleteQueue(await queueUrl(name));
  }
});

test('cria a DLQ, a fila de transações com redrive (maxReceiveCount 5) e a de eventos, todas FIFO', async () => {
  const result = await runQueueInit(SQS_ENDPOINT);
  expect(result.code, result.stderr).toBe(0);

  const dlq = await queueAttributes(await queueUrl(names.dlq));
  const transactions = await queueAttributes(await queueUrl(names.transactions));
  const events = await queueAttributes(await queueUrl(names.events));
  for (const attrs of [dlq, transactions, events]) {
    expect(attrs.FifoQueue).toBe('true');
    expect(attrs.ContentBasedDeduplication).toBe('false');
  }
  const redrive = JSON.parse(transactions.RedrivePolicy ?? '{}') as { deadLetterTargetArn?: string; maxReceiveCount?: unknown };
  expect(redrive.deadLetterTargetArn).toBe(dlq.QueueArn);
  expect(String(redrive.maxReceiveCount)).toBe('5');
  expect(dlq.RedrivePolicy).toBeUndefined();
  expect(events.RedrivePolicy).toBeUndefined();
}, 30_000);

test('rodar de novo termina com 0, sem erro nem fila duplicada', async () => {
  const before = await queueUrl(names.transactions);
  const again = await runQueueInit(SQS_ENDPOINT);
  expect(again.code, again.stderr).toBe(0);
  expect(await queueUrl(names.transactions)).toBe(before);
  const transactions = await queueAttributes(before);
  expect(String((JSON.parse(transactions.RedrivePolicy ?? '{}') as { maxReceiveCount?: unknown }).maxReceiveCount)).toBe('5');
}, 30_000);

test('com SQS_ENDPOINT inválido termina com código diferente de 0', async () => {
  const result = await runQueueInit('http://127.0.0.1:1');
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('queue-init.failed');
}, 30_000);
