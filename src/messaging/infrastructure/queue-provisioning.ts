import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export interface QueueNames {
  transactions: string;
  dlq: string;
  events: string;
}

export interface ProvisionedQueues {
  transactionsUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

/** Redrive da fila de transações para a DLQ depois de 5 recebimentos (I-30). */
export const MAX_RECEIVE_COUNT = 5;

const FIFO_ATTRIBUTES = { FifoQueue: 'true', ContentBasedDeduplication: 'false' } as const;

function isAlreadyExists(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'QueueAlreadyExists' || name === 'QueueNameExists';
}

/**
 * Cria a fila com os atributos pedidos ou, se ela já existe, reaplica os atributos que divergem (`FifoQueue` não pode
 * mudar depois da criação e não é reaplicado). Idempotente: rodar de novo não falha nem duplica (plan, "Deploy local").
 */
async function ensureQueue(client: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  let url: string | undefined;
  try {
    url = (await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }))).QueueUrl;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    url = (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;
  }
  if (!url) throw new Error(`queue ${name} has no URL`);

  const current: Record<string, string | undefined> =
    (await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }))).Attributes ?? {};
  const divergent: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'FifoQueue') continue;
    if (!sameAttribute(key, current[key], value)) divergent[key] = value;
  }
  if (Object.keys(divergent).length > 0) {
    await client.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: divergent }));
  }
  return url;
}

/** RedrivePolicy é JSON e o SQS pode devolver `maxReceiveCount` como número ou string. */
function sameAttribute(key: string, current: string | undefined, wanted: string): boolean {
  if (current === undefined) return false;
  if (key !== 'RedrivePolicy') return current === wanted;
  try {
    const a = JSON.parse(current) as { deadLetterTargetArn?: string; maxReceiveCount?: unknown };
    const b = JSON.parse(wanted) as { deadLetterTargetArn?: string; maxReceiveCount?: unknown };
    return a.deadLetterTargetArn === b.deadLetterTargetArn && String(a.maxReceiveCount) === String(b.maxReceiveCount);
  } catch {
    return false;
  }
}

/**
 * Provisiona as três filas FIFO (I-29, I-30; contracts/queues.md): a DLQ primeiro, a de transações com
 * `RedrivePolicy` para ela (`maxReceiveCount` 5) e a de eventos. Usada pelo `scripts/queue-init.ts` (Compose) e pelas
 * filas por arquivo de teste (R-31).
 */
export async function provisionQueues(client: SQSClient, names: QueueNames): Promise<ProvisionedQueues> {
  const dlqUrl = await ensureQueue(client, names.dlq, { ...FIFO_ATTRIBUTES });
  const dlqArn = (await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))).Attributes
    ?.QueueArn;
  if (!dlqArn) throw new Error(`queue ${names.dlq} has no ARN`);
  const transactionsUrl = await ensureQueue(client, names.transactions, {
    ...FIFO_ATTRIBUTES,
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: MAX_RECEIVE_COUNT }),
  });
  const eventsUrl = await ensureQueue(client, names.events, { ...FIFO_ATTRIBUTES });
  return { transactionsUrl, dlqUrl, eventsUrl };
}
