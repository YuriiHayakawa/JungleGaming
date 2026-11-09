import type { HistogramSnapshot, MetricsSnapshot } from './in-memory-metrics.ts';

/** `Content-Type` do formato de texto de exposição 0.0.4 do Prometheus (R-42; contracts/metrics.md). */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Gauges lidos do banco na hora da coleta (R-44); ausentes quando o banco não respondeu (FR-022). */
export interface OutboxLagGauges {
  pendingEvents: number;
  oldestPendingAgeSeconds: number;
}

type FamilyType = 'counter' | 'histogram' | 'gauge';

interface Family {
  name: string;
  type: FamilyType;
  help: string;
  /** Contador sem rótulo: aparece com 0 antes do primeiro incremento (contracts/metrics.md). */
  unlabeled?: boolean;
}

/** As famílias do contrato, com HELP e tipo (contracts/metrics.md; data-model §1). */
const FAMILIES: readonly Family[] = [
  { name: 'dlq_total', type: 'counter', help: 'Messages sent to the dead-letter queue, by error code and class.' },
  { name: 'duplicates_total', type: 'counter', help: 'Duplicates detected, by source (idempotency replay or inbox).' },
  { name: 'lock_conflicts_total', type: 'counter', help: 'Wallet lock waits that exhausted the lock timeout.', unlabeled: true },
  { name: 'outbox_lag_ms', type: 'histogram', help: 'Delay from event occurrence to publication, in milliseconds.' },
  { name: 'outbox_oldest_pending_age_seconds', type: 'gauge', help: 'Age of the oldest unpublished outbox event, read at scrape time.' },
  { name: 'outbox_pending_events', type: 'gauge', help: 'Outbox events not yet published, read at scrape time.' },
  { name: 'processing_latency_ms', type: 'histogram', help: 'Processing latency per message or pending re-evaluation, in milliseconds.' },
  { name: 'reconciliation_divergences_total', type: 'counter', help: 'Reconciliations that found a divergence.', unlabeled: true },
  { name: 'retries_total', type: 'counter', help: 'Retries scheduled, by background worker.' },
  { name: 'transactions_total', type: 'counter', help: 'Wager transactions recorded, counted after commit.' },
];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Rótulos em ordem de nome, com `le` (histograma) sempre por último. */
function labelText(labels: Record<string, string>, le?: string): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`);
  if (le !== undefined) parts.push(`le="${le}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`metric value must be finite, got ${value}`);
  return String(value);
}

const seriesKey = (labels: Record<string, string>) => labelText(labels);
const byLabels = <T extends { labels: Record<string, string> }>(a: T, b: T) => seriesKey(a.labels).localeCompare(seriesKey(b.labels));

function histogramLines(name: string, series: HistogramSnapshot): string[] {
  const lines: string[] = [];
  let cumulative = 0;
  for (const bucket of series.buckets) {
    cumulative += bucket.count;
    lines.push(`${name}_bucket${labelText(series.labels, String(bucket.le))} ${cumulative}`);
  }
  lines.push(`${name}_sum${labelText(series.labels)} ${numberText(series.sum)}`);
  lines.push(`${name}_count${labelText(series.labels)} ${series.count}`);
  return lines;
}

/**
 * Exposição em texto Prometheus 0.0.4, escrita à mão (R-42; I-76): `# HELP` e `# TYPE` por família, famílias em ordem de
 * nome e séries em ordem de rótulos, valores de rótulo escapados, histogramas com `_bucket` cumulativo até `+Inf`,
 * `_sum` e `_count`. Função pura. Os gauges da outbox só aparecem quando informados (FR-022).
 */
export function renderPrometheus(snapshot: MetricsSnapshot, gauges?: OutboxLagGauges): string {
  const lines: string[] = [];
  for (const family of FAMILIES) {
    if (family.type === 'gauge' && !gauges) continue;
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    if (family.type === 'counter') {
      const series = snapshot.counters.filter((c) => c.name === family.name).sort(byLabels);
      if (series.length === 0 && family.unlabeled) lines.push(`${family.name} 0`);
      for (const s of series) lines.push(`${family.name}${labelText(s.labels)} ${numberText(s.value)}`);
    } else if (family.type === 'histogram') {
      for (const s of snapshot.histograms.filter((h) => h.name === family.name).sort(byLabels)) {
        lines.push(...histogramLines(family.name, s));
      }
    } else if (gauges) {
      const value = family.name === 'outbox_pending_events' ? gauges.pendingEvents : gauges.oldestPendingAgeSeconds;
      lines.push(`${family.name} ${numberText(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
