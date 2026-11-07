// T020 — formato UUIDv7 do gerador real e do double de teste (I-35, I-58).
import { expect, test } from 'bun:test';
import { UuidV7IdGenerator } from '../../src/shared-kernel/infrastructure/uuidv7-id-generator.ts';
import { SystemClock } from '../../src/shared-kernel/infrastructure/system-clock.ts';
import { FixedClock, SequentialIdGenerator } from '../support/fakes.ts';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.each([
  ['UuidV7IdGenerator', () => new UuidV7IdGenerator()],
  ['SequentialIdGenerator', () => new SequentialIdGenerator()],
])('%s gera UUIDv7 em minúsculas, distintos e crescentes', (_name, make) => {
  const gen = make();
  const ids = Array.from({ length: 200 }, () => gen.next());
  for (const id of ids) expect(id).toMatch(UUIDV7);
  expect(new Set(ids).size).toBe(ids.length);
  const sorted = [...ids].sort();
  expect(ids).toEqual(sorted);
});

test('SequentialIdGenerator é determinístico', () => {
  const a = new SequentialIdGenerator();
  const b = new SequentialIdGenerator();
  expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
});

test('FixedClock devolve sempre o instante fixado e avança só quando pedido; SystemClock devolve Date', () => {
  const clock = new FixedClock(new Date('2026-11-07T12:00:00.000Z'));
  expect(clock.now().toISOString()).toBe('2026-11-07T12:00:00.000Z');
  clock.advance(5000);
  expect(clock.now().toISOString()).toBe('2026-11-07T12:00:05.000Z');
  expect(new SystemClock().now()).toBeInstanceOf(Date);
});
