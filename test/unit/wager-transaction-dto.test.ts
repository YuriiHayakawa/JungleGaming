// T067 — schema Zod da submissão (FR-001, FR-002, FR-010 a FR-012, I-01 a I-03, I-05, I-07, I-08, I-13, I-48,
// I-50, I-57, I-58, R-13).
import { describe, expect, test } from 'bun:test';
import {
  parseIdempotencyKey,
  parseSubmitWagerTransactionBody,
} from '../../src/wagering/interfaces/http/wager-transaction.dto.ts';
import {
  IdempotencyKeyRequiredError,
  OpeningNotAllowedError,
  ValidationError,
} from '../../src/shared-kernel/application/errors.ts';

const valid = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'Player-ABC',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'Round-987',
  gameId: 'Fortune-Chimp',
  kind: 'BET' as const,
  money: { amount: '25.00', currency: 'BRL' },
};

const parse = (body: unknown) => parseSubmitWagerTransactionBody(body);
const withBody = (overrides: Record<string, unknown>) => ({ ...valid, ...overrides });
const issuesOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) {
      return ((error.details?.issues ?? []) as { path: string }[]).map((i) => i.path);
    }
    throw error;
  }
  throw new Error('expected ValidationError');
};

describe('corpo válido', () => {
  test('aceita e normaliza', () => {
    expect(parse(valid)).toEqual(valid);
  });

  test('"25" → "25.00" e "25.5" → "25.50"', () => {
    expect(parse(withBody({ money: { amount: '25', currency: 'BRL' } })).money.amount).toBe('25.00');
    expect(parse(withBody({ money: { amount: '25.5', currency: 'BRL' } })).money.amount).toBe('25.50');
  });
});

describe('money (I-01, I-02, I-03, I-05)', () => {
  test('amount como número JSON → erro', () => {
    expect(issuesOf(() => parse(withBody({ money: { amount: 25, currency: 'BRL' } })))).toContain('money.amount');
  });

  test.each(['25.001', '-1', '1e3', '', ' 1', 'NaN', 'Infinity', '10000000000000000.00'])('amount "%s" → erro', (amount) => {
    expect(issuesOf(() => parse(withBody({ money: { amount, currency: 'BRL' } })))).toContain('money.amount');
  });

  test('9999999999999999.99 é aceito', () => {
    expect(parse(withBody({ money: { amount: '9999999999999999.99', currency: 'BRL' } })).money.amount).toBe(
      '9999999999999999.99',
    );
  });

  test.each(['brl', 'BR', 'BRLX', ''])('moeda "%s" → erro', (currency) => {
    expect(issuesOf(() => parse(withBody({ money: { amount: '1.00', currency } })))).toContain('money.currency');
  });

  test('zero aceito só em LOSS', () => {
    expect(parse(withBody({ kind: 'LOSS', money: { amount: '0', currency: 'BRL' } })).money.amount).toBe('0.00');
    for (const kind of ['BET', 'WIN']) {
      expect(issuesOf(() => parse(withBody({ kind, money: { amount: '0.00', currency: 'BRL' } })))).toContain('money.amount');
    }
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect(
        issuesOf(() =>
          parse(withBody({ kind, referenceExternalTransactionId: 'b-1', money: { amount: '0.00', currency: 'BRL' } })),
        ),
      ).toContain('money.amount');
    }
  });
});

describe('kind, providerId e referência (I-07, I-08, I-13)', () => {
  test('kind OPENING → OpeningNotAllowedError', () => {
    expect(() => parse(withBody({ kind: 'OPENING' }))).toThrow(OpeningNotAllowedError);
  });

  test('kind desconhecido → erro', () => {
    expect(issuesOf(() => parse(withBody({ kind: 'JACKPOT' })))).toContain('kind');
  });

  test('providerId "system" → erro', () => {
    expect(issuesOf(() => parse(withBody({ providerId: 'system' })))).toContain('providerId');
  });

  test('BET com referência → erro', () => {
    expect(issuesOf(() => parse(withBody({ referenceExternalTransactionId: 'x' })))).toContain('referenceExternalTransactionId');
  });

  test('REFUND ou ROLLBACK sem referência → erro', () => {
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect(issuesOf(() => parse(withBody({ kind })))).toContain('referenceExternalTransactionId');
    }
  });

  test('WIN e LOSS com ou sem referência são aceitos', () => {
    for (const kind of ['WIN', 'LOSS']) {
      expect(parse(withBody({ kind })).referenceExternalTransactionId).toBeUndefined();
      expect(parse(withBody({ kind, referenceExternalTransactionId: 'Bet-1' })).referenceExternalTransactionId).toBe('Bet-1');
    }
  });
});

