// T010 — OutboxMessage (enunciado §6.5, data-model §1).
import { expect, test } from 'bun:test';
import { OutboxMessage } from '../../src/outbox/domain/outbox-message.ts';
import { IntegrationEvent, type IntegrationEventProps } from '../../src/shared-kernel/domain/integration-event.ts';

class SampleEvent extends IntegrationEvent<{ walletId: string }> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static create(props: IntegrationEventProps<{ walletId: string }>): SampleEvent {
    return new SampleEvent(props);
  }
}

const occurredAt = new Date('2026-11-07T12:00:00.000Z');
const event = SampleEvent.create({
  eventId: '01a1b627-bdcb-7335-84ec-fafb960af2b9',
  aggregateId: 'wallet-1',
  correlationId: 'corr-1',
  occurredAt,
  data: { walletId: 'wallet-1' },
});

test('enqueue: id = eventId, payload = toJSON, attempts 0, nextAttemptAt = occurredAt, pendente', () => {
  const msg = OutboxMessage.enqueue(event);
  expect(msg.id).toBe(event.eventId);
  expect(msg.aggregateId).toBe('wallet-1');
  expect(msg.eventType).toBe('WalletBalanceChanged');
  expect(msg.eventVersion).toBe(1);
  expect(msg.correlationId).toBe('corr-1');
  expect(msg.payload).toEqual({ ...event.toJSON() });
  expect(msg.occurredAt).toEqual(occurredAt);
  expect(msg.attempts).toBe(0);
  expect(msg.nextAttemptAt).toEqual(occurredAt);
  expect(msg.publishedAt).toBeUndefined();
  expect(msg.isPending()).toBe(true);
});

test('isDue(now) só quando pendente e nextAttemptAt <= now', () => {
  const msg = OutboxMessage.enqueue(event);
  expect(msg.isDue(new Date(occurredAt.getTime() - 1))).toBe(false);
  expect(msg.isDue(occurredAt)).toBe(true);
  msg.markPublished(new Date(occurredAt.getTime() + 10));
  expect(msg.isDue(new Date(occurredAt.getTime() + 1000))).toBe(false);
});

test('markPublished define publishedAt e deixa de estar pendente; não pode publicar duas vezes', () => {
  const msg = OutboxMessage.enqueue(event);
  const at = new Date('2026-11-07T12:00:05.000Z');
  msg.markPublished(at);
  expect(msg.publishedAt).toEqual(at);
  expect(msg.isPending()).toBe(false);
  expect(() => msg.markPublished(at)).toThrow();
});

test('scheduleRetry incrementa attempts e empurra nextAttemptAt com backoff crescente', () => {
  const msg = OutboxMessage.enqueue(event);
  const now = new Date('2026-11-07T12:01:00.000Z');
  msg.scheduleRetry(now);
  expect(msg.attempts).toBe(1);
  const first = msg.nextAttemptAt.getTime() - now.getTime();
  msg.scheduleRetry(now);
  expect(msg.attempts).toBe(2);
  const second = msg.nextAttemptAt.getTime() - now.getTime();
  expect(first).toBeGreaterThan(0);
  expect(second).toBeGreaterThan(first);
});

test('rehydrate reconstrói o estado persistido', () => {
  const state = {
    id: 'id-1',
    aggregateId: 'wallet-1',
    eventType: 'WalletBalanceChanged',
    eventVersion: 1,
    payload: { a: 1 },
    correlationId: 'c',
    occurredAt,
    attempts: 3,
    nextAttemptAt: new Date('2026-11-07T13:00:00.000Z'),
    publishedAt: undefined,
  };
  const msg = OutboxMessage.rehydrate(state);
  expect(msg.attempts).toBe(3);
  expect(msg.nextAttemptAt).toEqual(state.nextAttemptAt);
  expect(msg.isPending()).toBe(true);
});
