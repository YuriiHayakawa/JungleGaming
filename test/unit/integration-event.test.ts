// T009 — envelope IntegrationEvent (enunciado §11, FR-047).
import { expect, test } from 'bun:test';
import { IntegrationEvent, type IntegrationEventProps } from '../../src/shared-kernel/domain/integration-event.ts';
import type { MoneyProps } from '../../src/shared-kernel/domain/money.ts';

interface SampleData {
  walletId: string;
  money: MoneyProps;
}

class SampleEvent extends IntegrationEvent<SampleData> {
  readonly eventType = 'SampleEvent';
  readonly version = 1;

  static create(props: IntegrationEventProps<SampleData>): SampleEvent {
    return new SampleEvent(props);
  }
}

const occurredAt = new Date('2026-11-07T12:00:00.000Z');

test('toJSON serializa o envelope com occurredAt ISO-8601, eventType e version do tipo', () => {
  const event = SampleEvent.create({
    eventId: '01a1b627-bdcb-7335-84ec-fafb960af2b9',
    aggregateId: 'wallet-1',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    occurredAt,
    data: { walletId: 'wallet-1', money: { amount: '25.00', currency: 'BRL' } },
  });
  expect(event.toJSON()).toEqual({
    eventId: '01a1b627-bdcb-7335-84ec-fafb960af2b9',
    eventType: 'SampleEvent',
    aggregateId: 'wallet-1',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    occurredAt: '2026-11-07T12:00:00.000Z',
    version: 1,
    data: { walletId: 'wallet-1', money: { amount: '25.00', currency: 'BRL' } },
  });
});

test('causationId ausente não aparece no JSON', () => {
  const json = SampleEvent.create({
    eventId: 'e',
    aggregateId: 'a',
    correlationId: 'c',
    occurredAt,
    data: { walletId: 'a', money: { amount: '1.00', currency: 'BRL' } },
  }).toJSON();
  expect('causationId' in json).toBe(false);
});

test('data é somente leitura e o JSON é estável (stringify ida e volta)', () => {
  const event = SampleEvent.create({
    eventId: 'e',
    aggregateId: 'a',
    correlationId: 'c',
    occurredAt,
    data: { walletId: 'a', money: { amount: '1.00', currency: 'BRL' } },
  });
  expect(Object.isFrozen(event.data)).toBe(true);
  expect(JSON.parse(JSON.stringify(event.toJSON()))).toEqual(event.toJSON());
});
