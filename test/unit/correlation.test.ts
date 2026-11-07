// T012 — resolveCorrelationId (I-53, FR-060).
import { expect, test } from 'bun:test';
import { resolveCorrelationId } from '../../src/platform/correlation/request-context.ts';
import { SequentialIdGenerator } from '../support/fakes.ts';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.each(['abc-123', 'a', 'A.b_c:d-e', 'x'.repeat(128), '01a1b627-bdcb-7335-84ec-fafb960af2b9'])(
  'devolve o header válido "%s"',
  (header) => {
    expect(resolveCorrelationId(header, new SequentialIdGenerator())).toBe(header);
  },
);

test.each([
  ['ausente', undefined],
  ['vazio', ''],
  ['129 caracteres', 'x'.repeat(129)],
  ['com espaço', 'abc 123'],
  ['caractere fora do conjunto', 'abc/123'],
  ['acentuado', 'açaí'],
  ['array', ['a', 'b']],
  ['número', 42],
])('header %s → UUIDv7 gerado, sem lançar erro', (_label, header) => {
  const value = resolveCorrelationId(header as unknown, new SequentialIdGenerator());
  expect(value).toMatch(UUIDV7);
});
