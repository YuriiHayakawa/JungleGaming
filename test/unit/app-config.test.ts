// T011 — configuração e hierarquia de timeouts (FR-059, I-51, research R-11).
import { describe, expect, test } from 'bun:test';
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

/** Variáveis da feature 002 com os valores do .env.example (research R-27). */
const messaging = {
  SQS_ENDPOINT: 'http://localhost:4566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_TRANSACTIONS_QUEUE: 'wager-transactions.fifo',
  SQS_TRANSACTIONS_DLQ: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE: 'wager-events.fifo',
  CONSUMER_ENABLED: 'false',
  PUBLISHER_ENABLED: 'false',
  PENDING_WORKER_ENABLED: 'false',
  CONSUMER_NAME: 'wager-transactions-consumer',
  CONSUMER_WAIT_SECONDS: '20',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '30',
  CONSUMER_RETRY_BASE_SECONDS: '5',
  CONSUMER_RETRY_MAX_SECONDS: '60',
  CONSUMER_SHUTDOWN_TIMEOUT_MS: '10000',
  PUBLISHER_BATCH_SIZE: '10',
  PUBLISHER_LEASE_MS: '30000',
  PUBLISHER_POLL_MS: '1000',
  PUBLISHER_BACKOFF_MIN_MS: '1000',
  PUBLISHER_BACKOFF_MAX_MS: '60000',
  PENDING_WORKER_BATCH_SIZE: '10',
  PENDING_WORKER_LEASE_MS: '30000',
  PENDING_WORKER_POLL_MS: '1000',
  PENDING_MAX_ATTEMPTS: '10',
  PENDING_TTL_MS: '600000',
  PENDING_BACKOFF_BASE_MS: '5000',
  PENDING_BACKOFF_MAX_MS: '60000',
  PENDING_JITTER_RATIO: '0.2',
};

const expectedMessaging = {
  sqs: {
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    transactionsQueue: 'wager-transactions.fifo',
    transactionsDlq: 'wager-transactions-dlq.fifo',
    eventsQueue: 'wager-events.fifo',
  },
  roles: { consumer: false, publisher: false, pendingWorker: false },
  consumer: {
    name: 'wager-transactions-consumer',
    waitSeconds: 20,
    visibilityTimeoutSeconds: 30,
    retryBaseSeconds: 5,
    retryMaxSeconds: 60,
    shutdownTimeoutMs: 10000,
  },
  publisher: { batchSize: 10, leaseMs: 30000, pollMs: 1000, backoffMinMs: 1000, backoffMaxMs: 60000 },
  pendingWorker: {
    batchSize: 10,
    leaseMs: 30000,
    pollMs: 1000,
    maxAttempts: 10,
    ttlMs: 600000,
    backoffBaseMs: 5000,
    backoffMaxMs: 60000,
    jitterRatio: 0.2,
  },
};

test('lê e valida as variáveis do .env.example', () => {
  const cfg = loadConfig({ ...base, ...messaging });
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
    ...expectedMessaging,
  });
});

