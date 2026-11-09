import {
  COUNTER_NAMES,
  OBSERVATION_NAMES,
  type CounterName,
  type MetricLabels,
  type MetricsPort,
  type ObservationName,
} from './metrics.port.ts';

interface Series<T> {
  name: string;
  labels: Record<string, string>;
  value: T;
}

export interface MetricsSnapshot {
  counters: Array<{ name: CounterName; labels: Record<string, string>; value: number }>;
  observations: Array<{ name: ObservationName; labels: Record<string, string>; values: number[] }>;
}

function keyOf(name: string, labels: MetricLabels): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
  return `${name}{${sorted}}`;
}

function matches(series: Record<string, string>, filter: MetricLabels): boolean {
  return Object.entries(filter).every(([k, v]) => series[k] === v);
}

/**
 * Registro de métricas em memória, por instância (R-32), lido pelos testes via `app.get(METRICS)`. Nome fora da lista
 * do R-32 é erro de programação.
 */
export class InMemoryMetrics implements MetricsPort {
  private readonly counters = new Map<string, Series<number>>();
  private readonly observed = new Map<string, Series<number[]>>();

  increment(name: CounterName, labels: MetricLabels = {}): void {
    if (!COUNTER_NAMES.includes(name)) throw new Error(`unknown counter: ${String(name)}`);
    const key = keyOf(name, labels);
    const series = this.counters.get(key) ?? { name, labels: { ...labels }, value: 0 };
    series.value += 1;
    this.counters.set(key, series);
  }

  observe(name: ObservationName, value: number, labels: MetricLabels = {}): void {
    if (!OBSERVATION_NAMES.includes(name)) throw new Error(`unknown observation: ${String(name)}`);
    const key = keyOf(name, labels);
    const series = this.observed.get(key) ?? { name, labels: { ...labels }, value: [] };
    series.value.push(value);
    this.observed.set(key, series);
  }

  /** Soma das séries de `name` cujos rótulos contêm `labels`. */
  counter(name: CounterName, labels: MetricLabels = {}): number {
    let total = 0;
    for (const series of this.counters.values()) {
      if (series.name === name && matches(series.labels, labels)) total += series.value;
    }
    return total;
  }

  /** Valores observados de `name` nas séries cujos rótulos contêm `labels`, na ordem de registro por série. */
  observations(name: ObservationName, labels: MetricLabels = {}): number[] {
    const values: number[] = [];
    for (const series of this.observed.values()) {
      if (series.name === name && matches(series.labels, labels)) values.push(...series.value);
    }
    return values;
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.counters.values()].map((s) => ({ name: s.name as CounterName, labels: { ...s.labels }, value: s.value })),
      observations: [...this.observed.values()].map((s) => ({
        name: s.name as ObservationName,
        labels: { ...s.labels },
        values: [...s.value],
      })),
    };
  }
}
