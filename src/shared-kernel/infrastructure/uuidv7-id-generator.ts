import type { IdGenerator } from '../domain/id-generator.port.ts';

/** UUIDv7 em minúsculas (I-35, I-58). */
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
