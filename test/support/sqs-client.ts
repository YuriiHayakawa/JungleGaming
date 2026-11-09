// Acesso direto ao SQS real (MiniStack do Compose) para semear e inspecionar filas nos testes (research R-31).
// Nada de fake: usa o @aws-sdk/client-sqs contra o emulador. Permitido só em test/support (tasks, "Convenções").
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
  type QueueAttributeName,
} from '@aws-sdk/client-sqs';

export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export function testSqsClient(endpoint = SQS_ENDPOINT): SQSClient {
  return new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
}

const client = testSqsClient();

export interface ReceivedMessage {
  messageId: string;
  body: string;
  receiptHandle: string;
  receiveCount: number;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  attributes: Record<string, string>;
}

function toReceived(m: Message): ReceivedMessage {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(m.MessageAttributes ?? {})) {
    if (value.StringValue !== undefined) attributes[key] = value.StringValue;
  }
  return {
    messageId: m.MessageId ?? '',
    body: m.Body ?? '',
    receiptHandle: m.ReceiptHandle ?? '',
    receiveCount: Number.parseInt(m.Attributes?.ApproximateReceiveCount ?? '0', 10),
    groupId: m.Attributes?.MessageGroupId,
    deduplicationId: m.Attributes?.MessageDeduplicationId,
    attributes,
  };
}

export async function queueUrl(name: string): Promise<string> {
  const out = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!out.QueueUrl) throw new Error(`queue ${name} not found`);
  return out.QueueUrl;
}

export async function queueExists(name: string): Promise<boolean> {
  return queueUrl(name).then(
    () => true,
    () => false,
  );
}

export async function queueAttributes(url: string, names: QueueAttributeName[] = ['All']): Promise<Record<string, string>> {
  const out = await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }));
  return out.Attributes ?? {};
}

/** Envia um corpo (envelope ou texto qualquer) com grupo e deduplicação explícitos. */
export async function sendRaw(
  url: string,
  body: string,
  options: { groupId: string; deduplicationId: string; attributes?: Record<string, string> },
): Promise<string> {
  const out = await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId,
      ...(options.attributes
        ? {
            MessageAttributes: Object.fromEntries(
              Object.entries(options.attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
            ),
          }
        : {}),
    }),
  );
  return out.MessageId ?? '';
}

/** Recebe sem apagar (a mensagem volta a ficar visível depois da visibilidade). */
export async function receive(
  url: string,
  options: { max?: number; waitSeconds?: number; visibilitySeconds?: number } = {},
): Promise<ReceivedMessage[]> {
  const out = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: options.max ?? 10,
      WaitTimeSeconds: options.waitSeconds ?? 0,
      ...(options.visibilitySeconds !== undefined ? { VisibilityTimeout: options.visibilitySeconds } : {}),
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId', 'MessageDeduplicationId'],
      MessageAttributeNames: ['All'],
    }),
  );
  return (out.Messages ?? []).map(toReceived);
}

/**
 * Recebe e apaga tudo o que chegar até `quietMs` sem mensagem nova (ou `timeoutMs` no total). Usado para ler a fila de
 * eventos e a DLQ, que só os testes consomem.
 */
export async function drainQueue(url: string, options: { quietMs?: number; timeoutMs?: number } = {}): Promise<ReceivedMessage[]> {
  const quietMs = options.quietMs ?? 1500;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const all: ReceivedMessage[] = [];
  let lastSeen = Date.now();
  while (Date.now() < deadline && Date.now() - lastSeen < quietMs) {
    const batch = await receive(url, { max: 10, waitSeconds: 1 });
    for (const message of batch) {
      all.push(message);
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.receiptHandle }));
    }
    if (batch.length > 0) lastSeen = Date.now();
  }
  return all;
}

/** Espera até `predicate(acumulado)` ser verdadeiro, recebendo e apagando da fila; devolve tudo o que leu. */
export async function collectUntil(
  url: string,
  predicate: (messages: ReceivedMessage[]) => boolean,
  timeoutMs = 30_000,
): Promise<ReceivedMessage[]> {
  const deadline = Date.now() + timeoutMs;
  const all: ReceivedMessage[] = [];
  while (!predicate(all)) {
    if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs} ms; got ${all.length} messages`);
    const batch = await receive(url, { max: 10, waitSeconds: 1 });
    for (const message of batch) {
      all.push(message);
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.receiptHandle }));
    }
  }
  return all;
}

export interface QueueCounts {
  visible: number;
  notVisible: number;
}

export async function counts(url: string): Promise<QueueCounts> {
  const attrs = await queueAttributes(url, ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']);
  return {
    visible: Number.parseInt(attrs.ApproximateNumberOfMessages ?? '0', 10),
    notVisible: Number.parseInt(attrs.ApproximateNumberOfMessagesNotVisible ?? '0', 10),
  };
}

/** Espera a fila ficar sem mensagens visíveis nem em voo. */
export async function waitForEmpty(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await counts(url);
    if (c.visible === 0 && c.notVisible === 0) return;
    if (Date.now() > deadline) throw new Error(`queue not empty after ${timeoutMs} ms: ${JSON.stringify(c)}`);
    await Bun.sleep(100);
  }
}

export async function deleteQueue(url: string): Promise<void> {
  await client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
}

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs} ms`);
    await Bun.sleep(stepMs);
  }
}
