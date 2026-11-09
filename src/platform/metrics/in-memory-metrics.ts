import {
  COUNTER_NAMES,
  HISTOGRAM_BUCKETS_MS,
  LABEL_NAMES,
  OBSERVATION_NAMES,
  type CounterName,
  type MetricLabels,
  type MetricsPort,
  type ObservationName,
} from './metrics.port.ts';

/** Observações guardadas por série só para os testes (`observations()`); contagem e soma são totais (R-43). */
export const OBSERVATION_WINDOW = 1000;

export interface HistogramBucket {
  /** Limite superior em ms, ou `+Inf`. */
  le: number | '+Inf';
  /** Observações que caem neste bucket (não cumulativo; o renderer acumula). */
  count: number;
}

export interface HistogramSnapshot {
  name: ObservationName;
  labels: Record<string, string>;
  count: number;
  sum: number;
  buckets: HistogramBucket[];
}

export interface MetricsSnapshot {
  counters: Array<{ name: CounterName; labels: Record<string, string>; value: number }>;
  /** Janela das últimas observações por série (só para os testes da 002). */
  observations: Array<{ name: ObservationName; labels: Record<string, string>; values: number[] }>;
  histograms: HistogramSnapshot[];
}

export interface InMemoryMetricsOptions {
  /**
   * Só `test` faz uma violação de contrato lançar; qualquer outro valor descarta a amostra com aviso. Padrão: o
   * `NODE_ENV` do processo. A app passa o `nodeEnv` da configuração.
   */
  nodeEnv?: string;
  /** Destino do aviso de amostra descartada (a app passa o logger em nível warn). */
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

export class MetricsContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsContractError';
  }
}

interface CounterSeries {
  name: CounterName;
  labels: Record<string, string>;
  value: number;
}

interface HistogramSeries {
  name: ObservationName;
  labels: Record<string, string>;
  count: number;
  sum: number;
  /** Uma posição por limite de HISTOGRAM_BUCKETS_MS, mais a última para `+Inf`. */
  buckets: number[];
  window: number[];
}

const ALLOWED_LABELS: ReadonlySet<string> = new Set(LABEL_NAMES);

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

/** Índice do bucket de `value`: o menor limite que o contém; acima do último, `+Inf`. */
function bucketIndex(value: number): number {
  const index = HISTOGRAM_BUCKETS_MS.findIndex((le) => value <= le);
  return index === -1 ? HISTOGRAM_BUCKETS_MS.length : index;
}

/**
 * Registro de métricas em memória, por instância (R-32), exposto em `GET /metrics` (003) e lido pelos testes via
 * `app.get(METRICS)`. Memória constante por série: contadores, histogramas por bucket e uma janela limitada de
 * observações (R-43). Rótulos só da lista fechada; violação → erro em teste, descarte com aviso fora dele.
 */
export class InMemoryMetrics implements MetricsPort {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();
  private readonly strict: boolean;
  private readonly warn: (message: string, fields: Record<string, unknown>) => void;
  private readonly warned = new Set<string>();

  constructor(options: InMemoryMetricsOptions = {}) {
    this.strict = (options.nodeEnv ?? process.env.NODE_ENV) === 'test';
    this.warn = options.warn ?? (() => {});
  }

  increment(name: CounterName, labels: MetricLabels = {}): void {
    if (!this.accepts(name, COUNTER_NAMES.includes(name), labels)) return;
    const key = keyOf(name, labels);
    const series = this.counters.get(key) ?? { name, labels: { ...labels }, value: 0 };
    series.value += 1;
    this.counters.set(key, series);
  }

  observe(name: ObservationName, value: number, labels: MetricLabels = {}): void {
    if (!this.accepts(name, OBSERVATION_NAMES.includes(name), labels)) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.violation(name, '<value>', `observation ${name} must be a finite number`);
      return;
    }
    const key = keyOf(name, labels);
    let series = this.histograms.get(key);
    if (!series) {
      series = { name, labels: { ...labels }, count: 0, sum: 0, buckets: new Array<number>(HISTOGRAM_BUCKETS_MS.length + 1).fill(0), window: [] };
      this.histograms.set(key, series);
    }
    series.count += 1;
    series.sum += value;
    series.buckets[bucketIndex(value)]! += 1;
    series.window.push(value);
    if (series.window.length > OBSERVATION_WINDOW) series.window.shift();
  }

  /** Soma das séries de `name` cujos rótulos contêm `labels`. */
  counter(name: CounterName, labels: MetricLabels = {}): number {
    let total = 0;
    for (const series of this.counters.values()) {
      if (series.name === name && matches(series.labels, labels)) total += series.value;
    }
    return total;
  }

  /** Últimas observações (até OBSERVATION_WINDOW por série) de `name` nas séries cujos rótulos contêm `labels`. */
  observations(name: ObservationName, labels: MetricLabels = {}): number[] {
    const values: number[] = [];
    for (const series of this.histograms.values()) {
      if (series.name === name && matches(series.labels, labels)) values.push(...series.window);
    }
    return values;
  }

  snapshot(): MetricsSnapshot {
    const histograms = [...this.histograms.values()];
    return {
      counters: [...this.counters.values()].map((s) => ({ name: s.name, labels: { ...s.labels }, value: s.value })),
      observations: histograms.map((s) => ({ name: s.name, labels: { ...s.labels }, values: [...s.window] })),
      histograms: histograms.map((s) => ({
        name: s.name,
        labels: { ...s.labels },
        count: s.count,
        sum: s.sum,
        buckets: s.buckets.map((count, i) => ({ le: HISTOGRAM_BUCKETS_MS[i] ?? ('+Inf' as const), count })),
      })),
    };
  }

  /** Confere nome e rótulos; devolve false (amostra descartada) quando a violação não lança. */
  private accepts(name: string, known: boolean, labels: MetricLabels): boolean {
    if (!known) {
      this.violation(String(name), '<name>', `unknown metric: ${String(name)}`);
      return false;
    }
    for (const label of Object.keys(labels)) {
      if (!ALLOWED_LABELS.has(label)) {
        this.violation(name, label, `label "${label}" is not allowed on ${name} (allowed: ${LABEL_NAMES.join(', ')})`);
        return false;
      }
      if (typeof labels[label] !== 'string') {
        this.violation(name, label, `label "${label}" on ${name} must be a string`);
        return false;
      }
    }
    return true;
  }

  /** Em teste lança; fora dele avisa uma vez por (métrica, rótulo), sem o valor do rótulo, e segue. */
  private violation(metric: string, label: string, message: string): void {
    if (this.strict) throw new MetricsContractError(message);
    const key = `${metric}|${label}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try {
      this.warn('metrics.sample_dropped', { event: 'metrics.sample_dropped', metric, label });
    } catch {
      // o aviso é observação; nunca derruba o caminho de negócio
    }
  }
}
