// T049 — envio à DLQ antes do delete (FR-040; I-68, I-70), com o fake-sqs (só em teste unitário). As mensagens daqui
// são permanentes já no envelope, então o processamento não chega ao banco.
import { describe, expect, test } from 'bun:test';
import { ConsumeWagerMessageUseCase } from '../../src/messaging/application/consume-wager-message.use-case.ts';
import { FakeSqs } from '../support/fake-sqs.ts';
import { EnvFailpoints } from '../../src/platform/failpoints/failpoints.ts';

const QUEUES = { transactions: 'tx.fifo', dlq: 'dlq.fifo' };
const CONSUMER = {
  name: 'wager-transactions-consumer',
  waitSeconds: 1,
  visibilityTimeoutSeconds: 30,
  retryBaseSeconds: 5,
  retryMaxSeconds: 60,
  shutdownTimeoutMs: 10_000,
};

function setup() {
  const sqs = new FakeSqs();
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const useCase = new ConsumeWagerMessageUseCase({
    // Dependências de banco não são usadas por mensagens recusadas no envelope.
    orm: undefined as never,
    submit: undefined as never,
    inbox: undefined as never,
    sqs,
    queues: QUEUES,
    consumer: CONSUMER,
    failpoints: new EnvFailpoints({ failpoint: undefined, nodeEnv: 'test' }),
    logger: {
      info: (msg, fields) => void logs.push({ msg, fields }),
      warn: (msg) => void logs.push({ msg: String(msg) }),
    },
  });
  return { sqs, useCase, logs };
}

const MALFORMED = 'not json';
const UNSUPPORTED = JSON.stringify({ messageId: 'msg-1', type: 'Other', occurredAt: '2026-11-08T12:00:00.000Z', data: {} });

async function handle(useCase: ConsumeWagerMessageUseCase, sqs: FakeSqs) {
  const [message] = await sqs.receive(QUEUES.transactions, { max: 1, waitSeconds: 0 });
  if (!message) throw new Error('no message');
  const action = await useCase.process(message);
  await useCase.apply(message, action);
  return message;
}

describe('mensagem permanente', () => {
  test('SendMessage à DLQ (corpo original, mesmo grupo, atributos) acontece antes do DeleteMessage', async () => {
    const { sqs, useCase } = setup();
    sqs.enqueue(QUEUES.transactions, { body: UNSUPPORTED, groupId: 'wallet-1' });
    await handle(useCase, sqs);

    const ops = sqs.calls.filter((c) => c.op !== 'receive').map((c) => `${c.op}:${c.queue}`);
    expect(ops).toEqual(['send:dlq.fifo', 'delete:tx.fifo']);
    const sent = sqs.calls.find((c) => c.op === 'send')?.options;
    expect(sent).toEqual({
      body: UNSUPPORTED,
      groupId: 'wallet-1',
      deduplicationId: 'msg-1',
      attributes: {
        errorCode: 'UNSUPPORTED_MESSAGE_TYPE',
        errorClass: 'permanent',
        receiveCount: '1',
        consumer: 'wager-transactions-consumer',
      },
    });
    expect(sqs.messages(QUEUES.transactions)).toEqual([]);
    expect(sqs.messages(QUEUES.dlq)).toHaveLength(1);
  });

  test('sem messageId válido, a deduplicação da DLQ usa o id do SQS', async () => {
    const { sqs, useCase } = setup();
    const sqsId = sqs.enqueue(QUEUES.transactions, { body: MALFORMED, groupId: 'g' });
    await handle(useCase, sqs);
    const sent = sqs.calls.find((c) => c.op === 'send')?.options;
    expect(sent?.deduplicationId).toBe(sqsId);
    expect(sent?.attributes?.errorCode).toBe('MALFORMED_MESSAGE');
  });

  test('se o envio à DLQ falhar, o delete não é chamado e a mensagem continua na fila', async () => {
    const { sqs, useCase } = setup();
    sqs.enqueue(QUEUES.transactions, { body: MALFORMED, groupId: 'g' });
    sqs.failNext('send', new Error('DLQ unavailable'));
    await expect(handle(useCase, sqs)).rejects.toThrow('DLQ unavailable');
    expect(sqs.calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    expect(sqs.messages(QUEUES.transactions)).toHaveLength(1);
    expect(sqs.messages(QUEUES.dlq)).toHaveLength(0);
  });
});
