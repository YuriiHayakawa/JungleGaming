import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { QueueCounts, ReceiveOptions, SendOptions, SqsMessage, SqsPort } from '../application/sqs.port.ts';

/**
 * Adapter da porta SQS com o @aws-sdk/client-sqs (research R-21). Junto com `sqs-client.factory.ts` e
 * `queue-provisioning.ts`, é o único lugar de `src/` que importa o SDK (R-33).
 *
 * A URL de cada fila é resolvida pelo nome uma vez e guardada. A resolução é feita no primeiro uso, não no boot da
 * app: uma instância só HTTP (papéis desligados) sobe e atende sem o SQS no ar (FR-033); uma falha na resolução não é
 * guardada e é repetida na próxima chamada (implementation-notes.md, T027).
 */
export class AwsSqsAdapter implements SqsPort {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly client: SQSClient) {}

  async receive(queue: string, options: ReceiveOptions): Promise<SqsMessage[]> {
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.urlOf(queue),
        MaxNumberOfMessages: options.max,
        WaitTimeSeconds: options.waitSeconds,
        ...(options.visibilitySeconds !== undefined ? { VisibilityTimeout: options.visibilitySeconds } : {}),
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      options.signal ? { abortSignal: options.signal } : {},
    );
    return (out.Messages ?? []).map((m) => {
      const attributes: Record<string, string> = {};
      for (const [key, value] of Object.entries(m.MessageAttributes ?? {})) {
        if (value.StringValue !== undefined) attributes[key] = value.StringValue;
      }
      return {
        sqsMessageId: m.MessageId ?? '',
        receiptHandle: m.ReceiptHandle ?? '',
        body: m.Body ?? '',
        receiveCount: Number.parseInt(m.Attributes?.ApproximateReceiveCount ?? '1', 10),
        groupId: m.Attributes?.MessageGroupId,
        attributes,
      };
    });
  }

  async delete(queue: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.urlOf(queue), ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.urlOf(queue),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async send(queue: string, options: SendOptions): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.urlOf(queue),
        MessageBody: options.body,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId,
        ...(options.attributes && Object.keys(options.attributes).length > 0
          ? {
              MessageAttributes: Object.fromEntries(
                Object.entries(options.attributes).map(([key, value]) => [key, { DataType: 'String', StringValue: value }]),
              ),
            }
          : {}),
      }),
    );
  }

  async approximateCounts(queue: string): Promise<QueueCounts> {
    const out = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.urlOf(queue),
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return {
      visible: Number.parseInt(out.Attributes?.ApproximateNumberOfMessages ?? '0', 10),
      notVisible: Number.parseInt(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10),
    };
  }

  private urlOf(queue: string): Promise<string> {
    const cached = this.urls.get(queue);
    if (cached) return cached;
    const resolving = this.client.send(new GetQueueUrlCommand({ QueueName: queue })).then((out) => {
      if (!out.QueueUrl) throw new Error(`queue ${queue} has no URL`);
      return out.QueueUrl;
    });
    this.urls.set(queue, resolving);
    // Falha não fica guardada: a próxima chamada tenta de novo (SQS fora no primeiro uso, FR-035).
    resolving.catch(() => this.urls.delete(queue));
    return resolving;
  }
}