describe('mensageria (feature 002, FR-032, R-27)', () => {
  test('sem as variáveis novas, usa os padrões do .env.example', () => {
    const cfg = loadConfig(base);
    expect(cfg).toMatchObject(expectedMessaging);
  });

  test('papéis: só "true" e "false"', () => {
    const cfg = loadConfig({ ...base, CONSUMER_ENABLED: 'true', PUBLISHER_ENABLED: 'true', PENDING_WORKER_ENABLED: 'false' });
    expect(cfg.roles).toEqual({ consumer: true, publisher: true, pendingWorker: false });
    for (const value of ['1', 'yes', 'TRUE', 'True', ' true', '']) {
      expect(() => loadConfig({ ...base, CONSUMER_ENABLED: value })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, PUBLISHER_ENABLED: value })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, PENDING_WORKER_ENABLED: value })).toThrow(ConfigError);
    }
  });

  test.each(['SQS_TRANSACTIONS_QUEUE', 'SQS_TRANSACTIONS_DLQ', 'SQS_EVENTS_QUEUE'])('%s precisa terminar em .fifo', (name) => {
    expect(() => loadConfig({ ...base, [name]: 'wager-transactions' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [name]: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [name]: 'x.fifo' })).not.toThrow();
  });

  test.each(['PUBLISHER_BATCH_SIZE', 'PENDING_WORKER_BATCH_SIZE'])('%s de 1 a 10', (name) => {
    expect(() => loadConfig({ ...base, [name]: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [name]: '11' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [name]: '1' })).not.toThrow();
    expect(() => loadConfig({ ...base, [name]: '10' })).not.toThrow();
  });

  test('PENDING_JITTER_RATIO de 0 a 0,5', () => {
    expect(loadConfig({ ...base, PENDING_JITTER_RATIO: '0' }).pendingWorker.jitterRatio).toBe(0);
    expect(loadConfig({ ...base, PENDING_JITTER_RATIO: '0.5' }).pendingWorker.jitterRatio).toBe(0.5);
    for (const value of ['0.51', '-0.1', '1', 'abc', '']) {
      expect(() => loadConfig({ ...base, PENDING_JITTER_RATIO: value })).toThrow(ConfigError);
    }
  });

  test('CONSUMER_WAIT_SECONDS de 1 a 20', () => {
    expect(() => loadConfig({ ...base, CONSUMER_WAIT_SECONDS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CONSUMER_WAIT_SECONDS: '21' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, CONSUMER_WAIT_SECONDS: '1' }).consumer.waitSeconds).toBe(1);
    expect(loadConfig({ ...base, CONSUMER_WAIT_SECONDS: '20' }).consumer.waitSeconds).toBe(20);
  });

  test('visibilidade × 1000 precisa passar de acquire + lock + 2000 (15000 com os padrões)', () => {
    expect(() => loadConfig({ ...base, CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '15' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '14' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '16' }).consumer.visibilityTimeoutSeconds).toBe(16);
    // com lock e acquire menores, a visibilidade pode ser menor (testes)
    const short = { ...base, WALLET_LOCK_TIMEOUT_MS: '1000', DB_POOL_ACQUIRE_TIMEOUT_MS: '2000' };
    expect(loadConfig({ ...short, CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '6', PUBLISHER_LEASE_MS: '6000', PENDING_WORKER_LEASE_MS: '6000' }).consumer.visibilityTimeoutSeconds).toBe(6);
    expect(() => loadConfig({ ...short, CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5' })).toThrow(ConfigError);
  });

  test.each(['PUBLISHER_LEASE_MS', 'PENDING_WORKER_LEASE_MS'])('%s precisa passar de acquire + lock + 2000', (name) => {
    expect(() => loadConfig({ ...base, [name]: '15000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [name]: '14000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [name]: '15001' })).not.toThrow();
  });

  test('CONSUMER_RETRY_BASE_SECONDS não pode passar de CONSUMER_RETRY_MAX_SECONDS', () => {
    expect(() => loadConfig({ ...base, CONSUMER_RETRY_BASE_SECONDS: '61' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CONSUMER_RETRY_BASE_SECONDS: '10', CONSUMER_RETRY_MAX_SECONDS: '5' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, CONSUMER_RETRY_BASE_SECONDS: '5', CONSUMER_RETRY_MAX_SECONDS: '5' }).consumer.retryMaxSeconds).toBe(5);
  });

  test('CONSUMER_SHUTDOWN_TIMEOUT_MS até 25000 (prazo + 5 s de margem cabem nos 30 s do stop_grace_period)', () => {
    expect(() => loadConfig({ ...base, CONSUMER_SHUTDOWN_TIMEOUT_MS: '25001' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, CONSUMER_SHUTDOWN_TIMEOUT_MS: '25000' }).consumer.shutdownTimeoutMs).toBe(25000);
  });

  test('números inválidos nas variáveis novas são recusados', () => {
    for (const name of ['PUBLISHER_POLL_MS', 'PENDING_MAX_ATTEMPTS', 'PENDING_TTL_MS', 'CONSUMER_RETRY_BASE_SECONDS']) {
      expect(() => loadConfig({ ...base, [name]: 'x' })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, [name]: '0' })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ ...base, PUBLISHER_BACKOFF_MIN_MS: '5000', PUBLISHER_BACKOFF_MAX_MS: '1000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PENDING_BACKOFF_BASE_MS: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CONSUMER_NAME: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CONSUMER_NAME: 'x'.repeat(65) })).toThrow(ConfigError);
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
