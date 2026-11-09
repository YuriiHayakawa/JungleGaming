// Filas próprias por arquivo de teste (research R-31): criadas no beforeAll com prefixo único e o redrive, apagadas no
// afterAll. Nenhum PurgeQueue como limpeza. Mesmo isolamento do banco por arquivo (001, R-17).
import { afterAll, beforeAll } from 'bun:test';
import { provisionQueues } from '../../src/messaging/infrastructure/queue-provisioning.ts';
import { SQS_ENDPOINT, deleteQueue, testSqsClient } from './sqs-client.ts';

export interface TestQueues {
  readonly names: { transactions: string; dlq: string; events: string };
  readonly urls: { transactions: string; dlq: string; events: string };
  /** Variáveis para as instâncias (em processo ou filhas). */
  env(endpoint?: string): Record<string, string>;
}

export function useTestQueues(tag: string): TestQueues {
  const safe = tag.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24);
  const prefix = `jg-${safe}-${crypto.randomUUID().slice(0, 8)}-`;
  const names = {
    transactions: `${prefix}wager-transactions.fifo`,
    dlq: `${prefix}wager-transactions-dlq.fifo`,
    events: `${prefix}wager-events.fifo`,
  };
  let urls: TestQueues['urls'] | undefined;

  beforeAll(async () => {
    const provisioned = await provisionQueues(testSqsClient(), names);
    urls = { transactions: provisioned.transactionsUrl, dlq: provisioned.dlqUrl, events: provisioned.eventsUrl };
  });

  afterAll(async () => {
    if (!urls) return;
    for (const url of Object.values(urls)) await deleteQueue(url);
  });

  return {
    names,
    get urls() {
      if (!urls) throw new Error('test queues not ready (use inside tests or hooks)');
      return urls;
    },
    env(endpoint = SQS_ENDPOINT) {
      return {
        SQS_ENDPOINT: endpoint,
        SQS_TRANSACTIONS_QUEUE: names.transactions,
        SQS_TRANSACTIONS_DLQ: names.dlq,
        SQS_EVENTS_QUEUE: names.events,
      };
    },
  };
}
