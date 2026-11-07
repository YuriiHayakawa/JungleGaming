// T017 — pipe Zod explícito (research R-13, I-57).
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { ZodValidationPipe } from '../../src/platform/http/zod-validation.pipe.ts';
import { ValidationError } from '../../src/shared-kernel/application/errors.ts';

const schema = z.object({ name: z.string().min(1), nested: z.object({ value: z.string() }) });

test('devolve o valor parseado e descarta campos desconhecidos (I-57)', () => {
  const pipe = new ZodValidationPipe(schema);
  const out = pipe.transform({ name: 'a', nested: { value: 'b', extra: 1 }, unknown: true });
  expect(out).toEqual({ name: 'a', nested: { value: 'b' } });
});

test('campo conhecido inválido lança VALIDATION_ERROR com details.issues (path e message)', () => {
  const pipe = new ZodValidationPipe(schema);
  let error: unknown;
  try {
    pipe.transform({ name: '', nested: { value: 1 } });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ValidationError);
  const details = (error as ValidationError).details as { issues: { path: string; message: string }[] };
  expect(details.issues.map((i) => i.path).sort()).toEqual(['name', 'nested.value']);
  for (const issue of details.issues) expect(typeof issue.message).toBe('string');
});

test('corpo ausente é inválido', () => {
  expect(() => new ZodValidationPipe(schema).transform(undefined)).toThrow(ValidationError);
});
