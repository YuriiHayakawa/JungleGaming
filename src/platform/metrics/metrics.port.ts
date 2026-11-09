/**
 * Porta de métricas (FR-036, constitution VIII; research R-32). Só observação: nenhum contador é garantia de nada.
 * Rótulos nunca carregam valores monetários (FR-037). A exposição (endpoint, Prometheus) fica para outra feature.
 */
export const METRICS = Symbol('METRICS');

export const COUNTER_NAMES = [
  'transactions_total',
  'duplicates_total',
  'retries_total',
  'dlq_total',
  'lock_conflicts_total',
] as const;
export const OBSERVATION_NAMES = ['outbox_lag_ms', 'processing_latency_ms'] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];
export type ObservationName = (typeof OBSERVATION_NAMES)[number];
export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsPort {
  increment(name: CounterName, labels?: MetricLabels): void;
  observe(name: ObservationName, value: number, labels?: MetricLabels): void;
}
