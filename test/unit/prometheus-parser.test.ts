// T004 — autoteste do parser mínimo de texto Prometheus usado nas asserções (test/support/prometheus.ts; R-45).
import { describe, expect, test } from 'bun:test';
import { parsePrometheus, sampleValue } from '../support/prometheus.ts';

describe('parsePrometheus', () => {
  test('lê famílias, amostras com e sem rótulo, escapes, +Inf e decimais', () => {
    const parsed = parsePrometheus(
      [
        '# HELP transactions_total Wager transactions.',
        '# TYPE transactions_total counter',
        'transactions_total{status="PROCESSED"} 42',
        'transactions_total{status="REJECTED"} 3',
        '# TYPE lag histogram',
        'lag_bucket{le="5"} 1',
        'lag_bucket{le="+Inf"} 2',
        'lag_sum 7.5',
        'lag_count 2',
        '# TYPE weird gauge',
        'weird{a="x\\"y",b="c\\\\d",n="l\\nm"} -1.25',
        '',
      ].join('\n'),
    );
    expect(parsed.families.get('transactions_total')).toEqual({ name: 'transactions_total', type: 'counter', help: 'Wager transactions.' });
    expect(parsed.families.get('lag')?.type).toBe('histogram');
    expect(sampleValue(parsed, 'transactions_total', { status: 'PROCESSED' })).toBe(42);
    expect(sampleValue(parsed, 'transactions_total')).toBeUndefined();
    expect(sampleValue(parsed, 'lag_bucket', { le: '+Inf' })).toBe(2);
    expect(sampleValue(parsed, 'lag_sum')).toBe(7.5);
    expect(sampleValue(parsed, 'weird', { a: 'x"y', b: 'c\\d', n: 'l\nm' })).toBe(-1.25);
  });

  test.each([
    ['sem quebra de linha final', 'a 1'],
    ['valor ausente', 'a\n'],
    ['valor não numérico', 'a abc\n'],
    ['rótulo sem aspas', 'a{b=c} 1\n'],
    ['escape inválido', 'a{b="\\x"} 1\n'],
    ['rótulo duplicado', 'a{b="1",b="2"} 1\n'],
    ['comentário fora do formato', '# qualquer coisa\n'],
    ['TYPE desconhecido', '# TYPE a magic\n'],
    ['nome inválido', '1a 1\n'],
  ])('recusa: %s', (_label, text) => {
    expect(() => parsePrometheus(text)).toThrow();
  });
});
