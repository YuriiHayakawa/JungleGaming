// T006 — encerramento que deixa de ser "pronto" na hora do sinal, drena com o HTTP aberto e só então fecha a app
// (R-40; FR-016; requisito do usuário registrado em implementation-notes: ready 503 antes de iniciar a drenagem).
import { describe, expect, test } from 'bun:test';
import { gracefulShutdown } from '../../src/platform/lifecycle/graceful-shutdown.ts';
import { WORKER_REGISTRY, WorkerRegistry, type DrainableWorker } from '../../src/platform/workers/worker-registry.ts';

function fakeApp(registry: WorkerRegistry, events: string[], close: () => Promise<void> = async () => {}) {
  return {
    get(token: unknown) {
      if (token !== WORKER_REGISTRY) throw new Error('unexpected token');
      return registry;
    },
    async close() {
      events.push(`close(draining=${registry.isDraining()})`);
      await close();
    },
  };
}

function worker(name: string, events: string[], registry: WorkerRegistry, drain: () => Promise<boolean> = async () => true): DrainableWorker {
  return {
    name,
    stop: () => void events.push(`stop:${name}(draining=${registry.isDraining()})`),
    drain: async (timeoutMs) => {
      events.push(`drain:${name}(${timeoutMs})`);
      return drain();
    },
  };
}

describe('WorkerRegistry.isDraining / beginShutdown', () => {
  test('false antes do encerramento; true desde beginShutdown, antes de qualquer drain, e continua true', async () => {
    const registry = new WorkerRegistry();
    const events: string[] = [];
    registry.register(worker('a', events, registry));
    expect(registry.isDraining()).toBe(false);
    registry.beginShutdown();
    expect(registry.isDraining()).toBe(true);
    expect(events).toEqual([]); // nenhum trabalhador parado ainda
    await registry.drainAll(1000);
    expect(registry.isDraining()).toBe(true);
  });

  test('drainAll sem beginShutdown também marca isDraining desde a primeira chamada; a segunda devolve a mesma promessa', async () => {
    const registry = new WorkerRegistry();
    let release: (v: boolean) => void = () => {};
    registry.register({ name: 'slow', stop: () => {}, drain: () => new Promise<boolean>((r) => (release = r)) });
    const first = registry.drainAll(1000);
    expect(registry.isDraining()).toBe(true);
    const second = registry.drainAll(5000);
    expect(second).toBe(first);
    release(true);
    expect(await first).toBe(true);
  });
});

describe('gracefulShutdown', () => {
  test('ordem: isDraining na hora (síncrono) → stop/drain dos trabalhadores → app.close()', async () => {
    const registry = new WorkerRegistry();
    const events: string[] = [];
    registry.register(worker('consumer', events, registry));
    registry.register(worker('publisher', events, registry));
    const app = fakeApp(registry, events);

    const done = gracefulShutdown(app, 7_000);
    // Síncrono: o ready já responde 503 antes de a drenagem começar a esperar qualquer coisa.
    expect(registry.isDraining()).toBe(true);
    await done;
    expect(events).toEqual([
      'stop:consumer(draining=true)',
      'stop:publisher(draining=true)',
      'drain:consumer(7000)',
      'drain:publisher(7000)',
      'close(draining=true)',
    ]);
  });

  test('app.close() só depois que a drenagem termina', async () => {
    const registry = new WorkerRegistry();
    const events: string[] = [];
    let release: (v: boolean) => void = () => {};
    registry.register(worker('consumer', events, registry, () => new Promise<boolean>((r) => (release = r))));
    const done = gracefulShutdown(fakeApp(registry, events), 1_000);
    await Bun.sleep(10);
    expect(events).not.toContain('close(draining=true)');
    release(true);
    await done;
    expect(events.at(-1)).toBe('close(draining=true)');
  });

  test('chamadas repetidas devolvem a mesma promessa e fecham a app uma vez', async () => {
    const registry = new WorkerRegistry();
    const events: string[] = [];
    const app = fakeApp(registry, events);
    const first = gracefulShutdown(app, 1_000);
    const second = gracefulShutdown(app, 1_000);
    expect(second).toBe(first);
    await first;
    expect(events.filter((e) => e.startsWith('close'))).toHaveLength(1);
  });

  test('erro no app.close() propaga', async () => {
    const registry = new WorkerRegistry();
    const app = fakeApp(registry, [], async () => Promise.reject(new Error('pool close failed')));
    await expect(gracefulShutdown(app, 1_000)).rejects.toThrow('pool close failed');
  });

  test('drenagem que esgota o prazo (false) não impede o fechamento', async () => {
    const registry = new WorkerRegistry();
    const events: string[] = [];
    registry.register(worker('consumer', events, registry, async () => false));
    await gracefulShutdown(fakeApp(registry, events), 1_000);
    expect(events.at(-1)).toBe('close(draining=true)');
  });
});
