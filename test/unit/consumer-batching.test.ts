// T038 — lote do consumidor (research R-22), com o fake-sqs e um processador de teste: mesmo MessageGroupId em
// sequência e na ordem; grupos diferentes em paralelo; o ack de cada mensagem só depois que o processador dela resolve.
import { describe, expect, test } from 'bun:test';
import { consumeBatch, type MessageAction, type MessageHandler } from '../../src/messaging/application/message-batch.ts';
import type { SqsMessage } from '../../src/messaging/application/sqs.port.ts';
import { FakeSqs } from '../support/fake-sqs.ts';

const QUEUE = 'transactions.fifo';
const RECEIVE = { max: 10, waitSeconds: 0, visibilitySeconds: 30 };

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Processador de teste: registra início/fim por corpo e espera a liberação de cada mensagem. */
function testHandler(sqs: FakeSqs) {
  const events: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const gate = (body: string) => {
    let g = gates.get(body);
    if (!g) {
      g = deferred();
      gates.set(body, g);
    }
    return g;
  };
  const handler: MessageHandler = {
    async process(message: SqsMessage): Promise<MessageAction> {
      events.push(`start:${message.body}`);
      await gate(message.body).promise;
      events.push(`end:${message.body}`);
      return { type: 'ack', outcome: 'processed', committed: true };
    },
    async apply(message: SqsMessage, action: MessageAction): Promise<void> {
      if (action.type === 'ack') {
        events.push(`ack:${message.body}`);
        await sqs.delete(QUEUE, message.receiptHandle);
      }
    },
  };
  return { events, release: (body: string) => gate(body).resolve(), handler };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('consumeBatch', () => {
  test('mesmo grupo: em sequência e na ordem; grupos diferentes: em paralelo', async () => {
    const sqs = new FakeSqs();
    for (const body of ['a1', 'a2', 'a3']) sqs.enqueue(QUEUE, { body, groupId: 'wallet-a' });
    sqs.enqueue(QUEUE, { body: 'b1', groupId: 'wallet-b' });
    const { events, release, handler } = testHandler(sqs);

    const running = consumeBatch(sqs, QUEUE, RECEIVE, handler);
    await tick();
    // a1 e b1 começaram juntos (grupos diferentes); a2 espera a1
    expect(events).toEqual(expect.arrayContaining(['start:a1', 'start:b1']));
    expect(events).not.toContain('start:a2');

    release('b1');
    await tick();
    expect(events).toContain('ack:b1');
    expect(events).not.toContain('start:a2');

    release('a1');
    await tick();
    expect(events).toContain('start:a2');
    release('a2');
    release('a3');
    expect(await running).toBe(4);

    const groupA = events.filter((e) => e.endsWith('a1') || e.endsWith('a2') || e.endsWith('a3'));
    expect(groupA).toEqual(['start:a1', 'end:a1', 'ack:a1', 'start:a2', 'end:a2', 'ack:a2', 'start:a3', 'end:a3', 'ack:a3']);
    expect(sqs.messages(QUEUE)).toEqual([]);
  });

  test('o ack só é chamado depois que o processador da mensagem resolve', async () => {
    const sqs = new FakeSqs();
    sqs.enqueue(QUEUE, { body: 'm1', groupId: 'g' });
    const { events, release, handler } = testHandler(sqs);
    const running = consumeBatch(sqs, QUEUE, RECEIVE, handler);
    await tick();
    expect(sqs.calls.filter((c) => c.op === 'delete')).toHaveLength(0);
    release('m1');
    await running;
    expect(events).toEqual(['start:m1', 'end:m1', 'ack:m1']);
    expect(sqs.calls.filter((c) => c.op === 'delete')).toHaveLength(1);
  });

  test('erro no processador de uma mensagem não apaga a mensagem nem para as outras do lote', async () => {
    const sqs = new FakeSqs();
    sqs.enqueue(QUEUE, { body: 'bad', groupId: 'g1' });
    sqs.enqueue(QUEUE, { body: 'good', groupId: 'g2' });
    const applied: string[] = [];
    const errors: unknown[] = [];
    const count = await consumeBatch(
      sqs,
      QUEUE,
      RECEIVE,
      {
        async process(message) {
          if (message.body === 'bad') throw new Error('boom');
          return { type: 'ack', outcome: 'processed', committed: true };
        },
        async apply(message, action) {
          applied.push(`${action.type}:${message.body}`);
          if (action.type === 'ack') await sqs.delete(QUEUE, message.receiptHandle);
        },
      },
      (error) => errors.push(error),
    );
    expect(count).toBe(2);
    expect(applied).toEqual(['ack:good']);
    expect(errors).toHaveLength(1);
    expect(sqs.messages(QUEUE).map((m) => m.body)).toEqual(['bad']);
  });

  test('lote vazio devolve 0', async () => {
    const sqs = new FakeSqs();
    const { handler } = testHandler(sqs);
    expect(await consumeBatch(sqs, QUEUE, RECEIVE, handler)).toBe(0);
  });
});
