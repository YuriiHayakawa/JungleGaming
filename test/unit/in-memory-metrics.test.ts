// T010 da 002 — porta de métricas em memória (FR-036, R-32).
// T005 da 003 — histogramas por bucket, janela limitada, lista fechada de rótulos, novo contador (R-43; FR-020, FR-023,
// FR-024) e o requisito do usuário: a porta nunca lança no caminho de negócio fora de NODE_ENV=test (implementation-notes).
import { describe, expect, test } from 'bun:test';
import { InMemoryMetrics, OBSERVATION_WINDOW } from '../../src/platform/metrics/in-memory-metrics.ts';
import { HISTOGRAM_BUCKETS_MS, LABEL_NAMES } from '../../src/platform/metrics/metrics.port.ts';

const strict = () => new InMemoryMetrics({ nodeEnv: 'test' });

describe('InMemoryMetrics', () => {
  test('increment acumula por nome e rótulos', () => {
    const metrics = strict();
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
    const metrics = strict();
    // Rótulos da lista fechada (R-43); antes da 003 o exemplo usava um rótulo livre ("origin").
    metrics.increment('transactions_total', { status: 'PROCESSED', kind: 'BET' });
    metrics.increment('transactions_total', { kind: 'BET', status: 'PROCESSED' });
    expect(metrics.counter('transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(2);
  });

  test('observe acumula valores por nome e rótulos', () => {
    const metrics = strict();
    metrics.observe('outbox_lag_ms', 120);
    metrics.observe('outbox_lag_ms', 80);
    metrics.observe('processing_latency_ms', 5, { worker: 'consumer' });
    expect(metrics.observations('outbox_lag_ms')).toEqual([120, 80]);
    expect(metrics.observations('processing_latency_ms', { worker: 'consumer' })).toEqual([5]);
    expect(metrics.observations('processing_latency_ms', { worker: 'publisher' })).toEqual([]);
  });

  test('snapshot devolve contadores, observações e histogramas', () => {
    const metrics = strict();
    metrics.increment('retries_total', { worker: 'consumer' });
    metrics.observe('outbox_lag_ms', 10);
    const snapshot = metrics.snapshot();
    expect(snapshot.counters).toEqual([{ name: 'retries_total', labels: { worker: 'consumer' }, value: 1 }]);
    expect(snapshot.observations).toEqual([{ name: 'outbox_lag_ms', labels: {}, values: [10] }]);
    expect(snapshot.histograms).toHaveLength(1);
    expect(snapshot.histograms[0]).toMatchObject({ name: 'outbox_lag_ms', labels: {}, count: 1, sum: 10 });
  });

  test('aceita só os nomes do R-32 e o contador da 003; nome desconhecido lança erro em modo de teste', () => {
    const metrics = strict();
    for (const name of [
      'transactions_total',
      'duplicates_total',
      'retries_total',
      'dlq_total',
      'lock_conflicts_total',
      'reconciliation_divergences_total',
    ] as const) {
      expect(() => metrics.increment(name)).not.toThrow();
    }
    for (const name of ['outbox_lag_ms', 'processing_latency_ms'] as const) {
      expect(() => metrics.observe(name, 1)).not.toThrow();
    }
    expect(() => metrics.increment('unknown_total' as never)).toThrow();
    expect(() => metrics.observe('unknown_ms' as never, 1)).toThrow();
  });
});

describe('histogramas por bucket (R-43)', () => {
  test('buckets fixos em ms, contagem por bucket, soma e contagem', () => {
    expect([...HISTOGRAM_BUCKETS_MS]).toEqual([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]);
    const metrics = strict();
    for (const value of [0, 5, 6, 10, 99, 100, 60_000, 60_001, 1_000_000]) {
      metrics.observe('processing_latency_ms', value, { worker: 'consumer' });
    }
    const [histogram] = metrics.snapshot().histograms;
    expect(histogram!.count).toBe(9);
    expect(histogram!.sum).toBe(0 + 5 + 6 + 10 + 99 + 100 + 60_000 + 60_001 + 1_000_000);
    // Contagem por bucket (não cumulativa): o valor cai no menor `le` que o contém; acima de 60000 vai para +Inf.
    const byLe = Object.fromEntries(histogram!.buckets.map((b) => [String(b.le), b.count]));
    expect(byLe).toEqual({
      '5': 2,
      '10': 2,
      '25': 0,
      '50': 0,
      '100': 2,
      '250': 0,
      '500': 0,
      '1000': 0,
      '2500': 0,
      '5000': 0,
      '10000': 0,
      '30000': 0,
      '60000': 1,
      '+Inf': 2,
    });
  });

  test('séries de histograma separadas por rótulo', () => {
    const metrics = strict();
    metrics.observe('processing_latency_ms', 1, { worker: 'consumer' });
    metrics.observe('processing_latency_ms', 2, { worker: 'pending_worker' });
    metrics.observe('processing_latency_ms', 3, { worker: 'pending_worker' });
    const counts = Object.fromEntries(metrics.snapshot().histograms.map((h) => [h.labels.worker, h.count]));
    expect(counts).toEqual({ consumer: 1, pending_worker: 2 });
  });

  test(`observations() devolve no máximo as últimas ${1000} observações da série; contagem e soma continuam totais`, () => {
    expect(OBSERVATION_WINDOW).toBe(1000);
    const metrics = strict();
    for (let i = 1; i <= 1500; i++) metrics.observe('outbox_lag_ms', i);
    const window = metrics.observations('outbox_lag_ms');
    expect(window).toHaveLength(1000);
    expect(window[0]).toBe(501);
    expect(window[999]).toBe(1500);
    const [histogram] = metrics.snapshot().histograms;
    expect(histogram!.count).toBe(1500);
    expect(histogram!.sum).toBe((1500 * 1501) / 2);
  });
});

describe('lista fechada de rótulos (R-43; FR-023)', () => {
  test('a lista é status, source, worker, errorCode, errorClass, outcome, kind', () => {
    expect([...LABEL_NAMES]).toEqual(['status', 'source', 'worker', 'errorCode', 'errorClass', 'outcome', 'kind']);
  });

  test('todos os rótulos da lista são aceitos', () => {
    const metrics = strict();
    expect(() =>
      metrics.increment('dlq_total', { status: 'a', source: 'b', worker: 'c', errorCode: 'd', errorClass: 'e', outcome: 'f', kind: 'g' }),
    ).not.toThrow();
  });

  test('modo de teste (NODE_ENV=test): rótulo fora da lista falha com erro', () => {
    const metrics = strict();
    expect(() => metrics.increment('transactions_total', { walletId: 'w-1' })).toThrow(/walletId/);
    expect(() => metrics.observe('processing_latency_ms', 1, { providerId: 'p' })).toThrow(/providerId/);
    expect(() => metrics.increment('transactions_total', { status: 'PROCESSED', origin: 'queue' })).toThrow(/origin/);
    expect(() => metrics.observe('outbox_lag_ms', Number.NaN)).toThrow();
    expect(metrics.snapshot().counters).toEqual([]);
    expect(metrics.snapshot().histograms).toEqual([]);
  });

  for (const nodeEnv of ['production', 'development']) {
    test(`NODE_ENV=${nodeEnv}: nunca lança; a amostra é descartada com um aviso por métrica e rótulo`, () => {
      const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
      const metrics = new InMemoryMetrics({ nodeEnv, warn: (message, fields) => warnings.push({ message, fields }) });

      expect(() => metrics.increment('transactions_total', { status: 'PROCESSED', walletId: 'w-1' })).not.toThrow();
      expect(() => metrics.increment('transactions_total', { status: 'PROCESSED', walletId: 'w-2' })).not.toThrow();
      expect(() => metrics.increment('duplicates_total', { walletId: 'w-3' })).not.toThrow();
      expect(() => metrics.observe('processing_latency_ms', 3, { providerId: 'p-1' })).not.toThrow();
      expect(() => metrics.observe('processing_latency_ms', 4, { providerId: 'p-2' })).not.toThrow();
      expect(() => metrics.increment('unknown_total' as never)).not.toThrow();
      expect(() => metrics.observe('outbox_lag_ms', Number.POSITIVE_INFINITY)).not.toThrow();

      // Nada foi registrado: a amostra inteira é descartada, não só o rótulo.
      expect(metrics.counter('transactions_total')).toBe(0);
      expect(metrics.counter('duplicates_total')).toBe(0);
      expect(metrics.observations('processing_latency_ms')).toEqual([]);
      expect(metrics.snapshot().histograms).toEqual([]);

      // Um aviso por (métrica, rótulo): transactions_total/walletId, duplicates_total/walletId,
      // processing_latency_ms/providerId, unknown_total e outbox_lag_ms (valor inválido).
      expect(warnings.map((w) => `${String(w.fields.metric)}:${String(w.fields.label)}`).sort()).toEqual([
        'duplicates_total:walletId',
        'outbox_lag_ms:<value>',
        'processing_latency_ms:providerId',
        'transactions_total:walletId',
        'unknown_total:<name>',
      ]);
      expect(warnings.every((w) => w.message === 'metrics.sample_dropped')).toBe(true);
      // O aviso nunca carrega o valor do rótulo (pode ser um id).
      expect(JSON.stringify(warnings)).not.toMatch(/w-1|w-2|w-3|p-1|p-2/);

      // Amostras válidas continuam sendo registradas normalmente.
      metrics.increment('transactions_total', { status: 'PROCESSED' });
      expect(metrics.counter('transactions_total', { status: 'PROCESSED' })).toBe(1);
    });
  }

  test('sem NODE_ENV informado, vale o NODE_ENV do processo (bun test define "test")', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new InMemoryMetrics().increment('transactions_total', { walletId: 'x' })).toThrow();
  });
});
