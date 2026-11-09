// T111 — cursor opaco e estável do ledger e o limit da página (I-36, I-47; FR-050, FR-051).
import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, parseLimit, DEFAULT_LIMIT, MAX_LIMIT } from '../../src/wallets/application/ledger-cursor.ts';
import { ValidationError } from '../../src/shared-kernel/application/errors.ts';

const MAX_BIGINT = '9223372036854775807';
const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('encode / decode', () => {
  test('encode gera o base64url do seq em decimal, sem padding', () => {
    expect(encodeCursor('1')).toBe(b64url('1'));
    expect(encodeCursor('120')).toBe(b64url('120'));
    expect(encodeCursor('120')).not.toContain('=');
  });

  test('aceita string ou bigint, nunca number, e faz a volta exata', () => {
    for (const seq of ['1', '42', '1000000', MAX_BIGINT]) {
      expect(decodeCursor(encodeCursor(seq))).toBe(seq);
      expect(decodeCursor(encodeCursor(BigInt(seq)))).toBe(seq);
    }
    // o maior bigint não cabe em number sem perder precisão; a volta continua exata
    expect(decodeCursor(encodeCursor(MAX_BIGINT))).toBe(MAX_BIGINT);
    expect(typeof decodeCursor(encodeCursor('7'))).toBe('string');
  });

  test('encode recusa seq que não é inteiro positivo', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '01']) expect(() => encodeCursor(bad)).toThrow();
  });
});

describe('decode recusa cursor inválido ou adulterado com VALIDATION_ERROR', () => {
  const invalid: Array<[string, string]> = [
    ['vazio', ''],
    ['fora do alfabeto base64url', 'MTI+'],
    ['com padding', 'MTI='],
    ['texto que não é inteiro', b64url('abc')],
    ['zero', b64url('0')],
    ['negativo', b64url('-5')],
    ['decimal', b64url('1.5')],
    ['zero à esquerda', b64url('012')],
    ['mais de 19 dígitos', b64url('12345678901234567890')],
    ['acima do maior bigint', b64url('9223372036854775808')],
    ['espaço', b64url(' 12')],
    ['não canônico (bits extras no último caractere)', 'MTJ'],
    ['longo demais', 'A'.repeat(65)],
  ];
  for (const [label, cursor] of invalid) {
    test(label, () => {
      expect(() => decodeCursor(cursor)).toThrow(ValidationError);
    });
  }

  test('o erro aponta o campo cursor e não ecoa o valor', () => {
    try {
      decodeCursor(b64url('nope-secret'));
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).details?.issues as { path: string; message: string }[];
      expect(issues.map((i) => i.path)).toEqual(['cursor']);
      expect(JSON.stringify(issues)).not.toContain('nope-secret');
    }
  });
});

describe('limit (I-47)', () => {
  test('padrão 50 quando ausente; máximo 200', () => {
    expect(DEFAULT_LIMIT).toBe(50);
    expect(MAX_LIMIT).toBe(200);
    expect(parseLimit(undefined)).toBe(50);
  });

  test('aceita inteiros de 1 a 200', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('50')).toBe(50);
    expect(parseLimit('200')).toBe(200);
  });

  test('não inteiro, < 1 ou > 200 → VALIDATION_ERROR, sem truncar', () => {
    for (const bad of ['0', '201', '-1', '1.5', 'abc', '', ' 5', '5 ', '1e2', '0x10', '050', ['10', '20']]) {
      expect(() => parseLimit(bad)).toThrow(ValidationError);
    }
  });
});
