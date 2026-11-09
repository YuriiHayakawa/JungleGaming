// T010 — porta de métricas em memória (FR-036, R-32).
import { describe, expect, test } from 'bun:test';
import { InMemoryMetrics } from '../../src/platform/metrics/in-memory-metrics.ts';

describe('InMemoryMetrics', () => {
  test('increment acumula por nome e rótulos', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('duplicates_total', { source: 'inbox' });
    metrics.increment('duplicates_total', { source: 'inbox' });
    metrics.increment('duplicates_total', { source: 'idempotency' });
    metrics.increment('lock_conflicts_total');
    expect(metrics.counter('duplicates_total', { source: 'inbox' })).toBe(2);
    expect(metrics.counter('duplicates_total', { source: 'idempotency' })).toBe(1);
    expect(metrics.counter('duplicates_total')).toBe(3);
    expect(metrics.counter('lock_conflicts_total')).toBe(1);
    expect(metrics.counter('dlq_total')).toBe(0);
  });

  test('a ordem dos rótulos não importa', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('transactions_total', { status: 'PROCESSED', origin: 'queue' });
    metrics.increment('transactions_total', { origin: 'queue', status: 'PROCESSED' });
    expect(metrics.counter('transactions_total', { status: 'PROCESSED', origin: 'queue' })).toBe(2);
  });

  test('observe acumula valores por nome e rótulos', () => {
    const metrics = new InMemoryMetrics();
    metrics.observe('outbox_lag_ms', 120);
    metrics.observe('outbox_lag_ms', 80);
    metrics.observe('processing_latency_ms', 5, { worker: 'consumer' });
    expect(metrics.observations('outbox_lag_ms')).toEqual([120, 80]);
    expect(metrics.observations('processing_latency_ms', { worker: 'consumer' })).toEqual([5]);
    expect(metrics.observations('processing_latency_ms', { worker: 'publisher' })).toEqual([]);
  });

  test('snapshot devolve contadores e observações', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('retries_total', { worker: 'consumer' });
    metrics.observe('outbox_lag_ms', 10);
    expect(metrics.snapshot()).toEqual({
      counters: [{ name: 'retries_total', labels: { worker: 'consumer' }, value: 1 }],
      observations: [{ name: 'outbox_lag_ms', labels: {}, values: [10] }],
    });
  });

  test('aceita só os nomes do R-32; nome desconhecido lança erro', () => {
    const metrics = new InMemoryMetrics();
    for (const name of ['transactions_total', 'duplicates_total', 'retries_total', 'dlq_total', 'lock_conflicts_total'] as const) {
      expect(() => metrics.increment(name)).not.toThrow();
    }
    for (const name of ['outbox_lag_ms', 'processing_latency_ms'] as const) {
      expect(() => metrics.observe(name, 1)).not.toThrow();
    }
    expect(() => metrics.increment('unknown_total' as never)).toThrow();
    expect(() => metrics.observe('unknown_ms' as never, 1)).toThrow();
  });
});
