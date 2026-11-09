// T015 — classificação dos erros do banco (research R-12), no formato observado no spike (S-06, S-07, S-09).
import { describe, expect, test } from 'bun:test';
import {
  CheckConstraintViolationException,
  ConnectionException,
  DeadlockException,
  DriverException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { classifyDbError } from '../../src/platform/persistence/pg-errors.ts';

function pgError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields);
}
const driver = (code: string | undefined, message = 'db error') =>
  new DriverException(pgError(message, code ? { code } : {}));

describe('transient → 503', () => {
  test('timeout de aquisição do pool: DriverException sem code, só pela mensagem (S-09)', () => {
    expect(classifyDbError(driver(undefined, 'timeout exceeded when trying to connect'))).toBe('transient');
  });
  test.each(['55P03', '08000', '08003', '08006', '08001', '57P01', '57P02', '57P03', '53300', '57014'])(
    'SQLSTATE %s',
    (code) => {
      expect(classifyDbError(driver(code))).toBe('transient');
    },
  );
  test('lock_timeout chega como DriverException genérica com code 55P03 (S-06)', () => {
    expect(classifyDbError(driver('55P03', 'canceling statement due to lock timeout'))).toBe('transient');
  });
  test.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'])('erro de rede %s', (code) => {
    expect(classifyDbError(pgError('connect failed', { code }))).toBe('transient');
    expect(classifyDbError(new ConnectionException(pgError('connect failed', { code })))).toBe('transient');
  });
});

describe('retry', () => {
  test.each(['40P01', '40001'])('SQLSTATE %s', (code) => {
    expect(classifyDbError(driver(code))).toBe('retry');
  });
  test('DeadlockException do MikroORM', () => {
    expect(classifyDbError(new DeadlockException(pgError('deadlock detected', { code: '40P01' })))).toBe('retry');
  });
});

describe('23505 pelo nome da constraint (S-07)', () => {
  const unique = (constraint: string) =>
    new UniqueConstraintViolationException(pgError('duplicate key', { code: '23505', constraint }));
  test.each([
    ['wager_tx_provider_idempotency_uq', 'idempotency-race'],
    ['wager_tx_provider_external_uq', 'idempotency-race'],
    ['wallets_player_currency_uq', 'wallet-duplicate'],
    ['wager_tx_single_reversal_uq', 'reversal-race'],
  ] as const)('%s → %s', (constraint, kind) => {
    expect(classifyDbError(unique(constraint))).toBe(kind);
  });
  test('constraint lida do erro original do driver em cause, quando a exceção não a copia', () => {
    const wrapped = Object.assign(new Error('wrapped'), {
      code: '23505',
      cause: pgError('duplicate key', { code: '23505', constraint: 'wallets_player_currency_uq' }),
    });
    expect(classifyDbError(wrapped)).toBe('wallet-duplicate');
  });
  test('outra constraint única → invariant', () => {
    expect(classifyDbError(unique('ledger_wallet_tx_uq'))).toBe('invariant');
  });
});

describe('quebra de invariante → 500', () => {
  test.each(['23514', '22003', 'P0001', '23503', '23502'])('SQLSTATE %s', (code) => {
    expect(classifyDbError(driver(code))).toBe('invariant');
  });
  test('CheckConstraintViolationException', () => {
    expect(
      classifyDbError(new CheckConstraintViolationException(pgError('check', { code: '23514' }))),
    ).toBe('invariant');
  });
});

describe('desconhecido', () => {
  test('erro sem relação com o banco', () => {
    expect(classifyDbError(new TypeError('x is not a function'))).toBe('unknown');
    expect(classifyDbError('string')).toBe('unknown');
    expect(classifyDbError(undefined)).toBe('unknown');
  });
});

describe('feature 002 (T013; I-28, R-22)', () => {
  test('23505 em inbox_messages_pk → inbox-race', () => {
    expect(classifyDbError(pgError('duplicate key', { code: '23505', constraint: 'inbox_messages_pk' }))).toBe('inbox-race');
    expect(
      classifyDbError(new UniqueConstraintViolationException(pgError('duplicate key', { code: '23505', constraint: 'inbox_messages_pk' }))),
    ).toBe('inbox-race');
  });
});
