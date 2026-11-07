// T011 — configuração e hierarquia de timeouts (FR-059, I-51, research R-11).
import { expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '../../src/platform/config/app-config.ts';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  PORT: '3001',
  WALLET_LOCK_TIMEOUT_MS: '5000',
  DB_POOL_MAX: '25',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '8000',
  HTTP_SERVER_TIMEOUT_MS: '20000',
  RETRY_AFTER_SECONDS: '1',
  FAILPOINT: '',
  NODE_ENV: 'development',
};

test('lê e valida as variáveis do .env.example', () => {
  const cfg = loadConfig(base);
  expect(cfg).toEqual({
    databaseUrl: base.DATABASE_URL,
    port: 3001,
    walletLockTimeoutMs: 5000,
    dbPoolMax: 25,
    dbPoolAcquireTimeoutMs: 8000,
    httpServerTimeoutMs: 20000,
    retryAfterSeconds: 1,
    failpoint: undefined,
    nodeEnv: 'development',
  });
});

test('usa os padrões do research R-11 quando as variáveis de timeout não vêm', () => {
  const cfg = loadConfig({ DATABASE_URL: base.DATABASE_URL });
  expect(cfg.walletLockTimeoutMs).toBe(5000);
  expect(cfg.dbPoolMax).toBe(25);
  expect(cfg.dbPoolAcquireTimeoutMs).toBe(8000);
  expect(cfg.httpServerTimeoutMs).toBe(20000);
  expect(cfg.retryAfterSeconds).toBe(1);
  expect(cfg.port).toBe(3001);
});

test('PORT=0 é aceito (porta efêmera dos testes)', () => {
  expect(loadConfig({ ...base, PORT: '0' }).port).toBe(0);
});

test('recusa DB_POOL_ACQUIRE_TIMEOUT_MS <= WALLET_LOCK_TIMEOUT_MS', () => {
  expect(() => loadConfig({ ...base, DB_POOL_ACQUIRE_TIMEOUT_MS: '5000' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, DB_POOL_ACQUIRE_TIMEOUT_MS: '4000' })).toThrow(ConfigError);
});

test('recusa HTTP_SERVER_TIMEOUT_MS <= acquire + lock + 2000', () => {
  expect(() => loadConfig({ ...base, HTTP_SERVER_TIMEOUT_MS: '15000' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, HTTP_SERVER_TIMEOUT_MS: '14999' })).toThrow(ConfigError);
  expect(loadConfig({ ...base, HTTP_SERVER_TIMEOUT_MS: '15001' }).httpServerTimeoutMs).toBe(15001);
});

test.each(['0', '-1', '1.5', 'abc', '5000ms', ' 500', ''])(
  'recusa WALLET_LOCK_TIMEOUT_MS="%s" (precisa ser inteiro positivo: é interpolado no SET LOCAL)',
  (value) => {
    expect(() => loadConfig({ ...base, WALLET_LOCK_TIMEOUT_MS: value })).toThrow(ConfigError);
  },
);

test('recusa DATABASE_URL ausente e números inválidos', () => {
  expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, DB_POOL_MAX: '0' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, RETRY_AFTER_SECONDS: 'x' })).toThrow(ConfigError);
  expect(() => loadConfig({ ...base, PORT: '-1' })).toThrow(ConfigError);
});

test('FAILPOINT preenchido é lido', () => {
  expect(loadConfig({ ...base, FAILPOINT: 'after_commit_before_response' }).failpoint).toBe(
    'after_commit_before_response',
  );
});
