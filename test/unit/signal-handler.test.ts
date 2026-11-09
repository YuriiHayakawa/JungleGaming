// T012 — handler próprio de sinal (FR-014, I-34, R-35), com process, exit e temporizadores injetados.
import { describe, expect, test } from 'bun:test';
import { installShutdownSignals, SHUTDOWN_MARGIN_MS } from '../../src/platform/lifecycle/signal-handler.ts';

function harness(options: { close?: () => Promise<void>; shutdownTimeoutMs?: number } = {}) {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number; unrefCalled: boolean; cleared: boolean }> = [];
  let closes = 0;
  const target = { on: (signal: string, listener: () => void) => void listeners.set(signal, listener) };
  installShutdownSignals({
    target,
    close: async () => {
      closes += 1;
      await (options.close ?? (async () => {}))();
    },
    exit: (code) => void exits.push(code),
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, cleared: false };
      timers.push(timer);
      return {
        unref: () => void (timer.unrefCalled = true),
        clear: () => void (timer.cleared = true),
      };
    },
  });
  return {
    listeners,
    exits,
    timers,
    get closes() {
      return closes;
    },
    send: (signal: 'SIGTERM' | 'SIGINT') => {
      const listener = listeners.get(signal);
      if (!listener) throw new Error(`no listener for ${signal}`);
      listener();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('installShutdownSignals', () => {
  test.each(['SIGTERM', 'SIGINT'] as const)('%s chama close() e depois exit(0)', async (signal) => {
    const h = harness();
    expect([...h.listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    h.send(signal);
    await flush();
    expect(h.closes).toBe(1);
    expect(h.exits).toEqual([0]);
  });

  test('um segundo sinal durante o encerramento é ignorado (close() chamado uma vez)', async () => {
    let release: () => void = () => {};
    const h = harness({ close: () => new Promise<void>((resolve) => (release = resolve)) });
    h.send('SIGTERM');
    h.send('SIGTERM');
    h.send('SIGINT');
    expect(h.closes).toBe(1);
    release();
    await flush();
    expect(h.exits).toEqual([0]);
  });

  test('close() que rejeita → exit(1)', async () => {
    const h = harness({ close: async () => Promise.reject(new Error('pool close failed')) });
    h.send('SIGTERM');
    await flush();
    expect(h.exits).toEqual([1]);
  });

  test('close() que não termina → exit(1) depois de CONSUMER_SHUTDOWN_TIMEOUT_MS + 5000', async () => {
    const h = harness({ close: () => new Promise<void>(() => {}), shutdownTimeoutMs: 7_000 });
    h.send('SIGTERM');
    await flush();
    expect(h.exits).toEqual([]);
    expect(h.timers).toHaveLength(1);
    expect(SHUTDOWN_MARGIN_MS).toBe(5_000);
    expect(h.timers[0]!.ms).toBe(12_000);
    h.timers[0]!.fn();
    expect(h.exits).toEqual([1]);
  });

  test('o temporizador de segurança não segura o processo (unref) e é cancelado ao terminar', async () => {
    const h = harness();
    h.send('SIGTERM');
    await flush();
    expect(h.timers[0]!.unrefCalled).toBe(true);
    expect(h.timers[0]!.cleared).toBe(true);
  });

  test('sem sinal, nada acontece', async () => {
    const h = harness();
    await flush();
    expect(h.closes).toBe(0);
    expect(h.exits).toEqual([]);
    expect(h.timers).toEqual([]);
  });
});

// T006 da 003 (R-40; requisito do usuário): o handler usa a função de encerramento recebida e, antes dela, marca a
// instância como "não pronta" de forma síncrona, no instante do sinal.
describe('installShutdownSignals com beginShutdown', () => {
  test('beginShutdown é chamado de forma síncrona no sinal, antes de close(); o sinal repetido não chama de novo', async () => {
    const order: string[] = [];
    const listeners = new Map<string, () => void>();
    let release: () => void = () => {};
    installShutdownSignals({
      target: { on: (signal: string, listener: () => void) => void listeners.set(signal, listener) },
      beginShutdown: () => void order.push('beginShutdown'),
      close: () => {
        order.push('close');
        return new Promise<void>((resolve) => (release = resolve));
      },
      exit: (code) => void order.push(`exit(${code})`),
      shutdownTimeoutMs: 1_000,
      setTimer: () => ({ unref: () => {}, clear: () => {} }),
      log: (message) => void order.push(message),
    });
    listeners.get('SIGTERM')!();
    // Síncrono: já marcado antes de qualquer await, e antes do log e da drenagem.
    expect(order).toEqual(['beginShutdown', 'shutdown.started', 'close']);
    listeners.get('SIGTERM')!();
    expect(order.filter((e) => e === 'beginShutdown')).toHaveLength(1);
    release();
    await flush();
    expect(order).toEqual(['beginShutdown', 'shutdown.started', 'close', 'shutdown.signal_ignored', 'shutdown.completed', 'exit(0)']);
  });

  test('sem beginShutdown, o comportamento da 002 não muda', async () => {
    const h = harness();
    h.send('SIGTERM');
    await flush();
    expect(h.closes).toBe(1);
    expect(h.exits).toEqual([0]);
  });
});