describe('identificadores (I-50, I-58)', () => {
  test('walletId que não é UUID → erro', () => {
    for (const walletId of ['abc', '0192f291-27dd-7d3f-8071-5f8685deef3', '', 123]) {
      expect(issuesOf(() => parse(withBody({ walletId })))).toContain('walletId');
    }
  });

  test('walletId em maiúsculas é normalizado para minúsculas', () => {
    expect(parse(withBody({ walletId: valid.walletId.toUpperCase() })).walletId).toBe(valid.walletId);
  });

  test('os demais ids são preservados exatamente como enviados', () => {
    const parsed = parse(withBody({ kind: 'WIN', referenceExternalTransactionId: 'Bet-REF-1' }));
    expect(parsed.playerId).toBe('Player-ABC');
    expect(parsed.providerId).toBe('provider-a');
    expect(parsed.externalTransactionId).toBe('transaction-123');
    expect(parsed.roundId).toBe('Round-987');
    expect(parsed.gameId).toBe('Fortune-Chimp');
    expect(parsed.referenceExternalTransactionId).toBe('Bet-REF-1');
  });

  test.each(['providerId', 'externalTransactionId', 'playerId', 'roundId', 'gameId'])(
    '%s fora de 1–255 → erro',
    (field) => {
      expect(issuesOf(() => parse(withBody({ [field]: '' })))).toContain(field);
      expect(issuesOf(() => parse(withBody({ [field]: 'x'.repeat(256) })))).toContain(field);
      expect(parse(withBody({ [field]: 'x'.repeat(255) }))).toBeDefined();
    },
  );

  test('referenceExternalTransactionId fora de 1–255 → erro', () => {
    for (const ref of ['', 'x'.repeat(256)]) {
      expect(issuesOf(() => parse(withBody({ kind: 'WIN', referenceExternalTransactionId: ref })))).toContain(
        'referenceExternalTransactionId',
      );
    }
  });

  test('campo obrigatório ausente → erro', () => {
    const { gameId: _omit, ...missing } = valid;
    expect(issuesOf(() => parse(missing))).toContain('gameId');
  });
});

describe('campos desconhecidos (I-57)', () => {
  test('são descartados e não geram erro', () => {
    const parsed = parse({ ...valid, extra: 'x', metadata: { a: 1 }, money: { ...valid.money, note: 'n' } });
    expect(parsed).toEqual(valid);
    expect('extra' in parsed).toBe(false);
  });

  test('um campo conhecido com tipo errado continua dando erro', () => {
    expect(issuesOf(() => parse(withBody({ roundId: 42, extra: 'x' })))).toContain('roundId');
  });

  test('corpo que não é objeto → erro', () => {
    for (const body of [undefined, null, 'x', [valid]]) {
      expect(() => parse(body)).toThrow(ValidationError);
    }
  });
});

describe('header Idempotency-Key (I-23, I-48)', () => {
  test('ausente ou vazio → IDEMPOTENCY_KEY_REQUIRED', () => {
    expect(() => parseIdempotencyKey(undefined)).toThrow(IdempotencyKeyRequiredError);
    expect(() => parseIdempotencyKey('')).toThrow(IdempotencyKeyRequiredError);
  });

  test('mais de 255 caracteres → VALIDATION_ERROR; 1 a 255 é aceito como enviado', () => {
    expect(() => parseIdempotencyKey('k'.repeat(256))).toThrow(ValidationError);
    expect(parseIdempotencyKey('k'.repeat(255))).toBe('k'.repeat(255));
    expect(parseIdempotencyKey('Provider-A:Tx-1')).toBe('Provider-A:Tx-1');
  });

  test('valor repetido (array) → VALIDATION_ERROR', () => {
    expect(() => parseIdempotencyKey(['a', 'b'])).toThrow(ValidationError);
  });
});
