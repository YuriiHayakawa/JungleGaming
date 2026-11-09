// T028 — renderer do texto Prometheus 0.0.4 escrito à mão (R-42; FR-019, FR-020; contracts/metrics.md).
import { describe, expect, test } from 'bun:test';
import { InMemoryMetrics, type MetricsSnapshot } from '../../src/platform/metrics/in-memory-metrics.ts';
import { COUNTER_NAMES, OBSERVATION_NAMES } from '../../src/platform/metrics/metrics.port.ts';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '../../src/platform/metrics/prometheus-text.ts';
import { parsePrometheus, sampleValue } from '../support/prometheus.ts';

const metrics = () => new InMemoryMetrics({ nodeEnv: 'test' });

describe('renderPrometheus', () => {
  test('Content-Type do formato 0.0.4', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  test('# HELP e # TYPE para toda família do contrato, mesmo sem observações; contadores sem rótulo com 0', () => {
    const text = renderPrometheus(metrics().snapshot(), { pendingEvents: 0, oldestPendingAgeSeconds: 0 });
    const parsed = parsePrometheus(text);
    const expected: Record<string, string> = {
      transactions_total: 'counter',
      duplicates_total: 'counter',
      retries_total: 'counter',
      dlq_total: 'counter',
      lock_conflicts_total: 'counter',
      reconciliation_divergences_total: 'counter',
      processing_latency_ms: 'histogram',
      outbox_lag_ms: 'histogram',
      outbox_pending_events: 'gauge',
      outbox_oldest_pending_age_seconds: 'gauge',
    };
    for (const [name, type] of Object.entries(expected)) {
      expect(parsed.families.get(name)?.type as string | undefined, name).toBe(type);
      expect(parsed.families.get(name)?.help, name).toBeTruthy();
    }
    expect([...parsed.families.keys()].sort()).toEqual(Object.keys(expected).sort());
    // Todo nome da porta tem família.
    for (const name of [...COUNTER_NAMES, ...OBSERVATION_NAMES]) expect(parsed.families.has(name)).toBe(true);
    expect(sampleValue(parsed, 'lock_conflicts_total')).toBe(0);
    expect(sampleValue(parsed, 'reconciliation_divergences_total')).toBe(0);
    // Contador rotulado sem incremento não inventa série; histograma sem observação não tem amostra.
    expect(parsed.samples.filter((s) => s.name === 'transactions_total')).toEqual([]);
    expect(parsed.samples.filter((s) => s.name.startsWith('processing_latency_ms'))).toEqual([]);
  });

  test('contadores com e sem rótulo', () => {
    const m = metrics();
    m.increment('transactions_total', { status: 'PROCESSED' });
    m.increment('transactions_total', { status: 'PROCESSED' });
    m.increment('transactions_total', { status: 'REJECTED' });
    m.increment('dlq_total', { errorCode: 'MALFORMED_MESSAGE', errorClass: 'permanent' });
    m.increment('lock_conflicts_total');
    m.increment('reconciliation_divergences_total');
    m.increment('reconciliation_divergences_total');
    const parsed = parsePrometheus(renderPrometheus(m.snapshot()));
    expect(sampleValue(parsed, 'transactions_total', { status: 'PROCESSED' })).toBe(2);
    expect(sampleValue(parsed, 'transactions_total', { status: 'REJECTED' })).toBe(1);
    expect(sampleValue(parsed, 'dlq_total', { errorClass: 'permanent', errorCode: 'MALFORMED_MESSAGE' })).toBe(1);
    expect(sampleValue(parsed, 'lock_conflicts_total')).toBe(1);
    expect(sampleValue(parsed, 'reconciliation_divergences_total')).toBe(2);
  });

  test('histograma: _bucket cumulativo até +Inf, _sum e _count, por série de rótulos', () => {
    const m = metrics();
    for (const value of [3, 7, 7, 120, 70_000]) m.observe('processing_latency_ms', value, { worker: 'consumer' });
    m.observe('processing_latency_ms', 1, { worker: 'pending_worker' });
    const text = renderPrometheus(m.snapshot());
    const parsed = parsePrometheus(text);
    const bucket = (le: string, worker = 'consumer') => sampleValue(parsed, 'processing_latency_ms_bucket', { worker, le });
    expect(bucket('5')).toBe(1);
    expect(bucket('10')).toBe(3);
    expect(bucket('25')).toBe(3);
    expect(bucket('100')).toBe(3);
    expect(bucket('250')).toBe(4);
    expect(bucket('60000')).toBe(4);
    expect(bucket('+Inf')).toBe(5);
    expect(sampleValue(parsed, 'processing_latency_ms_sum', { worker: 'consumer' })).toBe(3 + 7 + 7 + 120 + 70_000);
    expect(sampleValue(parsed, 'processing_latency_ms_count', { worker: 'consumer' })).toBe(5);
    expect(bucket('+Inf', 'pending_worker')).toBe(1);
    // 13 limites + +Inf, cumulativos (não decrescentes), o último igual ao _count.
    const buckets = parsed.samples.filter((s) => s.name === 'processing_latency_ms_bucket' && s.labels.worker === 'consumer');
    expect(buckets.map((b) => b.labels.le)).toEqual(['5', '10', '25', '50', '100', '250', '500', '1000', '2500', '5000', '10000', '30000', '60000', '+Inf']);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]!.value).toBeGreaterThanOrEqual(buckets[i - 1]!.value);
    // `le` é sempre o último rótulo da linha.
    expect(text).toContain('processing_latency_ms_bucket{worker="consumer",le="+Inf"} 5');
  });

  test('gauges da outbox quando informados; ausentes (sem HELP/TYPE) quando não', () => {
    const snapshot = metrics().snapshot();
    const withGauges = parsePrometheus(renderPrometheus(snapshot, { pendingEvents: 2, oldestPendingAgeSeconds: 1.274 }));
    expect(sampleValue(withGauges, 'outbox_pending_events')).toBe(2);
    expect(sampleValue(withGauges, 'outbox_oldest_pending_age_seconds')).toBe(1.274);
    const without = renderPrometheus(snapshot);
    expect(without).not.toContain('outbox_pending_events');
    expect(without).not.toContain('outbox_oldest_pending_age_seconds');
    expect(parsePrometheus(without).families.has('transactions_total')).toBe(true);
  });

  test('escape de \\\\, \\" e \\n nos valores de rótulo', () => {
    const snapshot: MetricsSnapshot = {
      counters: [{ name: 'dlq_total', labels: { errorCode: 'a"b\\c\nd', errorClass: 'permanent' }, value: 1 }],
      observations: [],
      histograms: [],
    };
    const text = renderPrometheus(snapshot);
    expect(text).toContain('dlq_total{errorClass="permanent",errorCode="a\\"b\\\\c\\nd"} 1');
    expect(sampleValue(parsePrometheus(text), 'dlq_total', { errorClass: 'permanent', errorCode: 'a"b\\c\nd' })).toBe(1);
  });

  test('ordem estável: famílias por nome, séries por rótulos, independente da ordem de registro', () => {
    const a = metrics();
    a.increment('transactions_total', { status: 'REJECTED' });
    a.increment('transactions_total', { status: 'PROCESSED' });
    a.increment('duplicates_total', { source: 'inbox' });
    const b = metrics();
    b.increment('duplicates_total', { source: 'inbox' });
    b.increment('transactions_total', { status: 'PROCESSED' });
    b.increment('transactions_total', { status: 'REJECTED' });
    const textA = renderPrometheus(a.snapshot());
    expect(renderPrometheus(b.snapshot())).toBe(textA);
    const types = textA.split('\n').filter((l) => l.startsWith('# TYPE')).map((l) => l.split(' ')[2]);
    expect(types).toEqual([...types].sort());
    expect(textA.indexOf('status="PROCESSED"')).toBeLessThan(textA.indexOf('status="REJECTED"'));
    expect(textA.endsWith('\n')).toBe(true);
  });

  test('o texto é aceito pelo parser do formato 0.0.4 (T004) com todas as famílias preenchidas', () => {
    const m = metrics();
    m.increment('retries_total', { worker: 'publisher' });
    m.observe('outbox_lag_ms', 42);
    expect(() => parsePrometheus(renderPrometheus(m.snapshot(), { pendingEvents: 1, oldestPendingAgeSeconds: 0.5 }))).not.toThrow();
  });
});
