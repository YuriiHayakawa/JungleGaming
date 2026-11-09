// T006 — InboxMessage (enunciado §6.5; data-model §1; I-28, I-69).
import { describe, expect, test } from 'bun:test';
import { InboxMessage, InvalidInboxMessageError } from '../../src/inbox/domain/inbox-message.ts';
import { InvalidTransactionStateError } from '../../src/shared-kernel/domain/errors.ts';

const HASH = 'ab'.repeat(32);
const TX = '0192f291-27dd-7d3f-8071-5f8685deef37';
const at = new Date('2026-11-08T12:00:00.000Z');

const props = (overrides: Partial<Parameters<typeof InboxMessage.receive>[0]> = {}) => ({
  messageId: 'msg-123',
  consumerName: 'wager-transactions-consumer',
  payloadHash: HASH,
  transactionId: TX,
  receivedAt: at,
  ...overrides,
});

describe('receive', () => {
  test('aceita os formatos válidos e nasce não processada', () => {
    const inbox = InboxMessage.receive(props());
    expect(inbox.messageId).toBe('msg-123');
    expect(inbox.consumerName).toBe('wager-transactions-consumer');
    expect(inbox.payloadHash).toBe(HASH);
    expect(inbox.transactionId).toBe(TX);
    expect(inbox.receivedAt).toEqual(at);
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
  });

  test.each(['a', 'A.b_c:d-e', 'x'.repeat(128), 'msg:2026-11-08T12:00:00.000Z'])('messageId válido "%s"', (messageId) => {
    expect(InboxMessage.receive(props({ messageId })).messageId).toBe(messageId);
  });

  test.each(['', 'x'.repeat(129), 'msg 1', 'msg/1', 'msg#1', 'mensagém'])('messageId inválido "%s"', (messageId) => {
    expect(() => InboxMessage.receive(props({ messageId }))).toThrow(InvalidInboxMessageError);
  });

  test.each(['', 'x'.repeat(65)])('consumerName inválido (%#)', (consumerName) => {
    expect(() => InboxMessage.receive(props({ consumerName }))).toThrow(InvalidInboxMessageError);
  });

  test('consumerName de 1 e de 64 caracteres', () => {
    expect(InboxMessage.receive(props({ consumerName: 'c' })).consumerName).toBe('c');
    expect(InboxMessage.receive(props({ consumerName: 'c'.repeat(64) })).consumerName).toBe('c'.repeat(64));
  });

  test.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])('payloadHash inválido (%#)', (payloadHash) => {
    expect(() => InboxMessage.receive(props({ payloadHash }))).toThrow(InvalidInboxMessageError);
  });

  test.each(['', 'not-a-uuid', '0192f291-27dd-7d3f-8071-5f8685deef3', '0192f291x27dd-7d3f-8071-5f8685deef37'])(
    'transactionId inválido "%s"',
    (transactionId) => {
      expect(() => InboxMessage.receive(props({ transactionId }))).toThrow(InvalidInboxMessageError);
    },
  );
});

describe('markProcessed, isProcessed e matchesPayload', () => {
  test('markProcessed uma vez só', () => {
    const inbox = InboxMessage.receive(props());
    const processedAt = new Date(at.getTime() + 10);
    inbox.markProcessed(processedAt);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(processedAt);
    expect(() => inbox.markProcessed(processedAt)).toThrow(InvalidTransactionStateError);
  });

  test('markProcessed antes do recebimento é recusado (inbox_processed_after_ck)', () => {
    const inbox = InboxMessage.receive(props());
    expect(() => inbox.markProcessed(new Date(at.getTime() - 1))).toThrow(InvalidInboxMessageError);
  });

  test('matchesPayload compara o hash', () => {
    const inbox = InboxMessage.receive(props());
    expect(inbox.matchesPayload(HASH)).toBe(true);
    expect(inbox.matchesPayload('cd'.repeat(32))).toBe(false);
  });
});

describe('rehydrate', () => {
  test('reconstrói sem revalidar', () => {
    const inbox = InboxMessage.rehydrate({
      messageId: 'legacy id with spaces',
      consumerName: 'wager-transactions-consumer',
      payloadHash: HASH,
      transactionId: TX,
      receivedAt: at,
      processedAt: at,
    });
    expect(inbox.messageId).toBe('legacy id with spaces');
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(at)).toThrow(InvalidTransactionStateError);
  });

  test('copia as datas (o chamador não altera o estado depois)', () => {
    const received = new Date(at);
    const inbox = InboxMessage.rehydrate({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: HASH,
      transactionId: TX,
      receivedAt: received,
      processedAt: undefined,
    });
    received.setTime(0);
    expect(inbox.receivedAt).toEqual(at);
  });
});
