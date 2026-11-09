// T011 — PollingLoop e WorkerRegistry (FR-014, FR-015, FR-033, R-28), com iterações de teste, sem banco nem fila.
import { describe, expect, test } from 'bun:test';
import { PollingLoop } from '../../src/platform/workers/polling-loop.ts';
import { WorkerRegistry } from '../../src/platform/workers/worker-registry.ts';
import { ServiceUnavailableError } from '../../src/shared-kernel/application/errors.ts';

/** Sono de teste: registra a espera e volta na hora (ou quando o sinal aborta). */
function recordingSleep() {
  const waits: number[] = [];
  const sleep = async (ms: number, _signal: AbortSignal) => {
    waits.push(ms);
    await Promise.resolve();
  };
  return { waits, sleep };
}

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('PollingLoop', () => {
  test('executa a iteração e espera o intervalo entre iterações', async () => {
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const done = deferred();
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 250,
      sleep,
      iteration: async () => {
        calls += 1;
        if (calls === 3) {
          loop.stop();
          done.resolve();
        }
      },
    });
    loop.start();
    await done.promise;
    expect(await loop.drain(1000)).toBe(true);
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 250]);
  });

  test('erro de indisponibilidade aplica backoff de 1 a 30 s e volta ao intervalo depois de um sucesso', async () => {
    const { waits, sleep } = recordingSleep();
    const errors: unknown[] = [];
    let calls = 0;
    const done = deferred();
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 100,
      sleep,
      onError: (error) => errors.push(error),
      iteration: async () => {
        calls += 1;
        if (calls <= 7) throw new ServiceUnavailableError();
        if (calls === 9) {
          loop.stop();
          done.resolve();
        }
      },
    });
    loop.start();
    await done.promise;
    await loop.drain(1000);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 100]);
    expect(errors).toHaveLength(7);
  });

  // T081 (US6; FR-033 a FR-035): as falhas reais de infraestrutura numa iteração — SDK do SQS (timeout, erro de serviço),
  // erro de sistema (ECONNREFUSED), PostgreSQL (57P01, conexão perdida), valor que não é Error — viram log e backoff
  // crescente; um `onError` que lança não derruba o laço; o primeiro sucesso volta ao intervalo normal.
  test('SQS, rede e PostgreSQL fora: backoff crescente, nenhuma exceção escapa, retomada sem reinício', async () => {
    const { waits, sleep } = recordingSleep();
    const sdkTimeout = Object.assign(new Error('Connection timed out after 5000 ms'), { name: 'TimeoutError', $metadata: {} });
    const sdkService = Object.assign(new Error('Service unavailable'), { name: 'ServiceUnavailable', $fault: 'server', $metadata: { httpStatusCode: 503 } });
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4566'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' });
    const pgTerminated = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    const failures: unknown[] = [sdkTimeout, sdkService, refused, pgTerminated, 'not an error', new Error('onError also throws')];
    const logged: unknown[] = [];
    let calls = 0;
    const done = deferred();
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 100,
      sleep,
      onError: (error) => {
        logged.push(error);
        if (error instanceof Error && error.message === 'onError also throws') throw new Error('logger down');
      },
      iteration: async () => {
        calls += 1;
        if (calls <= failures.length) throw failures[calls - 1];
        if (calls === failures.length + 2) {
          loop.stop();
          done.resolve();
        }
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      loop.start();
      await done.promise;
      expect(await loop.drain(1000)).toBe(true);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 100]);
    expect(logged).toEqual(failures);
    expect(unhandled).toEqual([]);
  });

  test('uma exceção na iteração nunca escapa do laço (sem rejeição não tratada)', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const done = deferred();
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 10,
      sleep,
      iteration: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        loop.stop();
        done.resolve();
      },
    });
    loop.start();
    await done.promise;
    expect(await loop.drain(1000)).toBe(true);
    expect(calls).toBe(2);
  });

  test('stop() aborta o AbortSignal repassado à iteração (long polling cancelável)', async () => {
    const received: AbortSignal[] = [];
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 10,
      iteration: (signal) =>
        new Promise<void>((resolve) => {
          received.push(signal);
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    loop.start();
    await Bun.sleep(5);
    expect(received).toHaveLength(1);
    expect(received[0]!.aborted).toBe(false);
    loop.stop();
    expect(received[0]!.aborted).toBe(true);
    expect(await loop.drain(1000)).toBe(true);
    expect(loop.isRunning()).toBe(false);
  });

  test('stop() interrompe a espera do intervalo (sono real)', async () => {
    let calls = 0;
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 60_000,
      iteration: async () => {
        calls += 1;
      },
    });
    loop.start();
    await Bun.sleep(10);
    const started = performance.now();
    loop.stop();
    expect(await loop.drain(1000)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
    expect(calls).toBe(1);
  });

  test('drain(timeoutMs) espera a iteração em andamento até o prazo', async () => {
    const gate = deferred();
    let finished = false;
    const loop = new PollingLoop({
      name: 'test',
      intervalMs: 10,
      iteration: async () => {
        await gate.promise; // não respeita o sinal: trabalho que precisa terminar
        finished = true;
      },
    });
    loop.start();
    await Bun.sleep(5);
    loop.stop();
    const draining = loop.drain(2000);
    await Bun.sleep(20);
    expect(finished).toBe(false);
    gate.resolve();
    expect(await draining).toBe(true);
    expect(finished).toBe(true);
  });

  test('drain devolve false quando a iteração não termina no prazo', async () => {
    const loop = new PollingLoop({ name: 'test', intervalMs: 10, iteration: () => new Promise<void>(() => {}) });
    loop.start();
    await Bun.sleep(5);
    loop.stop();
    const started = performance.now();
    expect(await loop.drain(50)).toBe(false);
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  test('drain sem start resolve true na hora; start duas vezes é recusado', async () => {
    const loop = new PollingLoop({ name: 'test', intervalMs: 10, iteration: async () => {} });
    expect(await loop.drain(10)).toBe(true);
    loop.start();
    expect(() => loop.start()).toThrow();
    loop.stop();
    await loop.drain(1000);
  });
});

describe('WorkerRegistry', () => {
  test('drainAll para e drena todos os trabalhadores registrados', async () => {
    const events: string[] = [];
    const registry = new WorkerRegistry();
    for (const name of ['consumer', 'publisher']) {
      registry.register({
        name,
        stop: () => void events.push(`stop:${name}`),
        drain: async (timeoutMs) => {
          events.push(`drain:${name}:${timeoutMs}`);
          return true;
        },
      });
    }
    expect(await registry.drainAll(500)).toBe(true);
    expect(events.slice(0, 2).sort()).toEqual(['stop:consumer', 'stop:publisher']);
    expect(events.slice(2).sort()).toEqual(['drain:consumer:500', 'drain:publisher:500']);
  });

  test('drainAll devolve false se algum não drenou; chamado de novo não repete o trabalho', async () => {
    let stops = 0;
    const registry = new WorkerRegistry();
    registry.register({ name: 'slow', stop: () => void (stops += 1), drain: async () => false });
    expect(await registry.drainAll(10)).toBe(false);
    expect(await registry.drainAll(10)).toBe(false);
    expect(stops).toBe(1);
  });

  test('sem trabalhadores, drainAll resolve true', async () => {
    expect(await new WorkerRegistry().drainAll(10)).toBe(true);
  });

  test('registrar depois do drainAll é recusado', async () => {
    const registry = new WorkerRegistry();
    await registry.drainAll(10);
    expect(() => registry.register({ name: 'late', stop: () => {}, drain: async () => true })).toThrow();
  });
});
