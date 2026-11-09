/**
 * Porta de métricas (FR-036, constitution VIII; research R-32 da 002 e R-43 da 003). Só observação: nenhum contador é
 * garantia de nada. Rótulos nunca carregam valores monetários nem identificadores (002/FR-037, 003/FR-023).
 *
 * Contrato de falha (requisito do usuário na 003, implementation-notes): a porta NUNCA lança no caminho de negócio. Uma
 * amostra fora do contrato (nome desconhecido, rótulo fora da lista fechada, valor não finito) é descartada com um aviso
 * no log; só em modo de teste (NODE_ENV=test) a violação lança, para que o teste falhe.
 */
export const METRICS = Symbol('METRICS');

export const COUNTER_NAMES = [
  'transactions_total',
  'duplicates_total',
  'retries_total',
  'dlq_total',
  'lock_conflicts_total',
  'reconciliation_divergences_total',
] as const;
export const OBSERVATION_NAMES = ['outbox_lag_ms', 'processing_latency_ms'] as const;

/** Lista fechada de rótulos (R-43; FR-023): nenhum id, nenhum valor. */
export const LABEL_NAMES = ['status', 'source', 'worker', 'errorCode', 'errorClass', 'outcome', 'kind'] as const;

/** Limites superiores dos buckets dos histogramas, em ms (R-43; contracts/metrics.md); `+Inf` é implícito. */
export const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];
export type ObservationName = (typeof OBSERVATION_NAMES)[number];
export type LabelName = (typeof LABEL_NAMES)[number];
export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsPort {
  increment(name: CounterName, labels?: MetricLabels): void;
  observe(name: ObservationName, value: number, labels?: MetricLabels): void;
}
