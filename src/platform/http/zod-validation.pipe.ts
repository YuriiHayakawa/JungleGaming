import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ValidationError } from '../../shared-kernel/application/errors.ts';

/**
 * Pipe explícito por endpoint (`@Body(new ZodValidationPipe(schema))`), sem metadata de tipos (R-02, R-13).
 * Campos desconhecidos são descartados pelo próprio z.object (I-57).
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    throw new ValidationError('Request payload is invalid', { issues });
  }
}
