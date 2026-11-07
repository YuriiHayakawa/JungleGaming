// T066 — payloadHash sobre JSON canônico (FR-031, I-25, I-57, I-58, research R-09).
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/wagering/application/canonical-json.ts';
import { computePayloadHash, type PayloadHashSource } from '../../src/wagering/application/payload-hash.ts';

const base: PayloadHashSource = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('ordena as chaves recursivamente, sem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [3, { f: true, e: null }] } })).toBe(
      '{"a":{"c":[3,{"e":null,"f":true}],"d":"x"},"b":1}',
    );
  });

  test('omite chaves com valor undefined e preserva a ordem dos arrays', () => {
    expect(canonicalJson({ z: undefined, y: ['b', 'a'] })).toBe('{"y":["b","a"]}');
  });

  test('UTF-8: caracteres não ASCII são preservados', () => {
    expect(canonicalJson({ nome: 'ação' })).toBe('{"nome":"ação"}');
  });
});

describe('computePayloadHash (I-25)', () => {
  test('SHA-256 hex de 64 caracteres sobre o JSON canônico dos campos de negócio', () => {
    const hash = computePayloadHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHash('sha256')
      .update(
        '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},' +
          '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987",' +
          '"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
        'utf8',
      )
      .digest('hex');
    expect(hash).toBe(expected);
  });

  test('a ordem das chaves na entrada não muda o hash', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: base.gameId,
      roundId: base.roundId,
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: base.externalTransactionId,
      providerId: base.providerId,
    } as PayloadHashSource;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  test('amount normalizado: LOSS "0" e "0.00" geram o mesmo hash, assim como "25" e "25.00"', () => {
    const loss = { ...base, kind: 'LOSS', money: { amount: '0', currency: 'BRL' } };
    expect(computePayloadHash(loss)).toBe(computePayloadHash({ ...loss, money: { amount: '0.00', currency: 'BRL' } }));
    expect(computePayloadHash({ ...base, money: { amount: '25', currency: 'BRL' } })).toBe(computePayloadHash(base));
    expect(computePayloadHash({ ...base, money: { amount: '25.5', currency: 'BRL' } })).toBe(
      computePayloadHash({ ...base, money: { amount: '25.50', currency: 'BRL' } }),
    );
  });

  test('referenceExternalTransactionId ausente é omitido; presente entra no hash', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(computePayloadHash(base));
    expect(computePayloadHash({ ...base, kind: 'WIN', referenceExternalTransactionId: 'bet-1' })).not.toBe(
      computePayloadHash({ ...base, kind: 'WIN' }),
    );
  });

  test('idempotencyKey, messageId, occurredAt e campos desconhecidos não alteram o hash (I-25, I-57)', () => {
    const noisy = {
      ...base,
      idempotencyKey: 'provider-a:transaction-123',
      messageId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      extra: { anything: 1 },
    } as PayloadHashSource;
    expect(computePayloadHash(noisy)).toBe(computePayloadHash(base));
    const noisyMoney = { ...base, money: { ...base.money, note: 'x' } } as PayloadHashSource;
    expect(computePayloadHash(noisyMoney)).toBe(computePayloadHash(base));
  });

  test('walletId em maiúsculas e minúsculas geram o mesmo hash (I-58)', () => {
    expect(computePayloadHash({ ...base, walletId: base.walletId.toUpperCase() })).toBe(computePayloadHash(base));
  });

  test.each(['playerId', 'providerId', 'externalTransactionId', 'roundId', 'gameId', 'referenceExternalTransactionId'] as const)(
    '%s com caixa diferente gera hash diferente (case-sensitive, I-58)',
    (field) => {
      const original = { ...base, kind: 'WIN', referenceExternalTransactionId: 'Bet-Ref-1' };
      const changed = { ...original, [field]: String(original[field]).toUpperCase() };
      expect(String(changed[field])).not.toBe(String(original[field]));
      expect(computePayloadHash(changed)).not.toBe(computePayloadHash(original));
    },
  );

  test('qualquer campo de negócio diferente muda o hash', () => {
    const reference = computePayloadHash(base);
    expect(computePayloadHash({ ...base, money: { amount: '26.00', currency: 'BRL' } })).not.toBe(reference);
    expect(computePayloadHash({ ...base, money: { amount: '25.00', currency: 'USD' } })).not.toBe(reference);
    expect(computePayloadHash({ ...base, kind: 'WIN' })).not.toBe(reference);
  });
});

// Vetores fixos: o JSON canônico foi escrito à mão e o SHA-256 foi calculado fora do código do projeto
// (`sha256sum` do coreutils sobre o arquivo UTF-8 sem newline final), em 2026-11-07.
describe('vetores fixos (I-25)', () => {
  const vectors = [
    {
      name: 'BET sem referência; amount "25" e walletId em maiúsculas na entrada',
      input: {
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25', currency: 'BRL' },
        idempotencyKey: 'ignored',
      },
      canonical:
        '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
      sha256: '629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344',
    },
    {
      name: 'WIN com referência, caracteres não ASCII e amount "0.1"',
      input: {
        providerId: 'provider-b',
        externalTransactionId: 'win-1',
        playerId: 'Player-1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'r-1',
        gameId: 'jogo-ação',
        kind: 'WIN',
        money: { amount: '0.1', currency: 'BRL' },
        referenceExternalTransactionId: 'Bet-1',
      },
      canonical:
        '{"externalTransactionId":"win-1","gameId":"jogo-ação","kind":"WIN","money":{"amount":"0.10","currency":"BRL"},"playerId":"Player-1","providerId":"provider-b","referenceExternalTransactionId":"Bet-1","roundId":"r-1","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
      sha256: '2daed182317bf22b4a24084741780d7bb8657dce791eb9d1b8209e090e4b5511',
    },
  ];

  test.each(vectors)('$name', ({ input, canonical, sha256 }) => {
    const normalized = {
      ...input,
      walletId: input.walletId.toLowerCase(),
      money: { amount: input.money.amount === '25' ? '25.00' : '0.10', currency: input.money.currency },
      idempotencyKey: undefined,
    };
    expect(canonicalJson(normalized)).toBe(canonical);
    expect(computePayloadHash(input as PayloadHashSource)).toBe(sha256);
  });
});
