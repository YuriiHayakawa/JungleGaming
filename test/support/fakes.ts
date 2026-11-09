// Doubles determinísticos de teste (constitution VI). Não substituem banco nem fila em nenhum teste.
import type { Clock } from '../../src/shared-kernel/domain/clock.port.ts';
import type { IdGenerator } from '../../src/shared-kernel/domain/id-generator.port.ts';
import type { RandomSource } from '../../src/platform/random/random-source.port.ts';

/** Aleatoriedade fixa para o jitter (R-25): 0,5 não altera a espera nominal. */
export class FixedRandom implements RandomSource {
  constructor(private readonly value = 0.5) {
    if (!(value >= 0 && value < 1)) throw new Error('FixedRandom value must be in [0, 1)');
  }

  next(): number {
    return this.value;
  }
}

export class FixedClock implements Clock {
  private current: number;

  constructor(start: Date = new Date('2026-11-07T12:00:00.000Z')) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * UUIDv7 válidos e crescentes: timestamp fixo de 48 bits + contador nos bits aleatórios.
 * Formato: tttttttt-tttt-7ccc-8ccc-cccccccccccc (versão 7, variante 10xx).
 */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0n;

  constructor(private readonly timestampMs = 0x019a5c3e8000) {}

  next(): string {
    this.counter += 1n;
    const ts = this.timestampMs.toString(16).padStart(12, '0');
    const c = this.counter.toString(16).padStart(27, '0');
    // 3 dígitos após o "7", 3 após o "8", 12 no último grupo = 18 dígitos do contador
    const tail = c.slice(-18);
    return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`;
  }
}
