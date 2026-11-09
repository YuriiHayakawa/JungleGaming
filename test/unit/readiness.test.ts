// T020 — agregação do ready e checagem com prazo (R-39; FR-014 a FR-016; I-75), com temporizador de teste.
import { describe, expect, test } from 'bun:test';
import {
  HEALTH_CHECK_TIMEOUT_MS,
  readinessOf,
  withTimeout,
  type DependencyState,
  type HealthTimers,
} from '../../src/health/application/readiness.ts';

describe('readinessOf', () => {
  const states: DependencyState[] = ['up', 'down'];
  for (const postgres of states) {
    for (const sqs of states) {
      for (const draining of [false, true]) {
        const ok = postgres === 'up' && sqs === 'up' && !draining;
        test(`postgres ${postgres}, sqs ${sqs}, draining ${draining} → ${ok ? 200 : 503}`, () => {
          const result = readinessOf({ postgres, sqs }, draining);
          expect(result.httpStatus).toBe(ok ? 200 : 503);
          expect(result.body).toEqual({ status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } });
        });
      }
    }
  }

  test('o corpo traz exatamente status e checks, na ordem do contrato', () => {
    expect(JSON.stringify(readinessOf({ postgres: 'up', sqs: 'up' }, false).body)).toBe(
      '{"status":"ok","checks":{"postgres":"up","sqs":"up"}}',
    );
  });
});

/** Temporizador manual: nada dispara sozinho; o teste avança. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const timers: HealthTimers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
  };
  return {
    timers,
    pending,
    fire() {
      for (const [id, timer] of [...pending]) {
        pending.delete(id);
        timer.fn();
      }
    },
  };
}

describe('withTimeout', () => {
  test('o prazo padrão é 2 s (I-75)', () => {
    expect(HEALTH_CHECK_TIMEOUT_MS).toBe(2000);
  });

  test('checagem que termina no prazo → up, e o temporizador é cancelado', async () => {
    const clock = manualTimers();
    expect(await withTimeout(async () => {}, 2000, clock.timers)).toBe('up');
    expect(clock.pending.size).toBe(0);
  });

  test('checagem que falha → down, sem temporizador pendente', async () => {
    const clock = manualTimers();
    expect(await withTimeout(async () => Promise.reject(new Error('ECONNREFUSED')), 2000, clock.timers)).toBe('down');
    expect(clock.pending.size).toBe(0);
  });

  test('checagem que não termina → down quando o prazo vence, com o prazo pedido', async () => {
    const clock = manualTimers();
    const result = withTimeout(() => new Promise<void>(() => {}), 2000, clock.timers);
    await Bun.sleep(0);
    expect([...clock.pending.values()].map((t) => t.ms)).toEqual([2000]);
    clock.fire();
    expect(await result).toBe('down');
    expect(clock.pending.size).toBe(0);
  });

  test('checagem que lança de forma síncrona → down', async () => {
    const clock = manualTimers();
    const check = (): Promise<void> => {
      throw new Error('boom');
    };
    expect(await withTimeout(check, 2000, clock.timers)).toBe('down');
    expect(clock.pending.size).toBe(0);
  });

  test('com o temporizador real, desiste perto do prazo e não fica preso', async () => {
    const started = performance.now();
    expect(await withTimeout(() => new Promise<void>(() => {}), 50)).toBe('down');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1000);
  });
});
