// T009 — envelope WagerTransactionRequested (FR-002, I-57, I-60, I-66, I-69;
// contracts/wager-transaction-requested.schema.json).
import { describe, expect, test } from 'bun:test';
import {
  InvalidWagerMessageError,
  parseWagerMessage,
  type DlqErrorCode,
} from '../../src/messaging/application/wager-message.envelope.ts';

/** Exemplo do contrato. */
const EXAMPLE = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

type Envelope = Record<string, unknown> & { data: Record<string, unknown> };
const clone = (): Envelope => structuredClone(EXAMPLE) as Envelope;
const body = (value: unknown) => JSON.stringify(value);

function codeOf(raw: string): { code: DlqErrorCode; messageId: string | undefined } {
  try {
    parseWagerMessage(raw);
  } catch (error) {
    if (error instanceof InvalidWagerMessageError) return { code: error.errorCode, messageId: error.messageId };
    throw error;
  }
  throw new Error('expected InvalidWagerMessageError');
}

describe('mensagem válida', () => {
  test('o exemplo do contrato é aceito', () => {
    const message = parseWagerMessage(body(EXAMPLE));
    expect(message.messageId).toBe('msg-123');
    expect(message.type).toBe('WagerTransactionRequested');
    expect(message.occurredAt).toBe('2026-07-29T15:00:00.000Z');
    expect(message.idempotencyKey).toBe('provider-a:transaction-123');
    expect(message.input).toEqual({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
  });

  test('campos desconhecidos são descartados, no envelope e em data (I-57)', () => {
    const envelope = clone();
    envelope.extra = 'x';
    envelope.data.unknownField = { nested: true };
    const message = parseWagerMessage(body(envelope));
    expect(message.input).not.toHaveProperty('unknownField');
    expect(message.input).not.toHaveProperty('idempotencyKey');
    expect(message).not.toHaveProperty('extra');
  });

  test('walletId em maiúsculas é normalizado (I-58); amount normalizado para 2 casas', () => {
    const envelope = clone();
    envelope.data.walletId = '0192F291-27DD-7D3F-8071-5F8685DEEF37';
    envelope.data.money = { amount: '25', currency: 'BRL' };
    const message = parseWagerMessage(body(envelope));
    expect(message.input.walletId).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(message.input.money.amount).toBe('25.00');
  });

  test('occurredAt com offset é ISO-8601 válido', () => {
    const envelope = clone();
    envelope.occurredAt = '2026-07-29T12:00:00-03:00';
    expect(parseWagerMessage(body(envelope)).occurredAt).toBe('2026-07-29T12:00:00-03:00');
  });

  test('REFUND com referência é aceito', () => {
    const envelope = clone();
    envelope.data.kind = 'REFUND';
    envelope.data.referenceExternalTransactionId = 'transaction-1';
    expect(parseWagerMessage(body(envelope)).input.referenceExternalTransactionId).toBe('transaction-1');
  });
});

describe('MALFORMED_MESSAGE', () => {
  test.each(['not json', '{', '', 'null', '"string"', '[]', '42'])('corpo que não é um objeto JSON: %p', (raw) => {
    expect(codeOf(raw).code).toBe('MALFORMED_MESSAGE');
  });

  test.each(['messageId', 'type', 'occurredAt', 'data'])('envelope sem %s', (field) => {
    const envelope = clone();
    delete envelope[field];
    expect(codeOf(body(envelope)).code).toBe('MALFORMED_MESSAGE');
  });

  test.each([
    ['vazio', ''],
    ['129 caracteres', 'x'.repeat(129)],
    ['espaço', 'msg 1'],
    ['barra', 'msg/1'],
    ['acento', 'mensagém'],
    ['número', 123],
  ])('messageId inválido (%s)', (_, messageId) => {
    const envelope = clone();
    envelope.messageId = messageId;
    expect(codeOf(body(envelope)).code).toBe('MALFORMED_MESSAGE');
  });

  test('messageId de 128 caracteres é aceito', () => {
    const envelope = clone();
    envelope.messageId = 'x'.repeat(128);
    expect(parseWagerMessage(body(envelope)).messageId).toBe('x'.repeat(128));
  });

  test.each(['2026-07-29', 'ontem', '', 1730000000])('occurredAt não ISO-8601: %p', (occurredAt) => {
    const envelope = clone();
    envelope.occurredAt = occurredAt;
    expect(codeOf(body(envelope)).code).toBe('MALFORMED_MESSAGE');
  });

  test('data que não é objeto', () => {
    const envelope = clone() as Record<string, unknown>;
    envelope.data = 'x';
    expect(codeOf(body(envelope)).code).toBe('MALFORMED_MESSAGE');
  });

  test('o messageId válido acompanha o erro quando existe', () => {
    const envelope = clone();
    delete (envelope as Record<string, unknown>).occurredAt;
    expect(codeOf(body(envelope)).messageId).toBe('msg-123');
  });
});

describe('UNSUPPORTED_MESSAGE_TYPE (I-66)', () => {
  test('type "Other" com envelope válido', () => {
    const envelope = clone();
    envelope.type = 'Other';
    expect(codeOf(body(envelope))).toEqual({ code: 'UNSUPPORTED_MESSAGE_TYPE', messageId: 'msg-123' });
  });
});

describe('VALIDATION_ERROR (regras da 001 sobre data)', () => {
  const invalid = (mutate: (data: Record<string, unknown>) => void) => {
    const envelope = clone();
    mutate(envelope.data);
    return codeOf(body(envelope));
  };

  test('amount numérico (I-01)', () => {
    expect(invalid((d) => (d.money = { amount: 25, currency: 'BRL' })).code).toBe('VALIDATION_ERROR');
  });

  test('sem idempotencyKey, vazia ou com 256 caracteres', () => {
    expect(invalid((d) => delete d.idempotencyKey).code).toBe('VALIDATION_ERROR');
    expect(invalid((d) => (d.idempotencyKey = '')).code).toBe('VALIDATION_ERROR');
    expect(invalid((d) => (d.idempotencyKey = 'k'.repeat(256))).code).toBe('VALIDATION_ERROR');
  });

  test('idempotencyKey de 255 caracteres é aceita', () => {
    const envelope = clone();
    envelope.data.idempotencyKey = 'k'.repeat(255);
    expect(parseWagerMessage(body(envelope)).idempotencyKey).toBe('k'.repeat(255));
  });

  test('autorreferência (I-60)', () => {
    expect(
      invalid((d) => {
        d.kind = 'REFUND';
        d.referenceExternalTransactionId = d.externalTransactionId;
      }).code,
    ).toBe('VALIDATION_ERROR');
  });

  test('providerId "system" (I-07)', () => {
    expect(invalid((d) => (d.providerId = 'system')).code).toBe('VALIDATION_ERROR');
  });

  test('BET com referência, REFUND sem referência, zero fora de LOSS, walletId não UUID', () => {
    expect(invalid((d) => (d.referenceExternalTransactionId = 'x')).code).toBe('VALIDATION_ERROR');
    expect(invalid((d) => (d.kind = 'REFUND')).code).toBe('VALIDATION_ERROR');
    expect(invalid((d) => (d.money = { amount: '0.00', currency: 'BRL' })).code).toBe('VALIDATION_ERROR');
    expect(invalid((d) => (d.walletId = 'wallet-1')).code).toBe('VALIDATION_ERROR');
  });
});

describe('OPENING_NOT_ALLOWED (I-08)', () => {
  test('kind OPENING', () => {
    const envelope = clone();
    envelope.data.kind = 'OPENING';
    expect(codeOf(body(envelope))).toEqual({ code: 'OPENING_NOT_ALLOWED', messageId: 'msg-123' });
  });
});
