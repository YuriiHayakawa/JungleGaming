// Parser mínimo do formato de texto 0.0.4 do Prometheus, só para asserções de teste (T004, research R-45). Recusa
// qualquer linha fora do formato, para que um erro do renderer não passe despercebido.

export interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface PrometheusFamily {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';
  help?: string;
}

export interface ParsedPrometheus {
  families: Map<string, PrometheusFamily>;
  samples: PrometheusSample[];
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped']);

function parseValue(raw: string, line: string): number {
  if (raw === '+Inf') return Number.POSITIVE_INFINITY;
  if (raw === '-Inf') return Number.NEGATIVE_INFINITY;
  if (raw === 'NaN') return Number.NaN;
  if (!/^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(raw)) throw new Error(`invalid sample value in: ${line}`);
  return Number(raw);
}

/** Lê `{a="x",b="y"}` a partir de `start` (o `{`); devolve os rótulos e o índice depois do `}`. */
function parseLabels(line: string, start: number): { labels: Record<string, string>; end: number } {
  const labels: Record<string, string> = {};
  let i = start + 1;
  for (;;) {
    if (line[i] === '}') return { labels, end: i + 1 };
    const eq = line.indexOf('=', i);
    if (eq === -1) throw new Error(`invalid labels in: ${line}`);
    const name = line.slice(i, eq);
    if (!LABEL_NAME.test(name)) throw new Error(`invalid label name "${name}" in: ${line}`);
    if (line[eq + 1] !== '"') throw new Error(`label value must be quoted in: ${line}`);
    let value = '';
    let j = eq + 2;
    for (;;) {
      const ch = line[j];
      if (ch === undefined) throw new Error(`unterminated label value in: ${line}`);
      if (ch === '\\') {
        const next = line[j + 1];
        if (next === '\\') value += '\\';
        else if (next === '"') value += '"';
        else if (next === 'n') value += '\n';
        else throw new Error(`invalid escape in: ${line}`);
        j += 2;
        continue;
      }
      if (ch === '"') break;
      value += ch;
      j += 1;
    }
    if (name in labels) throw new Error(`duplicate label "${name}" in: ${line}`);
    labels[name] = value;
    i = j + 1;
    if (line[i] === ',') i += 1;
    else if (line[i] !== '}') throw new Error(`invalid label separator in: ${line}`);
  }
}

export function parsePrometheus(text: string): ParsedPrometheus {
  const families = new Map<string, PrometheusFamily>();
  const samples: PrometheusSample[] = [];
  if (text.length > 0 && !text.endsWith('\n')) throw new Error('exposition must end with a newline');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('#')) {
      const help = /^# HELP ([^ ]+) (.*)$/.exec(line);
      const type = /^# TYPE ([^ ]+) ([a-z]+)$/.exec(line);
      if (help) {
        if (!METRIC_NAME.test(help[1]!)) throw new Error(`invalid metric name in: ${line}`);
        const family = families.get(help[1]!) ?? { name: help[1]!, type: 'untyped' as const };
        families.set(help[1]!, { ...family, help: help[2]! });
      } else if (type) {
        if (!METRIC_NAME.test(type[1]!) || !TYPES.has(type[2]!)) throw new Error(`invalid TYPE line: ${line}`);
        const family = families.get(type[1]!);
        families.set(type[1]!, { ...(family ?? { name: type[1]! }), type: type[2]! as PrometheusFamily['type'] });
      } else {
        throw new Error(`invalid comment line: ${line}`);
      }
      continue;
    }
    const nameMatch = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
    if (!nameMatch) throw new Error(`invalid sample line: ${line}`);
    const name = nameMatch[0];
    let rest = nameMatch[0].length;
    let labels: Record<string, string> = {};
    if (line[rest] === '{') {
      const parsed = parseLabels(line, rest);
      labels = parsed.labels;
      rest = parsed.end;
    }
    const tail = line.slice(rest);
    const valueMatch = /^ (\S+)( -?\d+)?$/.exec(tail);
    if (!valueMatch) throw new Error(`invalid sample line: ${line}`);
    samples.push({ name, labels, value: parseValue(valueMatch[1]!, line) });
  }
  return { families, samples };
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Valor da amostra `name` com exatamente os rótulos `labels` (sem rótulos por padrão), ou `undefined`. */
export function sampleValue(parsed: ParsedPrometheus, name: string, labels: Record<string, string> = {}): number | undefined {
  return parsed.samples.find((s) => s.name === name && sameLabels(s.labels, labels))?.value;
}
